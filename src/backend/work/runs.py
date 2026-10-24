"""Private task ledger, token reservations and single-call durable execution."""

from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from core.models import User
from core.services.ai_usage import record_usage

from . import access
from .executor import (
    EXECUTOR_VERSION,
    MAX_ARTIFACT_CHARS,
    SYSTEM,
    CommunicationExecutor,
    prompt_for,
    validate_result,
)
from .models import (
    WorkArtifactVersion,
    WorkMaterial,
    WorkOrganizationEntitlement,
    WorkRun,
    WorkRunEvent,
    WorkTask,
)
from .services import (
    MaterialError,
    require_organization,
    scoped_organization,
    visible_materials,
)

ACTIVE = ("queued", "running")


def enabled():
    return bool(
        settings.WORK_ENABLED
        and settings.WORK_COMMUNICATION_ENABLED
        and settings.WORK_MODEL
        and settings.WORK_MODEL_BASE_URL
        and settings.WORK_MODEL_API_KEY
    )


def visible_tasks(user, organization_id=None):
    return WorkTask.objects.filter(
        owner=user, organization_id=scoped_organization(user, organization_id)
    )


def sources_for(task):
    """Reauthorize the frozen selection at admission, execution and delivery."""
    user = User.objects.get(pk=task.owner_id)
    code = access.scope_denial(user, task.organization_id)
    if code:
        raise MaterialError(code, access.denial_status(code))
    materials = {
        str(item.pk): item
        for item in visible_materials(user, task.organization_id).filter(
            pk__in=[ref["id"] for ref in task.sources], status="ready"
        )
    }
    ordered = []
    for ref in task.sources:
        item = materials.get(ref["id"])
        if not item or any(
            ref[key] != getattr(item, key)
            for key in ("checksum", "parser_version", "generation")
        ):
            raise MaterialError("source_unavailable", 409)
        ordered.append(item)
    return ordered


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
            WorkOrganizationEntitlement.objects.filter(
                organization_id=organization_id
            )
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
    """Caller holds owner and task locks; reserves worst-case UTF-8 token count."""
    previous = task.runs.filter(request_key=key).first()
    if previous:
        return previous
    if task.runs.filter(execution_target="local").exists():
        raise MaterialError("local_retry_requires_new_task", 409)
    if task.kind == "office_agent":
        from .agent_runs import new_agent_run  # noqa: PLC0415 -- boundary module

        return new_agent_run(task, key)
    if not enabled():
        raise MaterialError("generation_unavailable", 503)
    if task.runs.filter(status__in=ACTIVE).exists():
        raise MaterialError("run_active", 409)
    if task.runs.count() >= 20:
        raise MaterialError("task_run_limit", 429)
    prompt = prompt_for(task, sources_for(task))
    output = min(settings.WORK_MAX_OUTPUT_TOKENS, 4000)
    reservation = len(prompt.encode()) + len(SYSTEM.encode()) + 1024 + output
    used = daily_reserved(task.owner_id, task.organization_id)
    if used + reservation > daily_budget(task.organization_id):
        raise MaterialError("budget_exceeded", 429)
    run = WorkRun.objects.create(
        task=task,
        request_key=key,
        model=settings.WORK_MODEL,
        base_url=settings.WORK_MODEL_BASE_URL,
        reserved_tokens=reservation,
        max_output_tokens=output,
        executor_version=EXECUTOR_VERSION,
    )
    event(run, "queued")
    return run


@transaction.atomic
def create_task(user, data, key, organization_id=None):
    data = {"kind": "communication", **data}
    User.objects.select_for_update().get(pk=user.pk)
    organization_id = require_organization(user, organization_id)
    previous = WorkTask.objects.filter(owner=user, request_key=key).first()
    if previous:
        if previous.organization_id != organization_id or any(
            getattr(previous, field) != data[field]
            for field in ("kind", "recipient", "goal", "background", "sources")
        ):
            raise MaterialError("idempotency_conflict", 409)
        return previous, False
    task = WorkTask(
        owner=user, organization_id=organization_id, request_key=key, **data
    )
    materials = sources_for(task)
    if sum(item.size for item in materials) > 30 * 1024 * 1024:
        raise MaterialError("task_material_limit", 413)
    task.save()
    new_run(task, key)
    return task, True


def terminal(run, status, code=""):
    run.status, run.error_code = status, code
    run.finished_at, run.lease_until = timezone.now(), None
    run.save()
    event(run, status)


@transaction.atomic
def claim_run():
    """Never replay an expired provider attempt whose billing outcome is unknown."""
    now = timezone.now()
    for expired in WorkRun.objects.select_for_update(skip_locked=True).filter(
        task__kind="communication", status="running", lease_until__lt=now
    )[:20]:
        terminal(expired, "failed", "execution_unknown")
    if not enabled():
        return None
    for _ in range(20):
        run = (
            WorkRun.objects.select_for_update(skip_locked=True)
            .select_related("task")
            .filter(task__kind="communication", status="queued")
            .first()
        )
        if run is None:
            return None
        code = access.check(run.task.owner, run.task.organization_id)
        if code == "access_unavailable":
            return None
        if code:
            terminal(run, failure_status(code), code)
            continue
        run.status = "running"
        run.lease_until = now + timedelta(minutes=2)
        run.save()
        event(run, "running")
        return run
    return None


def execute_run(run):
    """Cancellation wins output races; usage is retained even after cancellation."""
    try:
        # Do not silently execute a queued request with a different prompt/budget.
        if run.executor_version != EXECUTOR_VERSION:
            raise MaterialError("generation_unavailable", 503)
        materials = sources_for(run.task)
        prompt = prompt_for(run.task, materials)
        with transaction.atomic():
            current = WorkRun.objects.select_for_update().get(pk=run.pk)
            if (
                current.status != "running"
                or current.call_started_at
                or current.lease_until <= timezone.now()
            ):
                return
            if not enabled() or (run.model, run.base_url) != (
                settings.WORK_MODEL,
                settings.WORK_MODEL_BASE_URL,
            ):
                raise MaterialError("generation_unavailable")
            current.call_started_at = timezone.now()
            current.save(update_fields=["call_started_at"])
            event(current, "model_started")

        def usage_sink(*, model_code, input_tokens, output_tokens):
            with transaction.atomic():
                current = WorkRun.objects.select_for_update().get(pk=run.pk)
                if current.usage_record_id:
                    return
                # Zero/missing usage is unknown, never presented as a free call.
                if input_tokens <= 0 or output_tokens < 0:
                    return
                current.input_tokens, current.output_tokens = (
                    input_tokens,
                    output_tokens,
                )
                current.usage_record = record_usage(
                    user=run.task.owner,
                    organization=run.task.organization,
                    model_code=model_code,
                    ref_type="work_run",
                    ref_id=run.pk,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    infer_organization=False,
                )
                current.save(
                    update_fields=["input_tokens", "output_tokens", "usage_record"]
                )

        raw = CommunicationExecutor().generate(run, prompt, usage_sink)
        body, citations = validate_result(raw, materials)
        body = body.replace(
            "# 沟通准备草稿",
            f"# 沟通准备草稿\n\n沟通对象：{run.task.recipient}\n\n沟通目标：{run.task.goal}",
            1,
        )
        if len(body) > MAX_ARTIFACT_CHARS:
            raise MaterialError("invalid_model_output")
        with transaction.atomic():
            current = WorkRun.objects.select_for_update().get(pk=run.pk)
            if current.status != "running":
                return
            if current.lease_until <= timezone.now():
                raise MaterialError("execution_unknown")
            sources_for(run.task)
            if not enabled():
                raise MaterialError("generation_unavailable")
            WorkArtifactVersion.objects.create(
                run=current, version=1, body=body, citations=citations
            )
            terminal(current, "succeeded")
    except Exception as exc:  # noqa: BLE001 -- no provider payload or credentials in errors/logs
        code = exc.code if isinstance(exc, MaterialError) else "execution_unknown"
        with transaction.atomic():
            current = WorkRun.objects.select_for_update().get(pk=run.pk)
            if current.status == "running" and code == "access_unavailable":
                if not current.call_started_at:
                    current.status, current.lease_until = "queued", None
                    current.save(update_fields=["status", "lease_until"])
            elif current.status == "running":
                terminal(current, failure_status(code), code)


def process_runs(limit=1):
    count = 0
    while count < limit:
        run = claim_run()
        if not run:
            break
        execute_run(run)
        count += 1
    return count
