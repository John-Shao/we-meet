"""Activity names and their contract-level error classes."""

from enum import StrEnum

from work.orchestration.contracts.run_workflow import (
    ACTIVITY_POLICIES,
    ActivityPolicy,
)


class ActivityName(StrEnum):
    PREPARE_RUN = "prepareRun"
    ACQUIRE_RUN = "acquireRun"
    CREATE_MODEL_OPERATION = "createModelOperation"
    AUTHORIZE_OPERATION = "authorizeOperation"
    RESERVE_QUOTA = "reserveQuota"
    CLAIM_DISPATCH = "claimDispatch"
    INVOKE_MODEL = "invokeModel"
    FINISH_OPERATION = "finishOperation"
    SETTLE_QUOTA = "settleQuota"
    PUBLISH_ARTIFACT = "publishArtifact"
    FINISH_RUN = "finishRun"
    MARK_OPERATION_UNKNOWN = "markOperationUnknown"
    CANCEL_OPERATION = "cancelOperation"
    WAIT_RUN = "waitRun"
    RESUME_RUN = "resumeRun"
    RECONCILE_OPERATION = "reconcileOperation"


ACTIVITY_NAMES: tuple[ActivityName, ...] = tuple(ActivityName)

ERROR_CLASSES = {
    "domain_terminal": "The operation cannot succeed; do not retry unchanged.",
    "domain_wait": "Wait for an external signal (quota/reconcile/provider).",
    "transient": "Retry with backoff; the request may be resent unchanged.",
    "unknown": "Dispatch state is unknown; reconcile before retrying.",
}


def policy_for(name: ActivityName | str) -> ActivityPolicy:
    return ACTIVITY_POLICIES[str(name)]
