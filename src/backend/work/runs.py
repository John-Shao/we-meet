"""Private task ledger, token reservations and shared run lifecycle."""

from django.conf import settings
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from core.models import User

from . import access
from .models import WorkOrganizationEntitlement, WorkRun, WorkRunEvent, WorkTask
from .services import WorkError, require_organization, scoped_organization

ACTIVE = ("queued", "running")


def visible_tasks(user, organization_id=None):
    return WorkTask.objects.filter(
        owner=user,
        organization_id=scoped_organization(user, organization_id),
        kind="office_agent",
    )


def event(run, kind):
    # Caller holds run row lock, or has just inserted an uncommitted run.
    if hasattr(run, "source_run_id"):
        return  # Review lifecycle is exposed through its separate durable row.
    WorkRunEvent.objects.create(run=run, seq=run.events.count() + 1, type=kind)


def daily_reserved(owner_id, organization_id=None):
    """Tokens reserved today for one tenant, or legacy owner rows without one."""
    from .models import WorkReview  # noqa: PLC0415 -- independent review ledger

    today = timezone.localdate()
    runs_query = WorkRun.objects.filter(created_at__date=today)
    reviews_query = WorkReview.objects.filter(created_at__date=today)
    if organization_id is None:
        runs_query = runs_query.filter(
            task__owner_id=owner_id, task__organization_id__isnull=True
        )
        reviews_query = reviews_query.filter(
            source_run__task__owner_id=owner_id,
            source_run__task__organization_id__isnull=True,
        )
    else:
        runs_query = runs_query.filter(task__organization_id=organization_id)
        reviews_query = reviews_query.filter(
            source_run__task__organization_id=organization_id
        )
    total = runs_query.aggregate(total=Sum("reserved_tokens"))["total"] or 0
    reviews = reviews_query.aggregate(total=Sum("reserved_tokens"))["total"] or 0
    return total + reviews


def daily_budget(organization_id=None):
    """Tenant-specific budget, else the deployment-wide default."""
    if organization_id is not None:
        budget = (
            WorkOrganizationEntitlement.objects.filter(organization_id=organization_id)
            .values_list("daily_token_budget", flat=True)
            .first()
        )
        if budget is not None:
            return budget
    return settings.WORK_DAILY_TOKEN_BUDGET


def failure_status(code):
    """Access loss is terminal and distinct from provider or transport failure."""
    return "access_revoked" if code in access.DENIAL_CODES else "failed"


def new_run(task, key):
    """Caller holds owner and task locks; agent admission reserves the budget."""
    previous = task.runs.filter(request_key=key).first()
    if previous:
        return previous
    if task.runs.filter(execution_target="local").exists():
        raise WorkError("local_retry_requires_new_task", 409)
    if task.kind != "office_agent":
        raise WorkError("generation_unavailable", 503)
    from .agent_runs import new_agent_run  # noqa: PLC0415 -- boundary module

    return new_agent_run(task, key)


@transaction.atomic
def create_task(user, data, key, organization_id=None):
    User.objects.select_for_update().get(pk=user.pk)
    organization_id = require_organization(user, organization_id)
    previous = WorkTask.objects.filter(owner=user, request_key=key).first()
    if previous:
        if (
            previous.organization_id != organization_id
            or previous.kind != "office_agent"
            or any(
                getattr(previous, field) != data[field]
                for field in ("goal", "background")
            )
        ):
            raise WorkError("idempotency_conflict", 409)
        return previous, False
    task = WorkTask.objects.create(
        owner=user,
        organization_id=organization_id,
        request_key=key,
        kind="office_agent",
        **data,
    )
    new_run(task, key)
    return task, True


def terminal(run, status, code=""):
    run.status, run.error_code = status, code
    run.finished_at, run.lease_until = timezone.now(), None
    run.save()
    event(run, status)
