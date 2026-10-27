"""Deterministic Work Adapter mock: one model step, one checkpoint."""

from work.runtime.contracts.work_adapter import (
    Checkpoint,
    ModelCallRequest,
    RunContext,
)
from work.runtime.mock.model_gateway import FauxModelGateway


class MockWorkAdapter:
    def __init__(self, gateway: FauxModelGateway | None = None):
        self.gateway = gateway or FauxModelGateway()

    def run(self, context: RunContext) -> list[Checkpoint]:
        provider = self.gateway.resolve_provider_context(context.org_id)
        result = self.gateway.invoke(
            ModelCallRequest(
                run_id=context.run_id,
                operation_id=f"{context.run_id}:step-1",
                dispatch_attempt_id=f"{context.run_id}:attempt-1",
                fence=1,
                request_hash=f"sha256:{context.run_id}",
                step_no=1,
                input_ref=context.input_ref,
            ),
            provider,
        )
        return [
            Checkpoint(
                checkpoint_ref=result.content_ref,
                step_no=1,
                content_hash=result.content_hash,
            )
        ]

    def restore(self, context: RunContext, checkpoint: Checkpoint) -> None:
        return None
