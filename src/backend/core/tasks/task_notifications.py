"""Retryable task-assignment IM delivery orchestration."""

import logging

from core.services.jusi_im import JusiImServiceError, JusiImUnreachableError
from core.services.task_notifications import (
    TaskImNotificationUnavailable,
    claim_task_assignment,
    deliver_claimed_task_assignment,
    mark_task_assignment_failed,
    mark_task_assignment_retry,
)
from core.tasks._task import task

logger = logging.getLogger(__name__)

# Five attempts total: immediate, then 15 s, 1 min, 5 min and 15 min.
RETRY_DELAYS_SECONDS = (15, 60, 300, 900)
MAX_ATTEMPTS = len(RETRY_DELAYS_SECONDS) + 1


@task(bind=False)
def deliver_task_assignment(delivery_id: str):
    """Deliver one ledger row; duplicate jobs and stale assignments are no-ops."""

    delivery = claim_task_assignment(delivery_id)
    if delivery is None:
        return None

    try:
        deliver_claimed_task_assignment(delivery)
    except (TaskImNotificationUnavailable, JusiImUnreachableError) as exc:
        if delivery.attempt_count < MAX_ATTEMPTS:
            delay = RETRY_DELAYS_SECONDS[delivery.attempt_count - 1]
            mark_task_assignment_retry(
                delivery,
                error=exc,
                delay_seconds=delay,
            )
            try:
                deliver_task_assignment.apply_async(
                    args=[str(delivery.pk)], countdown=delay
                )
            except Exception:  # pragma: no cover - recovery scan owns this gap
                logger.exception(
                    "Failed to enqueue retry for task IM delivery %s", delivery.pk
                )
            return "retrying"
        mark_task_assignment_failed(delivery, error=exc)
        logger.warning(
            "Task IM delivery %s exhausted %s attempts: %s",
            delivery.pk,
            delivery.attempt_count,
            exc,
        )
        return "failed"
    except JusiImServiceError as exc:
        # 4xx / malformed responses are not healed by retrying the same request.
        mark_task_assignment_failed(delivery, error=exc)
        logger.warning("Task IM delivery %s failed permanently: %s", delivery.pk, exc)
        return "failed"
    except Exception as exc:  # pragma: no cover - retain diagnostics for operations
        mark_task_assignment_failed(delivery, error=exc)
        logger.exception("Unexpected task IM delivery failure %s", delivery.pk)
        return "failed"

    logger.info(
        "Task assignment delivered by Meeting Assistant task=%s recipient=%s event=%s",
        delivery.task_id,
        delivery.recipient_id,
        delivery.event,
    )
    return "delivered"
