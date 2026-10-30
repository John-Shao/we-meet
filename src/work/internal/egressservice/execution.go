package egressservice

import (
	"context"
	"errors"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/canonical"
	workdb "github.com/we-meet/work/internal/db"
)

// ExecutionBinding is the send tuple the signed thin wire deliberately omits.
// It is re-read from the authoritative execution row; the caller cannot choose
// any of it. ConsumeByExecution re-validates the same values inside the locked
// transaction, so this read is a pre-flight check, not the send authority.
type ExecutionBinding struct {
	ExecutionID    string
	TaskID         string
	RunID          string
	SnapshotID     string
	RuntimeVersion string
	OperationID    string
	AttemptID      string
	HolderID       string
	RunFence       int64
	RequestHash    string
	Mode           string
}

// BindingError is an enumerated execution-binding failure. Code is the only
// detail it exposes.
type BindingError struct {
	Code string
}

func (e *BindingError) Error() string { return "egressservice: " + e.Code }

// Enumeration codes exposed by the execution-binding reader.
const (
	codeRuntimeExecutionNotFound = "runtime_execution_not_found"
)

// PGBindings reads execution bindings through the work_worker pool. Node and
// egress never take a caller-provided organization: the read runs under an
// explicit tenant context with the worker role, so FORCE RLS still applies.
type PGBindings struct {
	Pool *pgxpool.Pool
}

var bindingIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:@/-]{1,128}$`)

// Resolve returns the execution's task/run/operation/attempt/holder/fence,
// frozen request hash and mode. A missing or foreign execution is one
// not-found answer.
func (b *PGBindings) Resolve(ctx context.Context, orgID, executionID string) (ExecutionBinding, error) {
	if b == nil || b.Pool == nil || orgID == "" || executionID == "" {
		return ExecutionBinding{}, &BindingError{Code: codeExecutionBindingUnavail}
	}
	var binding ExecutionBinding
	err := workdb.WithWorkerOrgContext(ctx, b.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT e.execution_id::text, e.task_id::text, e.run_id::text,
			       r.snapshot_id::text, e.runtime_version,
			       COALESCE(e.operation_id::text, ''),
			       COALESCE(e.dispatch_attempt_id::text, ''),
			       COALESCE(e.holder_id, ''), e.run_fence,
			       COALESCE(e.request_hash, ''), e.mode
			  FROM work.runtime_execution e
			  JOIN work.run r
			    ON r.id = e.run_id AND r.org_id = e.org_id
			 WHERE e.execution_id = $1 AND e.org_id = $2`,
			executionID, orgID,
		).Scan(
			&binding.ExecutionID, &binding.TaskID, &binding.RunID,
			&binding.SnapshotID, &binding.RuntimeVersion,
			&binding.OperationID, &binding.AttemptID, &binding.HolderID,
			&binding.RunFence, &binding.RequestHash, &binding.Mode,
		)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ExecutionBinding{}, &BindingError{Code: codeRuntimeExecutionNotFound}
	}
	if err != nil {
		// The original message may carry SQL text or bound values.
		return ExecutionBinding{}, &BindingError{Code: codeExecutionBindingUnavail}
	}
	return binding, nil
}

// resolveExecution reads and checks the binding against the frozen document.
// A plan fragment, an execution without operation/attempt/holder, a different
// request hash or a binding that differs from the document's task/run/
// snapshot/runtime version is refused before the gate is consumed.
func (s *Server) resolveExecution(
	ctx context.Context, orgID, executionID string, document canonical.ModelRequest, documentHash string,
) (ExecutionBinding, error) {
	binding, err := s.executions.Resolve(ctx, orgID, executionID)
	if err != nil {
		var bindingErr *BindingError
		if errors.As(err, &bindingErr) && bindingErr.Code == codeRuntimeExecutionNotFound {
			return ExecutionBinding{}, errExecutionNotExecutable
		}
		return ExecutionBinding{}, errExecutionBindingUnavail
	}
	if binding.ExecutionID != executionID ||
		!bindingIDPattern.MatchString(binding.OperationID) ||
		!uuidPattern.MatchString(binding.AttemptID) ||
		binding.HolderID == "" ||
		binding.RunFence <= 0 ||
		binding.Mode != "execute" {
		return ExecutionBinding{}, errExecutionNotExecutable
	}
	if binding.RequestHash != documentHash {
		return ExecutionBinding{}, errRequestHashMismatch
	}
	if binding.TaskID != document.Binding.TaskID ||
		binding.RunID != document.Binding.RunID ||
		binding.SnapshotID != document.Binding.SnapshotID ||
		binding.RuntimeVersion != document.Binding.RuntimeVersion {
		return ExecutionBinding{}, errRequestBindingMismatch
	}
	return binding, nil
}
