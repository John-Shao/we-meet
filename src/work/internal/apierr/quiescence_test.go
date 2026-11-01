package apierr

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"

	"testing"
)

func pgConflict(message string) error {
	return &pgconn.PgError{Code: "P0001", Message: message}
}

// TestQuiescenceStaysConflictWithoutDetail locks the defect that a busy task was
// reported as 503: the quiescence families raise no numeric DETAIL, so requiring
// one degraded every legitimate 409 into service_degraded.
func TestQuiescenceStaysConflictWithoutDetail(t *testing.T) {
	quiescent := []string{
		"run_not_quiescent",
		"run_not_quiescent_or_revision_conflict",
		"task_has_unresolved_operation",
		"run_has_unresolved_operation",
		"latest_run_not_terminal",
	}
	for _, raised := range quiescent {
		err := FromDB(pgConflict(raised))
		if err.Code != "run_not_quiescent" || err.Status != 409 {
			t.Fatalf("%s -> code %q status %d, want run_not_quiescent 409", raised, err.Code, err.Status)
		}
		if err.CurrentRevision != nil {
			t.Fatalf("%s carried revision %v, want none", raised, *err.CurrentRevision)
		}
		recovery := "<nil>"
		if err.RecoveryAction != nil {
			recovery = *err.RecoveryAction
		}
		if recovery != "refresh" || err.Retryable {
			// The frozen catalog signs run_not_quiescent as 409 / retryable=false /
			// recovery_action=refresh (error-codes.json:132-137). Asserting the entry
			// came from the catalog rather than a fallback is the point; an earlier
			// draft of this test demanded a retryable marker the catalog does not give.
			t.Fatalf("%s -> retryable=%v recovery=%q, want catalog refresh/not-retryable",
				raised, err.Retryable, recovery)
		}
	}
}

// TestVersionConflictStillNeedsDetail proves the fix did not loosen the
// optimistic-concurrency contract: a version_conflict without a current revision
// is still refused instead of being served as a bare 409.
func TestVersionConflictStillNeedsDetail(t *testing.T) {
	bare := FromDB(pgConflict("version_conflict"))
	if bare.Code != "service_degraded" {
		t.Fatalf("version_conflict without detail -> %q, want service_degraded", bare.Code)
	}
	withDetail := &pgconn.PgError{Code: "P0001", Message: "version_conflict", Detail: "7"}
	err := FromDB(withDetail)
	if err.Code != "version_conflict" || err.Status != 409 ||
		err.CurrentRevision == nil || *err.CurrentRevision != 7 {
		t.Fatalf("version_conflict with detail = code %q status %d revision %v",
			err.Code, err.Status, err.CurrentRevision)
	}
}

func TestNonDatabaseErrorStillDegraded(t *testing.T) {
	err := FromDB(errors.New("boom"))
	if err.Code != "service_degraded" || err.Status != 503 {
		t.Fatalf("plain error -> code %q status %d, want service_degraded 503", err.Code, err.Status)
	}
}
