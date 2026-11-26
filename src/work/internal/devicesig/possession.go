package devicesig

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

const PossessionProofType = "possession_proof"

var (
	possessionUUIDPattern   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	possessionDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	possessionNoncePattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
)

type PossessionProof struct {
	V           int    `json:"v"`
	OrgID       string `json:"org_id"`
	SubjectID   string `json:"subject_id"`
	AuthPlane   string `json:"auth_plane"`
	AuthEpoch   string `json:"auth_epoch"`
	DeviceID    string `json:"device_id"`
	SessionID   string `json:"session_id"`
	TaskID      string `json:"task_id"`
	ArtifactID  string `json:"artifact_id"`
	VersionID   string `json:"version_id"`
	ContentHash string `json:"content_hash"`
	Purpose     string `json:"purpose"`
	RequestID   string `json:"request_id"`
	Nonce       string `json:"nonce"`
	ExpiresAt   string `json:"expires_at"`
}

func ParsePossessionProof(raw []byte) (PossessionProof, error) {
	var proof PossessionProof
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&proof); err != nil {
		return proof, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return proof, fmt.Errorf("trailing possession proof data")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return proof, err
	}
	required := []string{
		"v", "org_id", "subject_id", "auth_plane", "auth_epoch", "device_id", "session_id",
		"task_id", "artifact_id", "version_id", "content_hash", "purpose", "request_id",
		"nonce", "expires_at",
	}
	if len(object) != len(required) {
		return proof, fmt.Errorf("possession proof must carry exactly 15 keys")
	}
	for _, key := range required {
		if _, ok := object[key]; !ok {
			return proof, fmt.Errorf("possession proof missing %s", key)
		}
	}
	if proof.V != 1 || proof.OrgID == "" || proof.SubjectID == "" || proof.AuthPlane != "bearer" ||
		!canonicalUint(proof.AuthEpoch) || proof.Purpose != "accept" ||
		!possessionUUIDPattern.MatchString(proof.DeviceID) || !possessionUUIDPattern.MatchString(proof.SessionID) ||
		!possessionUUIDPattern.MatchString(proof.TaskID) || !possessionUUIDPattern.MatchString(proof.ArtifactID) ||
		!possessionUUIDPattern.MatchString(proof.VersionID) || !possessionDigestPattern.MatchString(proof.ContentHash) ||
		len(proof.RequestID) == 0 || len(proof.RequestID) > 128 ||
		strings.IndexFunc(proof.RequestID, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 ||
		!possessionNoncePattern.MatchString(proof.Nonce) {
		return proof, fmt.Errorf("invalid possession proof shape")
	}
	if _, err := time.Parse(time.RFC3339, proof.ExpiresAt); err != nil {
		return proof, fmt.Errorf("invalid possession proof expiry")
	}
	return proof, nil
}

func VerifyPossession(pub *PublicKey, proofJSON []byte, signatureB64 string) bool {
	if _, err := ParsePossessionProof(proofJSON); err != nil {
		return false
	}
	return VerifyFrame(pub, PossessionProofType, proofJSON, signatureB64)
}
