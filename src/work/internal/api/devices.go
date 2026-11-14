package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
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
	DeviceRevokePath              = "/work/v2/devices/{deviceId}/revoke"
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
	writeJSON(w, http.StatusOK, view)
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