// Package fragment defines the Go side of the signed cross-language
// advanceRuntime contract.
//
// Authority: docs/plan/work-r0a-orchestration-2026-10-25.md 搂5.0 (F0-R1) and
// docs/plan/assets/work-r0a-orchestration-2026-10-25/AdvanceRuntime.contract.ts.
// The payload carries identifiers and stored references only; task text,
// provider keys and raw messages never appear here because Temporal history is
// persisted and replicated.
package fragment

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
)

const (
	ContractVersion = "work-runtime-fragment-v1"
	KindRequest     = "advance_request"
	KindResult      = "advance_result"
	ActivityType    = "advanceRuntime"
	MaxLogicalStep  = 3
	MaxFenceDigits  = 19
)

var (
	ErrContract       = errors.New("fragment contract violation")
	uuidPattern       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	hashPattern       = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	refIDPattern      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	orgPattern        = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	versionPattern    = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	logicalKeyPattern = regexp.MustCompile(`^model:[1-3]$`)
	fencePattern      = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
)

type Reference struct {
	RefID string `json:"refId"`
	Hash  string `json:"hash"`
}

type Intent struct {
	Request     Reference `json:"request"`
	RequestHash string    `json:"requestHash"`
	LogicalKey  string    `json:"logicalKey"`
}

type Permit struct {
	OperationID       string `json:"operationId"`
	DispatchAttemptID string `json:"dispatchAttemptId"`
	RequestHash       string `json:"requestHash"`
}

// Request is the union of plan and execute fragments. Fields that do not apply
// to the mode must stay empty; Validate enforces that instead of letting the
// receiver guess.
type Request struct {
	Kind           string     `json:"kind"`
	Contract       string     `json:"contractVersion"`
	ExecutionID    string     `json:"executionId"`
	RunID          string     `json:"runId"`
	TaskID         string     `json:"taskId"`
	OrgID          string     `json:"orgId"`
	SnapshotID     string     `json:"snapshotId"`
	RuntimeVersion string     `json:"runtimeVersion"`
	Fence          string     `json:"fence"`
	DeadlineUnixMs int64      `json:"deadlineUnixMs"`
	Mode           string     `json:"mode"`
	Checkpoint     *Reference `json:"checkpoint"`
	Intent         *Intent    `json:"intent"`
	Permit         *Permit    `json:"permit"`
}

type Result struct {
	Kind        string     `json:"kind"`
	Contract    string     `json:"contractVersion"`
	ExecutionID string     `json:"executionId"`
	State       string     `json:"state"`
	Checkpoint  *Reference `json:"checkpoint"`
	Intent      *Intent    `json:"intent"`
	Receipt     *Reference `json:"receipt"`
	OperationID string     `json:"operationId"`
	Reason      string     `json:"reason"`
	Artifact    *Reference `json:"artifact"`
}

const (
	StateModelRequest     = "MODEL_REQUEST"
	StateCheckpointed     = "CHECKPOINTED"
	StateWaitingReconcile = "WAITING_RECONCILE"
	StateFinished         = "FINISHED"
	StateFailed           = "FAILED"
	StateCanceled         = "CANCELED"
)

// Wire and reason enumerations are closed by the signed TypeScript contract.
const (
	MaxWireBytes = 16_384

	ReasonInvalidContext     = "invalid_context"
	ReasonCheckpointFailed   = "checkpoint_failed"
	ReasonRuntimeFault       = "runtime_fault"
	ReasonDeadlineExceeded   = "deadline_exceeded"
	ReasonProviderRejected   = "provider_rejected"
	ReasonProviderUnknown    = "provider_unknown"
	ReasonReceiptUnavailable = "receipt_unavailable"
	ReasonCancelRequested    = "cancel_requested"
)

// FailedReasons is the closed FAILED reason set. Go validation, the Node
// protocol and the signed contract assets are expected to agree with it, so
// the parity test compares all three against this list.
var FailedReasons = []string{
	ReasonInvalidContext, ReasonCheckpointFailed, ReasonRuntimeFault,
	ReasonDeadlineExceeded, ReasonProviderRejected,
}

func isFailedReason(reason string) bool {
	for _, allowed := range FailedReasons {
		if reason == allowed {
			return true
		}
	}
	return false
}

func (r Request) Validate() error {
	if r.Kind != KindRequest || r.Contract != ContractVersion {
		return fmt.Errorf("%w: unexpected kind or contract version", ErrContract)
	}
	for name, value := range map[string]string{
		"executionId": r.ExecutionID, "runId": r.RunID, "taskId": r.TaskID, "snapshotId": r.SnapshotID,
	} {
		if !uuidPattern.MatchString(value) {
			return fmt.Errorf("%w: %s is not a uuid", ErrContract, name)
		}
	}
	if !orgPattern.MatchString(r.OrgID) {
		return fmt.Errorf("%w: orgId is invalid", ErrContract)
	}
	if !versionPattern.MatchString(r.RuntimeVersion) {
		return fmt.Errorf("%w: runtimeVersion is invalid", ErrContract)
	}
	if !fencePattern.MatchString(r.Fence) {
		return fmt.Errorf("%w: fence is not a positive decimal", ErrContract)
	}
	if _, err := strconv.ParseInt(r.Fence, 10, 64); err != nil {
		return fmt.Errorf("%w: fence is outside the bigint range", ErrContract)
	}
	if r.DeadlineUnixMs <= 0 {
		return fmt.Errorf("%w: deadline is required", ErrContract)
	}
	switch r.Mode {
	case "plan":
		if r.Intent != nil || r.Permit != nil {
			return fmt.Errorf("%w: a plan fragment must not carry an intent or permit", ErrContract)
		}
		if err := optionalReference(r.Checkpoint); err != nil {
			return fmt.Errorf("%w: checkpoint: %v", ErrContract, err)
		}
	case "execute":
		if r.Checkpoint == nil {
			return fmt.Errorf("%w: an execute fragment requires a checkpoint", ErrContract)
		}
		if err := optionalReference(r.Checkpoint); err != nil {
			return fmt.Errorf("%w: checkpoint: %v", ErrContract, err)
		}
		if r.Intent == nil || r.Permit == nil {
			return fmt.Errorf("%w: an execute fragment requires an intent and permit", ErrContract)
		}
		if err := r.Intent.validate(); err != nil {
			return fmt.Errorf("%w: intent: %v", ErrContract, err)
		}
		if !uuidPattern.MatchString(r.Permit.OperationID) || !uuidPattern.MatchString(r.Permit.DispatchAttemptID) {
			return fmt.Errorf("%w: permit identifiers are not uuids", ErrContract)
		}
		if !hashPattern.MatchString(r.Permit.RequestHash) {
			return fmt.Errorf("%w: permit request hash is invalid", ErrContract)
		}
		if r.Intent.RequestHash != r.Permit.RequestHash {
			return fmt.Errorf("%w: permit and intent request hashes differ", ErrContract)
		}
	default:
		return fmt.Errorf("%w: unknown mode", ErrContract)
	}
	return nil
}

func (i Intent) validate() error {
	if err := optionalReference(&i.Request); err != nil {
		return err
	}
	if !hashPattern.MatchString(i.RequestHash) {
		return errors.New("requestHash is invalid")
	}
	if !logicalKeyPattern.MatchString(i.LogicalKey) {
		return errors.New("logicalKey is outside model:1..model:3")
	}
	return nil
}

func optionalReference(ref *Reference) error {
	if ref == nil {
		return nil
	}
	if !refIDPattern.MatchString(ref.RefID) {
		return errors.New("refId is not a uuid")
	}
	if !hashPattern.MatchString(ref.Hash) {
		return errors.New("hash is invalid")
	}
	return nil
}

// ValidateResult enforces the state-specific shape the Go workflow depends on.
// A result that cannot be acted on is rejected instead of being interpreted.
func (r Result) Validate() error {
	if r.Kind != KindResult || r.Contract != ContractVersion || !uuidPattern.MatchString(r.ExecutionID) {
		return fmt.Errorf("%w: unexpected result envelope", ErrContract)
	}
	if err := optionalReference(r.Checkpoint); err != nil {
		return fmt.Errorf("%w: checkpoint: %v", ErrContract, err)
	}
	switch r.State {
	case StateModelRequest:
		if r.Intent == nil || r.Checkpoint == nil || r.Receipt != nil || r.Artifact != nil {
			return fmt.Errorf("%w: MODEL_REQUEST requires checkpoint and intent only", ErrContract)
		}
		if err := r.Intent.validate(); err != nil {
			return fmt.Errorf("%w: intent: %v", ErrContract, err)
		}
	case StateCheckpointed:
		if r.Checkpoint == nil || r.Receipt == nil || r.Intent != nil || r.Artifact != nil {
			return fmt.Errorf("%w: CHECKPOINTED requires checkpoint and receipt only", ErrContract)
		}
		if err := optionalReference(r.Receipt); err != nil {
			return fmt.Errorf("%w: receipt: %v", ErrContract, err)
		}
	case StateWaitingReconcile:
		if r.Intent != nil || r.Artifact != nil || r.Receipt != nil {
			return fmt.Errorf("%w: WAITING_RECONCILE carries no intent, receipt or artifact", ErrContract)
		}
		if !uuidPattern.MatchString(r.OperationID) {
			return fmt.Errorf("%w: WAITING_RECONCILE requires an operation id", ErrContract)
		}
		if r.Reason != ReasonProviderUnknown && r.Reason != ReasonReceiptUnavailable {
			return fmt.Errorf("%w: unknown reconcile reason", ErrContract)
		}
	case StateFinished:
		if r.Checkpoint == nil || r.Artifact == nil || r.Intent != nil || r.Receipt != nil {
			return fmt.Errorf("%w: FINISHED requires checkpoint and artifact only", ErrContract)
		}
		if err := optionalReference(r.Artifact); err != nil {
			return fmt.Errorf("%w: artifact: %v", ErrContract, err)
		}
	case StateFailed:
		if r.Artifact != nil || r.Intent != nil || r.Receipt != nil {
			return fmt.Errorf("%w: FAILED carries no intent, receipt or artifact", ErrContract)
		}
		if !isFailedReason(r.Reason) {
			return fmt.Errorf("%w: unknown failure reason", ErrContract)
		}
	case StateCanceled:
		if r.Artifact != nil || r.Intent != nil || r.Receipt != nil || r.OperationID != "" {
			return fmt.Errorf("%w: CANCELED carries only a checkpoint and reason", ErrContract)
		}
		if r.Reason != ReasonCancelRequested {
			return fmt.Errorf("%w: CANCELED reason must be cancel_requested", ErrContract)
		}
	default:
		return fmt.Errorf("%w: unknown result state", ErrContract)
	}
	return nil
}
