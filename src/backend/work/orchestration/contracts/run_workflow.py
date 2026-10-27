"""R0a RunWorkflow contract, ported from the design asset (D3).

No Temporal SDK import: the runtime maps these types onto its SDK. Workflow
history carries IDs and hashes only; content stays in the Content Store.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

RunWorkflowVersion = Literal["r0a-v1"]
WaitReason = Literal["quota", "provider", "reconcile"]
RunTerminal = Literal["succeeded", "failed", "canceled"]
OperationOutcome = Literal["succeeded", "failed"]
RunState = Literal[
    "queued",
    "active",
    "waiting",
    "cancel_requested",
    "succeeded",
    "failed",
    "canceled",
]
PermissionMode = Literal["ask_each", "auto_readonly"]

WORKFLOW_DEFAULTS = {
    "workflow_version": "r0a-v1",
    "workflow_id_prefix": "run:",
    "run_timeout": "30 minutes",
    "model_activity_timeout": "15 minutes",
    "activity_heartbeat": "30 seconds",
    "history_retention": "7 days",
    "max_run_bytes": 262144,
    "max_model_operations": 3,
    "quota_wait_timeout": "24 hours",
    "outbox_backlog_limit": 1000,
    "outbox_oldest_age": "5 minutes",
}


def workflow_id_for_run(run_id: str) -> str:
    return f"{WORKFLOW_DEFAULTS['workflow_id_prefix']}{run_id}"


@dataclass(frozen=True, slots=True)
class RunWorkflowInput:
    run_id: str
    task_id: str
    org_id: str
    workflow_version: RunWorkflowVersion = "r0a-v1"


@dataclass(frozen=True, slots=True)
class RunWorkflowStatus:
    run_id: str
    state: RunState
    wait_reason: WaitReason | None = None
    operation_id: str | None = None
    dispatch_attempt_id: str | None = None
    step_no: int = 0
    last_error_code: str | None = None


@dataclass(frozen=True, slots=True)
class CancelSignal:
    request_id: str
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class QuotaAvailableSignal:
    request_id: str
    account_key: str
    period_id: str


@dataclass(frozen=True, slots=True)
class ResumeSignal:
    request_id: str
    reason: Literal["quota", "reconcile", "operator"]


@dataclass(frozen=True, slots=True)
class ApprovalDecidedSignal:
    request_id: str
    approval_id: str
    decision: Literal["approved", "rejected"]
    expected_revision: int
    params_hash: str


@dataclass(frozen=True, slots=True)
class PreparedRun:
    run_id: str
    task_id: str
    org_id: str
    snapshot_id: str
    fence: int
    permission_mode: PermissionMode
    target: dict[str, str] = field(
        default_factory=lambda: {"kind": "cloud", "profile": "text-v1"}
    )


@dataclass(frozen=True, slots=True)
class QuotaReservation:
    reservation_id: str
    operation_id: str
    amount_tokens: int
    reservation_seq: int


@dataclass(frozen=True, slots=True)
class DispatchPermit:
    operation_id: str
    dispatch_attempt_id: str
    fence: int
    request_hash: str


@dataclass(frozen=True, slots=True)
class ModelCallRequest:
    run_id: str
    task_id: str
    org_id: str
    operation_id: str
    dispatch_attempt_id: str
    fence: int
    request_hash: str
    step_no: int
    input_ref: str
    checkpoint_ref: str | None = None
    template_ref: str | None = None
    output_format: Literal["markdown"] = "markdown"


@dataclass(frozen=True, slots=True)
class ModelUsage:
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int | None = None


@dataclass(frozen=True, slots=True)
class ModelCallResult:
    content_ref: str
    content_hash: str
    bytes: int
    provider_request_id: str
    media_type: Literal["text/markdown"] = "text/markdown"
    usage: ModelUsage | None = None


@dataclass(frozen=True, slots=True)
class ArtifactDraft:
    artifact_id: str
    version_no: int
    content_ref: str
    content_hash: str
    bytes: int
    media_type: Literal["text/markdown"] = "text/markdown"


@dataclass(frozen=True, slots=True)
class FinishRunRequest:
    run_id: str
    org_id: str
    outcome: RunTerminal
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class ReconcileResolution:
    operation_id: str
    resolution: Literal["sent_succeeded", "not_sent", "unresolved"]
    billable_tokens: int
    provider_request_id: str | None = None
    evidence_ref: str | None = None


@dataclass(frozen=True, slots=True)
class ActivityPolicy:
    start_to_close_timeout: str
    maximum_attempts: int
    initial_interval: str
    backoff_coefficient: int
    non_retryable_error_types: tuple[str, ...] = ()
    heartbeat_timeout: str | None = None
    schedule_to_close_timeout: str | None = None


ACTIVITY_POLICIES: dict[str, ActivityPolicy] = {
    "prepareRun": ActivityPolicy(
        "10 seconds", 3, "1 second", 2, ("run_not_found", "run_not_current")
    ),
    "acquireRun": ActivityPolicy(
        "10 seconds", 3, "1 second", 2, ("run_not_queued", "run_not_current")
    ),
    "createModelOperation": ActivityPolicy(
        "10 seconds",
        5,
        "1 second",
        2,
        ("run_not_accepting_operations", "operation_key_conflict"),
    ),
    "authorizeOperation": ActivityPolicy(
        "10 seconds", 5, "1 second", 2, ("approval_required",)
    ),
    "reserveQuota": ActivityPolicy(
        "10 seconds", 5, "1 second", 2, ("quota_exhausted", "run_cap_exceeded")
    ),
    "claimDispatch": ActivityPolicy(
        "10 seconds", 3, "1 second", 2, ("operation_not_authorized",)
    ),
    "invokeModel": ActivityPolicy(
        "15 minutes",
        1,
        "1 second",
        2,
        ("unknown_dispatch",),
        heartbeat_timeout="30 seconds",
    ),
    "finishOperation": ActivityPolicy(
        "10 seconds", 5, "1 second", 2, ("operation_not_found",)
    ),
    "settleQuota": ActivityPolicy(
        "10 seconds", 5, "1 second", 2, ("reservation_not_found",)
    ),
    "publishArtifact": ActivityPolicy(
        "10 seconds", 3, "1 second", 2, ("run_not_accepting_artifacts",)
    ),
    "finishRun": ActivityPolicy(
        "10 seconds", 5, "1 second", 2, ("invalid_transition",)
    ),
    "markOperationUnknown": ActivityPolicy("10 seconds", 5, "1 second", 2),
    "cancelOperation": ActivityPolicy("10 seconds", 5, "1 second", 2),
    "waitRun": ActivityPolicy("10 seconds", 3, "1 second", 2),
    "resumeRun": ActivityPolicy("10 seconds", 3, "1 second", 2),
    "reconcileOperation": ActivityPolicy(
        "10 seconds", 3, "1 second", 2, ("reconciliation_conflict",)
    ),
}


class RunActivities(Protocol):
    """Every activity is idempotent by run/operation/logical key/request hash."""

    def prepare_run(self, request: RunWorkflowInput) -> PreparedRun: ...

    def acquire_run(self, run_id: str, org_id: str) -> PreparedRun: ...

    def create_model_operation(
        self, run_id: str, org_id: str, logical_key: str, request_hash: str
    ) -> str: ...

    def authorize_operation(
        self, operation_id: str, org_id: str, policy_epoch: int
    ) -> None: ...

    def reserve_quota(
        self,
        org_id: str,
        account_key: str,
        period_id: str,
        operation_id: str,
        amount_tokens: int,
    ) -> QuotaReservation: ...

    def claim_dispatch(
        self, operation_id: str, org_id: str, consumer_id: str, fence: int
    ) -> DispatchPermit | None: ...

    def invoke_model(self, request: ModelCallRequest) -> ModelCallResult: ...

    def finish_operation(
        self,
        operation_id: str,
        org_id: str,
        outcome: OperationOutcome,
        provider_request_id: str | None,
        receipt_ref: str | None,
    ) -> None: ...

    def settle_quota(
        self,
        reservation_id: str,
        amount_tokens: int,
        usage: ModelUsage,
        settlement_revision: int,
    ) -> None: ...

    def publish_artifact(  # noqa: PLR0913
        self,
        org_id: str,
        task_id: str,
        run_id: str,
        logical_name: str,
        content_ref: str,
        content_hash: str,
        bytes_: int,
        media_type: Literal["text/markdown"],
        provenance: dict,
    ) -> ArtifactDraft: ...

    def finish_run(self, request: FinishRunRequest) -> None: ...

    def mark_operation_unknown(
        self, operation_id: str, org_id: str, reason: str
    ) -> None: ...

    def cancel_operation(
        self,
        operation_id: str,
        org_id: str,
        actor_subject_id: str,
        reason: str | None,
    ) -> None: ...

    def wait_run(self, run_id: str, org_id: str, reason: WaitReason) -> None: ...

    def resume_run(self, run_id: str, org_id: str) -> None: ...

    def reconcile_operation(self, resolution: ReconcileResolution) -> None: ...
