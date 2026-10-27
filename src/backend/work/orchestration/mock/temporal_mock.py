"""Minimal Temporal substitute for local tests; no network or SDK."""

from dataclasses import dataclass, field
from typing import Callable

from work.orchestration.contracts.run_workflow import (
    RunWorkflowInput,
    RunWorkflowStatus,
)


@dataclass
class WorkflowHandle:
    workflow_id: str
    run_id: str
    status: RunWorkflowStatus
    history: list[str] = field(default_factory=list)


class TemporalMock:
    def __init__(self):
        self.handles: dict[str, WorkflowHandle] = {}

    def start(self, request: RunWorkflowInput) -> WorkflowHandle:
        handle = WorkflowHandle(
            workflow_id=f"run:{request.run_id}",
            run_id=request.run_id,
            status=RunWorkflowStatus(run_id=request.run_id, state="queued"),
        )
        self.handles[handle.workflow_id] = handle
        return handle

    def execute(
        self,
        request: RunWorkflowInput,
        workflow: Callable[[WorkflowHandle], None],
    ) -> WorkflowHandle:
        handle = self.start(request)
        handle.status = RunWorkflowStatus(run_id=request.run_id, state="active")
        workflow(handle)
        self.handles[handle.workflow_id] = handle
        return handle
