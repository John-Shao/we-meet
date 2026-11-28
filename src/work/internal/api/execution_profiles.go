package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/devicesig"
)

const (
	ExecutionProfilePath            = "/work/v2/execution-profiles/{profileId}/revisions/{revision}"
	AdminExecutionProfilesPath      = "/work/v2/admin/execution-profiles"
	DeviceModelBindingsPath         = "/work/v2/devices/{deviceId}/model-bindings"
	DeviceModelBindingProbesPath    = "/work/v2/devices/{deviceId}/model-bindings/{bindingId}/probes"
	DeviceModelBindingProbeRunsPath = "/work/v2/devices/{deviceId}/model-bindings/{bindingId}/probe-runs"
	DeviceModelProbePreviewsPath    = "/work/v2/devices/{deviceId}/model-bindings/{bindingId}/probe-previews"
	DeviceModelProbePath            = "/work/v2/devices/{deviceId}/model-probes/{probeId}"
	modelProbeReceiptNoncePattern   = `^[A-Za-z0-9_-]{8,128}$`
)

var configurationProbeTemplateHash = fmt.Sprintf("%x", sha256.Sum256([]byte("device-model-probe-v1")))

var modelProbeReceiptNonceRE = regexp.MustCompile(modelProbeReceiptNoncePattern)

type publishExecutionProfileRequest struct {
	ClientRequestID string          `json:"client_request_id"`
	Profile         json.RawMessage `json:"profile"`
}

type createDeviceModelBindingRequest struct {
	ClientRequestID         string          `json:"client_request_id"`
	SessionID               string          `json:"session_id"`
	ProfileID               string          `json:"profile_id"`
	ProfileRevision         string          `json:"profile_revision"`
	ProfileHash             string          `json:"profile_hash"`
	BindingHash             string          `json:"binding_hash"`
	LocalRef                string          `json:"local_ref"`
	ListenerIdentityHash    string          `json:"listener_identity_hash"`
	NativeConfirmationProof json.RawMessage `json:"native_confirmation_proof"`
}

type refreshDeviceModelProbePreviewRequest struct {
	ClientRequestID string `json:"client_request_id"`
	SessionID       string `json:"session_id"`
	Revision        string `json:"revision"`
}

type recordModelProfileProbeRequest struct {
	ClientRequestID string          `json:"client_request_id"`
	SessionID       string          `json:"session_id"`
	ProbeID         string          `json:"probe_id"`
	PreviewHash     string          `json:"preview_hash"`
	ReceiptHash     string          `json:"receipt_hash"`
	ReceiptRef      string          `json:"receipt_ref"`
	State           string          `json:"state"`
	Receipt         json.RawMessage `json:"receipt"`
}

type submitConfigurationProbeRequest struct {
	ClientRequestID     string          `json:"client_request_id"`
	SessionID           string          `json:"session_id"`
	ProbeID             string          `json:"probe_id"`
	PreviewHash         string          `json:"preview_hash"`
	TargetSelectionHash string          `json:"target_selection_hash"`
	LocalIntent         json.RawMessage `json:"local_intent"`
}

// modelProbeReceipt is the closed document signed by the current device key. The signature is
// carried in X-Device-Signature and is never a field of this document.
type modelProbeReceipt struct {
	V           json.RawMessage `json:"v"`
	OrgID       string          `json:"org_id"`
	SubjectID   string          `json:"subject_id"`
	AuthEpoch   string          `json:"auth_epoch"`
	DeviceID    string          `json:"device_id"`
	SessionID   string          `json:"session_id"`
	BindingID   string          `json:"binding_id"`
	ProbeID     string          `json:"probe_id"`
	PreviewHash string          `json:"preview_hash"`
	ReceiptHash string          `json:"receipt_hash"`
	ReceiptRef  string          `json:"receipt_ref"`
	State       string          `json:"state"`
	Nonce       string          `json:"nonce"`
	ExpiresAt   string          `json:"expires_at"`
}

func (s *Server) getExecutionProfile(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	profileID := r.PathValue("profileId")
	if profileID == "" || len(profileID) > 128 || strings.TrimSpace(profileID) != profileID {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	revision, err := strconv.ParseInt(r.PathValue("revision"), 10, 64)
	if err != nil || revision < 1 {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var view json.RawMessage
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.get_execution_profile($1, $2, $3::bigint)`,
				claims.OrgID, profileID, revision).Scan(&raw); err != nil {
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

func (s *Server) adminPublishExecutionProfile(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	var body publishExecutionProfileRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !validClientRequestID(body.ClientRequestID) || len(body.Profile) == 0 || !json.Valid(body.Profile) {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.publish_execution_profile($1, $2, $3, $4::jsonb)`,
				claims.OrgID, claims.SubjectID, body.ClientRequestID, string(body.Profile)).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) createDeviceModelBinding(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	if err := s.requireWriter(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	deviceID := r.PathValue("deviceId")
	if !validUUID(deviceID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body createDeviceModelBindingRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !validClientRequestID(body.ClientRequestID) || !validUUID(body.SessionID) ||
		body.ProfileID == "" || len(body.ProfileID) > 128 || strings.TrimSpace(body.ProfileID) != body.ProfileID ||
		!localPreviewUintPattern.MatchString(body.ProfileRevision) ||
		!localPreviewDigestPattern.MatchString(body.ProfileHash) ||
		!localPreviewDigestPattern.MatchString(body.BindingHash) ||
		body.LocalRef == "" || len(body.LocalRef) > 512 ||
		!localPreviewDigestPattern.MatchString(body.ListenerIdentityHash) ||
		len(body.NativeConfirmationProof) == 0 || !json.Valid(body.NativeConfirmationProof) {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	signature := strings.TrimSpace(r.Header.Get("X-Device-Signature"))
	if signature == "" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	pub, err := s.loadDevicePublicKeyForClaims(r.Context(), claims.OrgID, claims.SubjectID, deviceID)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	if !devicesig.VerifyFrame(pub, "model_binding", body.NativeConfirmationProof, signature) {
		writeAPIError(w, correlationID, apierr.New("unauthorized"))
		return
	}
	revision, err := strconv.ParseInt(body.ProfileRevision, 10, 64)
	if err != nil || revision < 1 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	var view json.RawMessage
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(), `
				SELECT work.create_device_model_binding(
				  $1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8::bigint, $9, $10, $11, $12, $13::jsonb)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision,
				deviceID, body.SessionID, body.ClientRequestID, body.ProfileID,
				revision, body.ProfileHash, body.BindingHash, body.LocalRef,
				body.ListenerIdentityHash, string(body.NativeConfirmationProof)).Scan(&raw); err != nil {
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

func (s *Server) getDeviceModelProbe(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	if err := s.requireWriter(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	deviceID := r.PathValue("deviceId")
	probeID := r.PathValue("probeId")
	if !validUUID(deviceID) || !validUUID(probeID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(), `
				SELECT work.get_device_model_probe($1, $2, $3::uuid, $4::uuid)`,
				claims.OrgID, claims.SubjectID, deviceID, probeID).Scan(&raw); err != nil {
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

func (s *Server) refreshDeviceModelProbePreview(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	if err := s.requireWriter(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	deviceID := r.PathValue("deviceId")
	bindingID := r.PathValue("bindingId")
	if !validUUID(deviceID) || !validUUID(bindingID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body refreshDeviceModelProbePreviewRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !validClientRequestID(body.ClientRequestID) || !validUUID(body.SessionID) ||
		!localPreviewUintPattern.MatchString(body.Revision) {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	revision, err := strconv.ParseInt(body.Revision, 10, 64)
	if err != nil || revision < 1 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	var view json.RawMessage
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(), `
				SELECT work.refresh_device_model_probe_preview(
				  $1, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8::bigint)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision,
				deviceID, body.SessionID, bindingID, body.ClientRequestID, revision).Scan(&raw); err != nil {
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

func (s *Server) submitConfigurationProbe(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	if err := s.requireWriter(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	deviceID := r.PathValue("deviceId")
	bindingID := r.PathValue("bindingId")
	if !validUUID(deviceID) || !validUUID(bindingID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body submitConfigurationProbeRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !validClientRequestID(body.ClientRequestID) || !validUUID(body.SessionID) ||
		!validUUID(body.ProbeID) || !localPreviewDigestPattern.MatchString(body.PreviewHash) ||
		!localPreviewDigestPattern.MatchString(body.TargetSelectionHash) ||
		len(body.LocalIntent) == 0 || !json.Valid(body.LocalIntent) {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	proof, err := devicesig.ParseConfigurationProbeIntentProof(body.LocalIntent)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if proof.OrgID != claims.OrgID || proof.SubjectID != claims.SubjectID ||
		proof.AuthEpoch != strconv.FormatInt(claims.SessionRevision, 10) ||
		proof.DeviceID != deviceID || proof.SessionID != body.SessionID ||
		proof.RequestID != body.ClientRequestID || proof.InputHash != configurationProbeTemplateHash ||
		proof.PreviewHash != body.PreviewHash || proof.TargetSelectionHash != body.TargetSelectionHash {
		writeAPIError(w, correlationID, apierr.New("unauthorized"))
		return
	}
	pub, err := s.loadDevicePublicKeyForClaims(r.Context(), claims.OrgID, claims.SubjectID, deviceID)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	if !devicesig.VerifyConfigurationProbeIntent(pub, body.LocalIntent) {
		writeAPIError(w, correlationID, apierr.New("unauthorized"))
		return
	}
	var view json.RawMessage
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(), `
				SELECT jsonb_build_object(
				  'task_id', task_id, 'run_id', run_id, 'revision', revision,
				  'binding_revision', binding_revision, 'task_kind', 'configuration_probe',
				  'probe_id', $8, 'binding_id', $7, 'state', 'running')
				FROM work.submit_configuration_probe(
				  $1, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, $10, $11::jsonb)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision, body.ClientRequestID,
				deviceID, body.SessionID, bindingID, body.ProbeID, body.PreviewHash,
				body.TargetSelectionHash, string(body.LocalIntent)).Scan(&raw); err != nil {
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
	writeJSON(w, http.StatusAccepted, view)
}

func (s *Server) recordModelProfileProbe(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	if err := s.requireWriter(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	deviceID := r.PathValue("deviceId")
	bindingID := r.PathValue("bindingId")
	if !validUUID(deviceID) || !validUUID(bindingID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body recordModelProfileProbeRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !validClientRequestID(body.ClientRequestID) || !validUUID(body.SessionID) ||
		!validUUID(body.ProbeID) || !localPreviewDigestPattern.MatchString(body.PreviewHash) ||
		body.State == "" || len(body.ReceiptRef) > 512 ||
		(body.ReceiptHash != "" && !localPreviewDigestPattern.MatchString(body.ReceiptHash)) ||
		len(body.Receipt) == 0 || !json.Valid(body.Receipt) {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	signature := strings.TrimSpace(r.Header.Get("X-Device-Signature"))
	if signature == "" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	pub, err := s.loadDevicePublicKeyForClaims(r.Context(), claims.OrgID, claims.SubjectID, deviceID)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	// The device signature is verified before the domain command. SQL receives only the
	// receipt facts; this handler owns the closed receipt document and its principal binding.
	if !devicesig.VerifyFrame(pub, "model_probe", body.Receipt, signature) {
		writeAPIError(w, correlationID, apierr.New("unauthorized"))
		return
	}
	receipt, err := parseModelProbeReceipt(body.Receipt)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	now := time.Now()
	expiresAt, err := time.Parse(time.RFC3339, receipt.ExpiresAt)
	if err != nil || !expiresAt.After(now) || expiresAt.After(now.Add(65*time.Second)) ||
		!modelProbeReceiptVersionOne(receipt.V) || receipt.OrgID != claims.OrgID || receipt.SubjectID != claims.SubjectID ||
		receipt.AuthEpoch != strconv.FormatInt(claims.SessionRevision, 10) ||
		receipt.DeviceID != deviceID || receipt.SessionID != body.SessionID ||
		receipt.BindingID != bindingID || receipt.ProbeID != body.ProbeID ||
		receipt.PreviewHash != body.PreviewHash ||
		receipt.ReceiptHash != body.ReceiptHash || receipt.ReceiptRef != body.ReceiptRef ||
		receipt.State != body.State || !modelProbeReceiptNonceRE.MatchString(receipt.Nonce) {
		writeAPIError(w, correlationID, apierr.New("unauthorized"))
		return
	}
	if body.State != "running" && body.State != "verified" && body.State != "failed" && body.State != "reconcile" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if body.State == "verified" && (body.ReceiptHash == "" || body.ReceiptRef == "") {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if (body.State == "failed" || body.State == "reconcile") && body.ReceiptRef == "" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	var view json.RawMessage
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(), `
				SELECT work.record_execution_profile_probe(
				  $1, $2, $3, $4::uuid, $5::uuid, $6, $7::uuid, $8, $9, $10, $11)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision,
				deviceID, body.SessionID, body.ClientRequestID, body.ProbeID,
				body.PreviewHash, body.ReceiptHash, body.ReceiptRef, body.State).Scan(&raw); err != nil {
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

func (s *Server) loadDevicePublicKeyForClaims(ctx context.Context, orgID, subjectID, deviceID string) (*devicesig.PublicKey, error) {
	var raw []byte
	if err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: orgID, SubjectID: subjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT work.device_signing_key($1, $2::uuid)`, orgID, deviceID).Scan(&raw)
		},
	); err != nil {
		return nil, err
	}
	return devicesig.ParseJWK(raw)
}

func modelProbeReceiptVersionOne(raw json.RawMessage) bool {
	return string(raw) == "1" || string(raw) == `"1"`
}

func parseModelProbeReceipt(raw json.RawMessage) (modelProbeReceipt, error) {
	var receipt modelProbeReceipt
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		return receipt, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return receipt, fmt.Errorf("trailing receipt data")
	}
	return receipt, nil
}
