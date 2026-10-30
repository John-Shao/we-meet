package fragment_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/we-meet/work/internal/fragment"
)

// goldenRequest is the exact execute fragment the Go control plane will send.
// The Node runtime validates this same file, so a field rename on either side
// fails a test instead of a production run.
func goldenRequest() fragment.Request {
	return fragment.Request{
		Kind: fragment.KindRequest, Contract: fragment.ContractVersion,
		ExecutionID:    "11111111-1111-4111-8111-111111111111",
		RunID:          "22222222-2222-4222-8222-222222222222",
		TaskID:         "33333333-3333-4333-8333-333333333333",
		OrgID:          "org_golden",
		SnapshotID:     "44444444-4444-4444-8444-444444444444",
		RuntimeVersion: "work-runtime-1.4.0",
		Fence:          "7",
		DeadlineUnixMs: 1_800_000_000_000,
		Mode:           "execute",
		Checkpoint: &fragment.Reference{
			RefID: "55555555-5555-4555-8555-555555555555",
			Hash:  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
		Intent: &fragment.Intent{
			Request: fragment.Reference{
				RefID: "66666666-6666-4666-8666-666666666666",
				Hash:  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			},
			RequestHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			LogicalKey:  "model:2",
		},
		Permit: &fragment.Permit{
			OperationID:       "77777777-7777-4777-8777-777777777777",
			DispatchAttemptID: "88888888-8888-4888-8888-888888888888",
			RequestHash:       "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		},
	}
}

func TestGoldenExecuteFragmentMatchesSharedFixture(t *testing.T) {
	body, err := json.MarshalIndent(goldenRequest(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, '\n')
	path := filepath.Join("..", "..", "contracts", "advance-request.execute.json")
	if os.Getenv("WORK_UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	expected, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	if string(expected) != string(body) {
		t.Fatalf("shared fixture drifted from the Go wire shape; rerun with WORK_UPDATE_GOLDEN=1 only for an intended change")
	}
	if err := goldenRequest().Validate(); err != nil {
		t.Fatalf("golden request does not validate: %v", err)
	}
}
