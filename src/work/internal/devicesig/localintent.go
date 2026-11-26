package devicesig

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// LocalIntentProofType is the independent signing domain for a local Task submission.
const LocalIntentProofType = "local_intent"

var (
	localIntentDigestPattern  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	localIntentPreviewPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
	localIntentExpiryPattern  = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$`)
	localIntentNoncePattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
	localIntentSigPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{86}$`)
	localIntentUUIDPattern    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// LocalIntentProof is the closed 19-key device signature carried by SubmitRequest.
type LocalIntentProof struct {
	V                   int      `json:"v"`
	OrgID               string   `json:"org_id"`
	SubjectID           string   `json:"subject_id"`
	AuthPlane           string   `json:"auth_plane"`
	AuthEpoch           string   `json:"auth_epoch"`
	DeviceID            string   `json:"device_id"`
	SessionID           string   `json:"session_id"`
	RequestID           string   `json:"request_id"`
	InputHash           string   `json:"input_hash"`
	PreviewHash         string   `json:"preview_hash"`
	TargetSelectionHash string   `json:"target_selection_hash"`
	SelectedGrantIDs    []string `json:"selected_grant_ids"`
	GrantRevisions      []string `json:"grant_revisions"`
	ProfileID           string   `json:"profile_id"`
	ProfileRevision     string   `json:"profile_revision"`
	ProfileHash         string   `json:"profile_hash"`
	Nonce               string   `json:"nonce"`
	ExpiresAt           string   `json:"expires_at"`
	Signature           string   `json:"signature"`
}

func ParseLocalIntentProof(raw []byte) (LocalIntentProof, error) {
	var proof LocalIntentProof
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&proof); err != nil {
		return proof, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return proof, fmt.Errorf("trailing local intent data")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return proof, err
	}
	required := []string{
		"v", "org_id", "subject_id", "auth_plane", "auth_epoch", "device_id", "session_id",
		"request_id", "input_hash", "preview_hash", "target_selection_hash", "selected_grant_ids",
		"grant_revisions", "profile_id", "profile_revision", "profile_hash", "nonce", "expires_at",
		"signature",
	}
	if len(object) != len(required) {
		return proof, fmt.Errorf("local intent must carry exactly 19 keys")
	}
	for _, key := range required {
		if _, ok := object[key]; !ok {
			return proof, fmt.Errorf("local intent missing %s", key)
		}
	}
	if proof.V != 1 || !validLocalIntentText(proof.OrgID, 256) ||
		!validLocalIntentText(proof.SubjectID, 256) || proof.AuthPlane != "bearer" ||
		!localIntentUUIDPattern.MatchString(proof.DeviceID) ||
		!localIntentUUIDPattern.MatchString(proof.SessionID) ||
		!validLocalIntentRequestID(proof.RequestID) ||
		!localIntentDigestPattern.MatchString(proof.InputHash) ||
		!localIntentPreviewPattern.MatchString(proof.PreviewHash) || len(proof.PreviewHash) > 4096 ||
		!localIntentDigestPattern.MatchString(proof.TargetSelectionHash) ||
		!validLocalIntentText(proof.ProfileID, 128) ||
		!canonicalUint(proof.ProfileRevision) ||
		!localIntentDigestPattern.MatchString(proof.ProfileHash) ||
		!canonicalUint(proof.AuthEpoch) || !localIntentNoncePattern.MatchString(proof.Nonce) ||
		!localIntentSigPattern.MatchString(proof.Signature) {
		return proof, fmt.Errorf("invalid local intent shape")
	}
	if !localIntentExpiryPattern.MatchString(proof.ExpiresAt) {
		return proof, fmt.Errorf("invalid local intent expiry")
	}
	if _, err := time.Parse(time.RFC3339, proof.ExpiresAt); err != nil {
		return proof, fmt.Errorf("invalid local intent expiry")
	}
	if len(proof.SelectedGrantIDs) < 1 || len(proof.SelectedGrantIDs) > 4 ||
		len(proof.SelectedGrantIDs) != len(proof.GrantRevisions) {
		return proof, fmt.Errorf("invalid local intent grant set")
	}
	seen := make(map[string]struct{}, len(proof.SelectedGrantIDs))
	for i, grantID := range proof.SelectedGrantIDs {
		if !localIntentUUIDPattern.MatchString(grantID) || !canonicalUint(proof.GrantRevisions[i]) {
			return proof, fmt.Errorf("invalid local intent grant")
		}
		if _, duplicate := seen[grantID]; duplicate {
			return proof, fmt.Errorf("duplicate local intent grant")
		}
		seen[grantID] = struct{}{}
	}
	return proof, nil
}

func VerifyLocalIntent(pub *PublicKey, proofJSON []byte) bool {
	proof, err := ParseLocalIntentProof(proofJSON)
	if err != nil {
		return false
	}
	return VerifyFrame(pub, LocalIntentProofType, proofJSON, proof.Signature)
}

func validLocalIntentText(value string, max int) bool {
	if value == "" || len(value) > max {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func validLocalIntentRequestID(value string) bool {
	return len(value) >= 8 && len(value) <= 128 && strings.TrimSpace(value) == value &&
		validLocalIntentText(value, 128)
}
