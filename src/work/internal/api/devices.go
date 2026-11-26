package api

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/host"
)

// The device-identity face (control-design §1.4 rows 60-63, device-design §2.1).
// Every path is under /work/v2 and every handler authenticates the desktop Bearer
// plane, never the cookie plane: pair_device et al. require auth_plane='bearer'
// and bind the device to the bearer auth epoch, so a cookie session must not be
// able to reach them. The SQL owns the closed sets, idempotency, lock order and
// cross-plane checks; the handlers enforce the key set and transport bounds only.
const (
	DevicesPath                   = "/work/v2/devices"
	DevicePairingsPath            = "/work/v2/devices/pairings"
	DevicePairingConfirmPath      = "/work/v2/devices/pairings/{pairingId}/confirm"
	DeviceSessionTicketsPath      = "/work/v2/devices/{deviceId}/session-tickets"
	DeviceCertificateRenewalsPath = "/work/v2/devices/{deviceId}/certificate-renewals"
	// The renewal challenge is a device_pairing row with purpose='renew', so its
	// confirm face mirrors the pairing confirm path. control-design §1.4 declares the
	// challenge request but not this second step; GW20 adds it and registers it as a
	// new public entry (a J39 surface) rather than widening the shipped pairing path.
	DeviceCertificateRenewalConfirmPath = "/work/v2/devices/certificate-renewals/{pairingId}/confirm"
	DeviceRevokePath                    = "/work/v2/devices/{deviceId}/revoke"
	// The shell's signing preimage needs org_id/subject_id (device-design §2.1 step 3),
	// and the Bearer plane had no face that returns them: subject is the OIDC sub the
	// shell already holds, but org_id is the Host's caller organization, which only the
	// verified claims carry. M2 ruling 乙 adds this read-only identity face rather than
	// widening the frozen pairing response. It is a new public entry (a J39 surface).
	// The proof faces also bind auth_plane/auth_epoch (control-design §1.2), and the
	// device session's epoch is server-side only, so the same face returns the caller's
	// verified plane and session revision — the epoch the shell must sign, never its
	// local login generation.
	DeviceIdentityPath = "/work/v2/identity"
)

type devicePairingRequest struct {
	ClientRequestID string          `json:"client_request_id"`
	DeviceName      string          `json:"device_name"`
	Platform        string          `json:"platform"`
	PublicKeyJWK    json.RawMessage `json:"public_key_jwk"`
}

type devicePairingConfirmRequest struct {
	ClientRequestID string `json:"client_request_id"`
	Challenge       string `json:"challenge"`
	Signature       string `json:"signature"`
}

type deviceSessionTicketRequest struct {
	ClientRequestID     string `json:"client_request_id"`
	PublicKeyThumbprint string `json:"public_key_thumbprint"`
}

type deviceCertificateRenewalRequest struct {
	ClientRequestID string `json:"client_request_id"`
}

type deviceRevokeRequest struct {
	ClientRequestID string `json:"client_request_id"`
	Reason          string `json:"reason"`
}

// jwkArg renders an optional JWK body as a jsonb argument: an omitted key reaches
// SQL as null (which device_pubkey_valid refuses) rather than as an empty string
// that would fail to cast.
func jwkArg(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "null"
	}
	return string(raw)
}

func (s *Server) createDevicePairing(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	var body devicePairingRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.pair_device($1, $2, 'bearer', $3, $4, $5, $6, $7::jsonb)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision,
				body.ClientRequestID, body.DeviceName, body.Platform, jwkArg(body.PublicKeyJWK),
			).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) confirmDevicePairing(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	pairingID := r.PathValue("pairingId")
	if !validUUID(pairingID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body devicePairingConfirmRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !s.requireDeviceCA(w, correlationID) {
		return
	}
	// Verify the device's real ES256 signature over the pairing covered string
	// BEFORE the domain command: SQL only shape-checks and binds the signature
	// (0040:1135); the Go layer owns the cryptography (P0 #1). The public key comes
	// from the database via the definer getter, never the request body (m1a §12).
	var pubJWK []byte
	if err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(),
				`SELECT work.device_pairing_signing_key($1, $2, $3::uuid)`,
				claims.OrgID, claims.SubjectID, pairingID,
			).Scan(&pubJWK)
		},
	); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	pub, parseErr := devicesig.ParseJWK(pubJWK)
	if parseErr != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if !devicesig.VerifyPairing(pub, pairingID, body.Challenge, claims.OrgID, claims.SubjectID, body.Signature) {
		writeAPIError(w, correlationID, apierr.New("unauthorized"))
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.confirm_device_pairing($1, $2, 'bearer', $3, $4::uuid, $5, $6, $7)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision, pairingID,
				body.ClientRequestID, body.Challenge, body.Signature,
			).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	// §4.3: the CA signs OUTSIDE the transaction that just activated the device, and
	// record_device_certificate is the second call 0040:1374-1377 promised. A replayed
	// confirm returns the stored null triple, so issuance runs on every path and the
	// record command's own audit replay hands back the SAME certificate the row holds.
	var confirmed map[string]any
	if err := json.Unmarshal(view, &confirmed); err != nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	deviceID, _ := confirmed["device_id"].(string)
	recorded, err := s.issueAndRecordDeviceCert(r.Context(), claims, deviceID, pairingID,
		body.ClientRequestID, pub)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	recorded["replayed"] = confirmed["replayed"]
	writeJSON(w, http.StatusOK, recorded)
}

func (s *Server) mintDeviceSessionTicket(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	deviceID := r.PathValue("deviceId")
	if !validUUID(deviceID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body deviceSessionTicketRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.mint_device_session_ticket($1, $2, 'bearer', $3, $4::uuid, $5, $6)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision, deviceID,
				body.ClientRequestID, body.PublicKeyThumbprint,
			).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) renewDeviceCertificate(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	deviceID := r.PathValue("deviceId")
	if !validUUID(deviceID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body deviceCertificateRenewalRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !s.requireDeviceCA(w, correlationID) {
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.renew_device_certificate($1, $2, 'bearer', $3, $4::uuid, $5)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision, deviceID,
				body.ClientRequestID,
			).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	cursor := r.URL.Query().Get("cursor")
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			writeAPIError(w, correlationID, apierr.New("invalid_pagination"))
			return
		}
		limit = parsed
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.list_devices($1, $2, $3, $4)`,
				claims.OrgID, claims.SubjectID, cursor, limit,
			).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	deviceID := r.PathValue("deviceId")
	if !validUUID(deviceID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body deviceRevokeRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.revoke_device($1, $2, $3::uuid, $4, $5)`,
				claims.OrgID, claims.SubjectID, deviceID, body.ClientRequestID, body.Reason,
			).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// deviceIdentity returns the verified Bearer claims' (org, subject) pair and nothing else.
// The shell needs both to build the §2.1 signing preimage it hands to the Broker; the values
// come straight from the Host-verified claims, never from a request body or a second lookup,
// so this face cannot disagree with the identity the domain commands bind. No database work:
// the claims are the authority, and a read that re-queried could race a membership change.
func (s *Server) deviceIdentity(w http.ResponseWriter, r *http.Request) {
	claims, _, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"org_id":     claims.OrgID,
		"subject_id": claims.SubjectID,
		"auth_plane": "bearer",
		"auth_epoch": strconv.FormatInt(claims.SessionRevision, 10),
	})
}

// confirmDeviceCertificateRenewal consumes the purpose='renew' challenge and issues the
// replacement certificate. It is the pairing confirm face's sibling with three
// differences: the key comes from device_renewal_signing_key, the signature domain is
// work-device-cert-renew-v2 (§2.1 forbids reusing a domain across pairing and renewal),
// and the device is already active, so nothing is activated here. The request body is
// the same three fields the pairing confirm takes.
func (s *Server) confirmDeviceCertificateRenewal(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	pairingID := r.PathValue("pairingId")
	if !validUUID(pairingID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body devicePairingConfirmRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !s.requireDeviceCA(w, correlationID) {
		return
	}
	var pubJWK []byte
	if err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(),
				`SELECT work.device_renewal_signing_key($1, $2, $3::uuid)`,
				claims.OrgID, claims.SubjectID, pairingID,
			).Scan(&pubJWK)
		},
	); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	pub, parseErr := devicesig.ParseJWK(pubJWK)
	if parseErr != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if !devicesig.VerifyCertRenewal(pub, pairingID, body.Challenge, claims.OrgID, claims.SubjectID, body.Signature) {
		writeAPIError(w, correlationID, apierr.New("unauthorized"))
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.confirm_device_certificate_renewal($1, $2, 'bearer', $3, $4::uuid, $5, $6, $7)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision, pairingID,
				body.ClientRequestID, body.Challenge, body.Signature,
			).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	var confirmed map[string]any
	if err := json.Unmarshal(view, &confirmed); err != nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	deviceID, _ := confirmed["device_id"].(string)
	recorded, err := s.issueAndRecordDeviceCert(r.Context(), claims, deviceID, pairingID,
		body.ClientRequestID, pub)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	recorded["replayed"] = confirmed["replayed"]
	writeJSON(w, http.StatusOK, recorded)
}

// requireDeviceCA refuses the certificate face before any database work when no CA is
// configured. The refusal has to precede the activation, not follow it: a device that is
// active without a certificate cannot connect (mTLS needs the cert) and cannot be
// re-paired (pair_device refuses a key that already has a live device), so activating
// first would leave a row only an operator revoke can clear.
func (s *Server) requireDeviceCA(w http.ResponseWriter, correlationID string) bool {
	if s.deviceCA == nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return false
	}
	return true
}

// issueAndRecordDeviceCert signs the clientAuth certificate with the configured CA and
// records it through the landed domain command. Signing stays outside every transaction
// (§4.3), and the record is a SEPARATE call because device_guard only accepts a
// certificate write on a row that is already active — the activating UPDATE cannot carry
// it. The PEM chain (leaf first, then the CA) is what the device installs; the serial and
// expiry are the two facts work.device records.
func (s *Server) issueAndRecordDeviceCert(ctx context.Context, claims host.Claims, deviceID, pairingID, confirmRequestID string, pub *devicesig.PublicKey) (map[string]any, error) {
	chain, err := s.deviceCA.IssueDeviceCert(deviceID, claims.OrgID, pub.Key)
	if err != nil {
		return nil, &domainError{code: "service_degraded"}
	}
	leaf, err := x509.ParseCertificate(chain.Certificate[0])
	if err != nil {
		return nil, &domainError{code: "service_degraded"}
	}
	var pemChain []byte
	for _, der := range chain.Certificate {
		pemChain = append(pemChain, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)
	}
	var raw []byte
	err = workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			return tx.QueryRow(ctx,
				`SELECT work.record_device_certificate($1, $2, 'bearer', $3, $4::uuid, $5::uuid, $6, $7, $8, $9)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision, deviceID, pairingID,
				confirmRequestID+"|cert", leaf.SerialNumber.String(), leaf.NotAfter, string(pemChain),
			).Scan(&raw)
		},
	)
	if err != nil {
		return nil, err
	}
	var recorded map[string]any
	if err := json.Unmarshal(raw, &recorded); err != nil {
		return nil, &domainError{code: "service_degraded"}
	}
	return recorded, nil
}
