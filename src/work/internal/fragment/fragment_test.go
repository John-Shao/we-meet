package fragment_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/fragment"
)

const (
	execID = "11111111-1111-4111-8111-111111111111"
	runID  = "22222222-2222-4222-8222-222222222222"
	taskID = "33333333-3333-4333-8333-333333333333"
	snapID = "44444444-4444-4444-8444-444444444444"
	opID   = "55555555-5555-4555-8555-555555555555"
	attID  = "66666666-6666-4666-8666-666666666666"
	refID  = "77777777-7777-4777-8777-777777777777"
	hashA  = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	hashB  = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func baseRequest() fragment.Request {
	return fragment.Request{
		Kind: fragment.KindRequest, Contract: fragment.ContractVersion,
		ExecutionID: execID, RunID: runID, TaskID: taskID, OrgID: "org_a",
		SnapshotID: snapID, RuntimeVersion: "work-runtime-1.4.0",
		Fence: "7", DeadlineUnixMs: 1_700_000_000_000, Mode: "plan",
	}
}

func TestPlanFragmentAcceptsOnlyPlanFields(t *testing.T) {
	request := baseRequest()
	request.Checkpoint = &fragment.Reference{RefID: refID, Hash: hashA}
	if err := request.Validate(); err != nil {
		t.Fatalf("valid plan fragment: %v", err)
	}

	withIntent := baseRequest()
	withIntent.Intent = &fragment.Intent{
		Request: fragment.Reference{RefID: refID, Hash: hashA}, RequestHash: hashA, LogicalKey: "model:1",
	}
	if err := withIntent.Validate(); !errors.Is(err, fragment.ErrContract) {
		t.Fatalf("plan fragment with intent: %v", err)
	}
}

func TestExecuteFragmentBindingRules(t *testing.T) {
	request := baseRequest()
	request.Mode = "execute"
	request.Checkpoint = &fragment.Reference{RefID: refID, Hash: hashA}
	request.Intent = &fragment.Intent{
		Request: fragment.Reference{RefID: refID, Hash: hashA}, RequestHash: hashA, LogicalKey: "model:2",
	}
	request.Permit = &fragment.Permit{OperationID: opID, DispatchAttemptID: attID, RequestHash: hashA}
	if err := request.Validate(); err != nil {
		t.Fatalf("valid execute fragment: %v", err)
	}

	cases := map[string]func(*fragment.Request){
		"missing checkpoint": func(r *fragment.Request) { r.Checkpoint = nil },
		"missing intent":     func(r *fragment.Request) { r.Intent = nil },
		"missing permit":     func(r *fragment.Request) { r.Permit = nil },
		"hash mismatch":      func(r *fragment.Request) { r.Permit.RequestHash = hashB },
		"bad operation id":   func(r *fragment.Request) { r.Permit.OperationID = "op-1" },
		"logical key range":  func(r *fragment.Request) { r.Intent.LogicalKey = "model:4" },
		"short hash":         func(r *fragment.Request) { r.Intent.RequestHash = "sha256:aa" },
		"unknown mode":       func(r *fragment.Request) { r.Mode = "continue" },
		"zero deadline":      func(r *fragment.Request) { r.DeadlineUnixMs = 0 },
		"bad fence":          func(r *fragment.Request) { r.Fence = "0" },
		"oversize fence":     func(r *fragment.Request) { r.Fence = strings.Repeat("9", 20) },
		"bigint overflow":    func(r *fragment.Request) { r.Fence = "9999999999999999999" },
		"bad org":            func(r *fragment.Request) { r.OrgID = "org a" },
		"bad version":        func(r *fragment.Request) { r.RuntimeVersion = "1.0/rc" },
		"wrong contract":     func(r *fragment.Request) { r.Contract = "work-runtime-fragment-v2" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			candidate := baseRequest()
			candidate.Mode = "execute"
			candidate.Checkpoint = &fragment.Reference{RefID: refID, Hash: hashA}
			candidate.Intent = &fragment.Intent{
				Request: fragment.Reference{RefID: refID, Hash: hashA}, RequestHash: hashA, LogicalKey: "model:1",
			}
			candidate.Permit = &fragment.Permit{OperationID: opID, DispatchAttemptID: attID, RequestHash: hashA}
			mutate(&candidate)
			if err := candidate.Validate(); !errors.Is(err, fragment.ErrContract) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func result(state string) fragment.Result {
	return fragment.Result{
		Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: execID, State: state,
	}
}

func TestResultShapes(t *testing.T) {
	checkpoint := &fragment.Reference{RefID: refID, Hash: hashA}

	modelRequest := result(fragment.StateModelRequest)
	modelRequest.Checkpoint = checkpoint
	modelRequest.Intent = &fragment.Intent{
		Request: *checkpoint, RequestHash: hashA, LogicalKey: "model:1",
	}
	if err := modelRequest.Validate(); err != nil {
		t.Fatalf("MODEL_REQUEST: %v", err)
	}

	checkpointed := result(fragment.StateCheckpointed)
	checkpointed.Checkpoint = checkpoint
	checkpointed.Receipt = &fragment.Reference{RefID: refID, Hash: hashB}
	if err := checkpointed.Validate(); err != nil {
		t.Fatalf("CHECKPOINTED: %v", err)
	}

	waiting := result(fragment.StateWaitingReconcile)
	waiting.OperationID = opID
	waiting.Reason = "provider_unknown"
	if err := waiting.Validate(); err != nil {
		t.Fatalf("WAITING_RECONCILE: %v", err)
	}

	finished := result(fragment.StateFinished)
	finished.Checkpoint = checkpoint
	finished.Artifact = &fragment.Reference{RefID: refID, Hash: hashB}
	if err := finished.Validate(); err != nil {
		t.Fatalf("FINISHED: %v", err)
	}

	failed := result(fragment.StateFailed)
	failed.Reason = fragment.ReasonRuntimeFault
	if err := failed.Validate(); err != nil {
		t.Fatalf("FAILED: %v", err)
	}

	canceled := result(fragment.StateCanceled)
	canceled.Reason = fragment.ReasonCancelRequested
	if err := canceled.Validate(); err != nil {
		t.Fatalf("CANCELED: %v", err)
	}
}

func TestResultRejectsAmbiguousOrIncompleteShapes(t *testing.T) {
	checkpoint := &fragment.Reference{RefID: refID, Hash: hashA}
	cases := map[string]fragment.Result{
		"unknown state": {Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: execID, State: "DONE"},
		"finished without artifact": {
			Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: execID,
			State: fragment.StateFinished, Checkpoint: checkpoint,
		},
		"checkpointed without receipt": {
			Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: execID,
			State: fragment.StateCheckpointed, Checkpoint: checkpoint,
		},
		"reconcile without operation": {
			Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: execID,
			State: fragment.StateWaitingReconcile, Reason: "provider_unknown",
		},
		"reconcile with free text": {
			Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: execID,
			State: fragment.StateWaitingReconcile, OperationID: opID, Reason: "model failed badly",
		},
		"failed with free text": {
			Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: execID,
			State: fragment.StateFailed, Reason: "Error: something secret",
		},
		"failed with artifact": {
			Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: execID,
			State: fragment.StateFailed, Reason: fragment.ReasonRuntimeFault,
			Artifact: &fragment.Reference{RefID: refID, Hash: hashB},
		},
		"model request with receipt": {
			Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: execID,
			State: fragment.StateModelRequest, Checkpoint: checkpoint,
			Intent:  &fragment.Intent{Request: *checkpoint, RequestHash: hashA, LogicalKey: "model:1"},
			Receipt: &fragment.Reference{RefID: refID, Hash: hashB},
		},
		"canceled with wrong reason": {
			Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: execID,
			State: fragment.StateCanceled, Reason: fragment.ReasonRuntimeFault,
		},
		"canceled with operation": {
			Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: execID,
			State: fragment.StateCanceled, Reason: fragment.ReasonCancelRequested, OperationID: opID,
		},
		"bad execution id": {
			Kind: fragment.KindResult, Contract: fragment.ContractVersion, ExecutionID: "exec",
			State: fragment.StateFailed, Reason: fragment.ReasonRuntimeFault,
		},
	}
	for name, candidate := range cases {
		t.Run(name, func(t *testing.T) {
			if err := candidate.Validate(); !errors.Is(err, fragment.ErrContract) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}
