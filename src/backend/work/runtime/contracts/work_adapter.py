"""Work Adapter contract (D4): RunContext, model calls, usage and checkpoints."""

from dataclasses import dataclass
from typing import Literal, Protocol

PermissionMode = Literal["ask_each", "auto_readonly"]


@dataclass(frozen=True, slots=True)
class RunContext:
    run_id: str
    task_id: str
    org_id: str
    snapshot_ref: str
    permission_mode: PermissionMode
    input_ref: str
    checkpoint_ref: str | None = None
    max_tokens: int = 0


@dataclass(frozen=True, slots=True)
class ModelCallRequest:
    run_id: str
    operation_id: str
    dispatch_attempt_id: str
    fence: int
    request_hash: str
    step_no: int
    input_ref: str
    prompt_ref: str | None = None
    output_format: Literal["markdown"] = "markdown"


@dataclass(frozen=True, slots=True)
class UsageReport:
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int = 0
    reasoning_tokens: int = 0


@dataclass(frozen=True, slots=True)
class ModelCallResult:
    content_ref: str
    content_hash: str
    bytes: int
    media_type: str
    provider_request_id: str
    usage: UsageReport


@dataclass(frozen=True, slots=True)
class Checkpoint:
    checkpoint_ref: str
    step_no: int
    content_hash: str


class WorkAdapter(Protocol):
    def run(self, context: RunContext) -> list[Checkpoint]: ...

    def restore(self, context: RunContext, checkpoint: Checkpoint) -> None: ...
