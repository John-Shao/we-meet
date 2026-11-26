package devicesig

import (
	"encoding/json"
	"testing"
)

const (
	vectorApprovalProof = `{"v":1,"org_id":"org","subject_id":"subject","auth_plane":"bearer","auth_epoch":"4","device_id":"11111111-1111-4111-8111-111111111111","session_id":"22222222-2222-4222-8222-222222222222","approval_id":"33333333-3333-4333-8333-333333333333","operation_id":"44444444-4444-4444-8444-444444444444","params_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expected_revision":"0","decision":"approved","remember_readonly":false,"readonly_scope":null,"readonly_expires_at":null,"policy_epoch":"0","access_epoch":"0","nonce":"nonce-approval-1","expires_at":"2027-01-01T00:00:00Z","signature":"pZ3THZfVcUPucJVzDulxbMSDUfJe2cdnlJjM6VAGUnW45JaMf7gz_BmvlRQ-FPMsRWPUdKvzwHjYlhct_Wmovg"}`
	vectorApprovalSig   = "pZ3THZfVcUPucJVzDulxbMSDUfJe2cdnlJjM6VAGUnW45JaMf7gz_BmvlRQ-FPMsRWPUdKvzwHjYlhct_Wmovg"
)

func TestVerifyApprovalDecisionCrossLanguage(t *testing.T) {
	pub := mustParse(t)
	proof, err := ParseApprovalDecisionProof([]byte(vectorApprovalProof))
	if err != nil {
		t.Fatal(err)
	}
	if proof.Signature != vectorApprovalSig {
		t.Fatalf("signature = %q", proof.Signature)
	}
	if !VerifyApprovalDecision(pub, []byte(vectorApprovalProof)) {
		t.Fatal("Rust approval-decision signature did not verify")
	}
}

func TestVerifyApprovalDecisionBindsEveryFieldAndType(t *testing.T) {
	pub := mustParse(t)
	for _, field := range []string{
		"v", "org_id", "subject_id", "auth_plane", "auth_epoch", "device_id", "session_id",
		"approval_id", "operation_id", "params_hash", "expected_revision", "decision",
		"remember_readonly", "readonly_scope", "readonly_expires_at", "policy_epoch",
		"access_epoch", "nonce", "expires_at",
	} {
		t.Run(field, func(t *testing.T) {
			var proof map[string]any
			if err := json.Unmarshal([]byte(vectorApprovalProof), &proof); err != nil {
				t.Fatal(err)
			}
			proof[field] = "tampered"
			raw, err := json.Marshal(proof)
			if err != nil {
				t.Fatal(err)
			}
			if VerifyFrame(pub, ApprovalDecisionProofType, raw, vectorApprovalSig) {
				t.Fatalf("tampered %s verified", field)
			}
		})
	}
	if VerifyFrame(pub, "user_version_proof", []byte(vectorApprovalProof), vectorApprovalSig) {
		t.Fatal("approval signature verified under another frame type")
	}
}
