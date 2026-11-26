package devicesig

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"time"
)

// ApprovalDecisionProofType is the independent signing domain for a local approval decision.
const ApprovalDecisionProofType = "approval_decision_proof"

var (
	approvalDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	approvalNoncePattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
	approvalSigPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{86}$`)
	approvalUUIDPattern   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type ApprovalReadonlyScope struct {
	ToolSet              []string `json:"tool_set"`
	ResourceSelectorHash string   `json:"resource_selector_hash"`
	GrantID              string   `json:"grant_id"`
	GrantRevision        string   `json:"grant_revision"`
}

type ApprovalDecisionProof struct {
	V                 int                    `json:"v"`
	OrgID             string                 `json:"org_id"`
	SubjectID         string                 `json:"subject_id"`
	AuthPlane         string                 `json:"auth_plane"`
	AuthEpoch         string                 `json:"auth_epoch"`
	DeviceID          string                 `json:"device_id"`
	SessionID         string                 `json:"session_id"`
	ApprovalID        string                 `json:"approval_id"`
	OperationID       string                 `json:"operation_id"`
	ParamsHash        string                 `json:"params_hash"`
	ExpectedRevision  string                 `json:"expected_revision"`
	Decision          string                 `json:"decision"`
	RememberReadonly  bool                   `json:"remember_readonly"`
	ReadonlyScope     *ApprovalReadonlyScope `json:"readonly_scope"`
	ReadonlyExpiresAt *string                `json:"readonly_expires_at"`
	PolicyEpoch       string                 `json:"policy_epoch"`
	AccessEpoch       string                 `json:"access_epoch"`
	Nonce             string                 `json:"nonce"`
	ExpiresAt         string                 `json:"expires_at"`
	Signature         string                 `json:"signature"`
}

func ParseApprovalDecisionProof(raw []byte) (ApprovalDecisionProof, error) {
	var proof ApprovalDecisionProof
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&proof); err != nil {
		return proof, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return proof, fmt.Errorf("trailing approval proof data")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return proof, err
	}
	required := []string{
		"v", "org_id", "subject_id", "auth_plane", "auth_epoch", "device_id", "session_id",
		"approval_id", "operation_id", "params_hash", "expected_revision", "decision",
		"remember_readonly", "readonly_scope", "readonly_expires_at", "policy_epoch",
		"access_epoch", "nonce", "expires_at", "signature",
	}
	if len(object) != len(required) {
		return proof, fmt.Errorf("approval proof must carry exactly 20 keys")
	}
	for _, key := range required {
		if _, ok := object[key]; !ok {
			return proof, fmt.Errorf("approval proof missing %s", key)
		}
	}
	if proof.V != 1 || proof.OrgID == "" || proof.SubjectID == "" || proof.AuthPlane != "bearer" ||
		!approvalUUIDPattern.MatchString(proof.DeviceID) || !approvalUUIDPattern.MatchString(proof.SessionID) ||
		!approvalUUIDPattern.MatchString(proof.ApprovalID) || !approvalUUIDPattern.MatchString(proof.OperationID) ||
		!approvalDigestPattern.MatchString(proof.ParamsHash) ||
		!canonicalUint(proof.ExpectedRevision) || !canonicalUint(proof.AuthEpoch) ||
		!canonicalUint(proof.PolicyEpoch) || !canonicalUint(proof.AccessEpoch) ||
		(proof.Decision != "approved" && proof.Decision != "rejected") ||
		!approvalNoncePattern.MatchString(proof.Nonce) || !approvalSigPattern.MatchString(proof.Signature) {
		return proof, fmt.Errorf("invalid approval proof shape")
	}
	if _, err := time.Parse(time.RFC3339, proof.ExpiresAt); err != nil {
		return proof, fmt.Errorf("invalid approval proof expiry")
	}
	if proof.Decision == "rejected" && proof.RememberReadonly {
		return proof, fmt.Errorf("rejected approval cannot remember readonly access")
	}
	if !proof.RememberReadonly {
		if proof.ReadonlyScope != nil || proof.ReadonlyExpiresAt != nil {
			return proof, fmt.Errorf("unremembered approval cannot carry readonly scope")
		}
		return proof, nil
	}
	if proof.ReadonlyScope == nil || proof.ReadonlyExpiresAt == nil || len(proof.ReadonlyScope.ToolSet) == 0 {
		return proof, fmt.Errorf("remembered approval requires readonly scope")
	}
	if _, err := time.Parse(time.RFC3339, *proof.ReadonlyExpiresAt); err != nil {
		return proof, fmt.Errorf("invalid readonly expiry")
	}
	if !approvalUUIDPattern.MatchString(proof.ReadonlyScope.GrantID) ||
		!approvalDigestPattern.MatchString(proof.ReadonlyScope.ResourceSelectorHash) ||
		!canonicalUint(proof.ReadonlyScope.GrantRevision) {
		return proof, fmt.Errorf("invalid readonly scope")
	}
	for _, tool := range proof.ReadonlyScope.ToolSet {
		if tool != "workspace.list" && tool != "workspace.read" && tool != "workspace.search" {
			return proof, fmt.Errorf("readonly scope contains non-readonly tool")
		}
	}
	return proof, nil
}

func VerifyApprovalDecision(pub *PublicKey, proofJSON []byte) bool {
	proof, err := ParseApprovalDecisionProof(proofJSON)
	if err != nil {
		return false
	}
	return VerifyFrame(pub, ApprovalDecisionProofType, proofJSON, proof.Signature)
}

func canonicalUint(value string) bool {
	parsed, err := strconv.ParseUint(value, 10, 63)
	return err == nil && strconv.FormatUint(parsed, 10) == value
}
