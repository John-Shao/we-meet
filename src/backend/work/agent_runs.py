"""Durable Work outbox over our versioned HTTP boundary, independent of SDKs.

Ticks submit/poll briefly; the isolated gateway owns long-running execution.
A lost response always queries the same UUID and never creates a second job.
"""

import json
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Q, Sum
from django.utils import timezone

from core.services.ai_usage import record_usage

from . import runs
from .agent_client import CONTRACT, AgentBoundaryError, AgentClient
from .executor import MAX_ARTIFACT_CHARS
from .models import WorkArtifactFile, WorkArtifactVersion, WorkRun
from .services import MaterialError

VERSION = "office-agent-v1"
REQUIRED_FEATURES = {"idempotency", "cancel", "cumulative_budget", "provider_metering"}
USAGE_KEYS = {
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
}


def enabled():
    return bool(
        settings.WORK_ENABLED
        and settings.WORK_AGENT_ENABLED
        and settings.WORK_AGENT_URL
        and settings.WORK_AGENT_TOKEN
        and settings.WORK_AGENT_MODEL
    )


def new_agent_run(task, key):
    """Caller holds owner/task locks. Freeze only explicitly selected text."""
    if not enabled():
        raise MaterialError("generation_unavailable", 503)
    if task.runs.filter(status__in=runs.ACTIVE).exists():
        raise MaterialError("run_active", 409)
    if task.runs.count() >= 20:
        raise MaterialError("task_run_limit", 429)
    materials = runs.sources_for(task)
    files = {}
    manifest = []
    for item in materials:
        extension = "csv" if item.mime == "text/csv" else "md"
        name = f"source-{item.pk}.{extension}"
        files[name] = item.text
        manifest.append(
            {
                "file": name,
                "name": item.original_name,
                **next(ref for ref in task.sources if ref["id"] == str(item.pk)),
            }
        )
    files["sources.json"] = json.dumps(manifest, ensure_ascii=False)
    if sum(len(text.encode()) for text in files.values()) > 400000:
        raise MaterialError("context_too_large", 413)
    budget = min(settings.WORK_AGENT_TOKEN_BUDGET, 80000)
    output = min(settings.WORK_MAX_OUTPUT_TOKENS, 4096)
    if budget < output + 1024:
        raise MaterialError("generation_unavailable", 503)
    used = (
        WorkRun.objects.filter(
            task__owner_id=task.owner_id, created_at__date=timezone.localdate()
        ).aggregate(total=Sum("reserved_tokens"))["total"]
        or 0
    )
    if used + budget > settings.WORK_DAILY_TOKEN_BUDGET:
        raise MaterialError("budget_exceeded", 429)
    run_id = uuid.uuid4()
    payload = {
        "goal": task.goal
        + ("\n\n用户补充背景：\n" + task.background if task.background else ""),
        "files": files,
        "timeout_seconds": min(settings.WORK_AGENT_TIMEOUT, 300),
        "limits": {
            "max_model_calls": min(settings.WORK_AGENT_MAX_CALLS, 6),
            "max_total_tokens": budget,
            "max_output_tokens": output,
        },
    }
    run = WorkRun.objects.create(
        id=run_id,
        task=task,
        request_key=key,
        model=settings.WORK_AGENT_MODEL,
        base_url=settings.WORK_AGENT_URL,
        reserved_tokens=budget,
        max_output_tokens=output,
        executor_version=VERSION,
        agent_payload=payload,
    )
    runs.event(run, "queued")
    return run


@transaction.atomic
def claim(exclude):
    now = timezone.now()
    run = (
        WorkRun.objects.select_for_update(skip_locked=True)
        .filter(task__kind="office_agent", execution_target="cloud", agent_done=False)
        .exclude(pk__in=exclude)
        .filter(Q(lease_until__isnull=True) | Q(lease_until__lt=now))
        .first()
    )
    if run:
        run.agent_generation += 1
        run.lease_until = now + timedelta(seconds=45)
        run.save(update_fields=["agent_generation", "lease_until"])
    return run


def check_caps(caps, run):
    if not isinstance(caps, dict):
        raise MaterialError("agent_contract_mismatch", 503)
    engines = {"dsh", "pi"}
    if getattr(settings, "WORK_AGENT_TEST_FIXTURE", False):
        engines.add("fixture")
    if (
        not isinstance(caps.get("features"), list)
        or any(not isinstance(value, str) for value in caps["features"])
        or not isinstance(caps.get("limits_ceiling"), dict)
    ):
        raise MaterialError("agent_contract_mismatch", 503)
    if (
        caps.get("contract") != CONTRACT
        or caps.get("engine") not in engines
        or caps.get("model") != run.model
        or not REQUIRED_FEATURES.issubset(set(caps.get("features", [])))
        or any(
            type(caps.get("limits_ceiling", {}).get(key)) is not int
            or caps["limits_ceiling"][key] < value
            for key, value in run.agent_payload["limits"].items()
        )
    ):
        raise MaterialError("agent_contract_mismatch", 503)


def validate_metering(value):
    meter = value.get("metering")
    if not isinstance(meter, dict) or type(meter.get("complete")) is not bool:
        raise MaterialError("agent_invalid_response")
    if type(meter.get("calls")) is not int or not 0 <= meter["calls"] <= 6:
        raise MaterialError("agent_invalid_response")
    usage = meter.get("usage")
    if meter["complete"] and meter["calls"] and usage is None:
        raise MaterialError("agent_invalid_response")
    if usage is not None and (
        not isinstance(usage, dict)
        or set(usage) != USAGE_KEYS
        or any(type(n) is not int or not 0 <= n <= 10000000 for n in usage.values())
    ):
        raise MaterialError("agent_invalid_response")
    return meter


def save_usage(run, meter):
    run.agent_metering = meter
    if meter["complete"] and not meter["calls"]:
        run.reserved_tokens = 0
        run.input_tokens = run.output_tokens = 0
    # Persist late cancellation usage only when every attempted call is accounted for.
    if meter["complete"] and meter["usage"] is not None and not run.usage_record_id:
        usage = meter["usage"]
        run.input_tokens = sum(usage[key] for key in USAGE_KEYS - {"output_tokens"})
        run.output_tokens = usage["output_tokens"]
        run.reserved_tokens = sum(usage.values())
        run.usage_record = record_usage(
            user=run.task.owner,
            organization=run.task.organization,
            model_code=run.model,
            ref_type="work_run",
            ref_id=run.pk,
            input_tokens=run.input_tokens,
            output_tokens=run.output_tokens,
            infer_organization=False,
        )


def import_result(run, result):
    # The HTTP client checked hashes and flat names; retain generated files immutably.
    summary = result["summary"]
    if not summary or len(summary) > MAX_ARTIFACT_CHARS:
        raise MaterialError("invalid_model_output")
    primary = next(
        (
            item["text"]
            for item in result["artifacts"]
            if item["name"].endswith(".md") and len(item["text"]) <= MAX_ARTIFACT_CHARS
        ),
        summary,
    )
    WorkArtifactVersion.objects.create(run=run, version=1, body=primary, citations=[])
    for item in result["artifacts"]:
        WorkArtifactFile.objects.create(
            run=run, **{key: item[key] for key in ("name", "text", "sha256")}
        )


def reconcile(run):  # noqa: PLR0912, PLR0915 -- fenced admission/delivery/cancel state machine
    client = AgentClient(run.base_url, settings.WORK_AGENT_TOKEN, timeout=4)
    value = None
    try:
        with transaction.atomic():
            current = WorkRun.objects.select_for_update().get(pk=run.pk)
            if current.agent_generation != run.agent_generation:
                return
            if current.status in runs.ACTIVE:
                try:
                    runs.sources_for(current.task)
                    if (
                        not enabled()
                        or settings.WORK_AGENT_URL != current.base_url
                        or current.executor_version != VERSION
                    ):
                        raise MaterialError("generation_unavailable")
                except MaterialError as exc:
                    runs.terminal(current, "failed", exc.code)
            if current.status not in runs.ACTIVE and not current.call_started_at:
                current.agent_done = True
                current.reserved_tokens = 0
                current.input_tokens = current.output_tokens = 0
                current.lease_until = None
                current.save()
                return
            run = current
        if run.status not in runs.ACTIVE:
            # Persisted terminal state wins; retry remote cleanup even after a lost ack.
            value = client.cancel(run.pk)
        else:
            try:
                value = client.get(run.pk)
            except AgentBoundaryError as exc:
                if exc.code != "agent_http_404":
                    raise
                caps = client.capabilities()
                check_caps(caps, run)
                with transaction.atomic():
                    current = WorkRun.objects.select_for_update().get(pk=run.pk)
                    if (
                        current.status not in runs.ACTIVE
                        or current.agent_generation != run.agent_generation
                    ):
                        return
                    if current.agent_deployment and current.agent_deployment != caps:
                        raise MaterialError("deployment_changed") from None
                    runs.sources_for(current.task)
                    current.agent_deployment = caps
                    # Commit before network admission; exact same UUID/payload on uncertainty.
                    current.call_started_at = current.call_started_at or timezone.now()
                    current.save()
                value = client.submit(run.pk, **run.agent_payload)
        check_caps(value.get("deployment", {}), run)
        meter = validate_metering(value)
        with transaction.atomic():
            current = WorkRun.objects.select_for_update().get(pk=run.pk)
            if current.agent_generation != run.agent_generation:
                return
            save_usage(current, meter)
            current.call_started_at = current.call_started_at or timezone.now()
            if current.status in runs.ACTIVE:
                try:
                    runs.sources_for(current.task)
                    if not enabled():
                        raise MaterialError("generation_unavailable")
                    if value["state"] == "succeeded":
                        import_result(current, value["result"])
                        runs.terminal(current, "succeeded")
                    elif value["state"] in {"failed", "cancelled"}:
                        # Upstream codes are an allowlist, never raw provider data.
                        code = value["error_code"]
                        runs.terminal(
                            current,
                            "failed",
                            code
                            if code
                            in {
                                "budget_exceeded",
                                "execution_unknown",
                                "deadline_exceeded",
                                "deployment_changed",
                                "agent_failed",
                            }
                            else "agent_failed",
                        )
                    elif current.status == "queued":
                        current.status = "running"
                        runs.event(current, "running")
                except MaterialError as exc:
                    runs.terminal(current, "failed", exc.code)
            remote_terminal = value["state"] in {"succeeded", "failed", "cancelled"}
            # Unknown usage remains visible and reserved. Allow 60s for in-flight drain.
            grace_over = (
                current.finished_at
                and timezone.now() > current.finished_at + timedelta(seconds=60)
            )
            current.agent_done = bool(
                remote_terminal and (meter["complete"] or grace_over)
            )
            current.agent_deployment = (
                value.get("deployment") or current.agent_deployment
            )
            current.lease_until = None
            current.save()
    except (AgentBoundaryError, MaterialError) as exc:
        with transaction.atomic():
            current = WorkRun.objects.select_for_update().get(pk=run.pk)
            if current.agent_generation != run.agent_generation:
                return
            # Transport ambiguity stays recoverable with the same run ID.
            transient = exc.code in {
                "agent_transport_unknown",
                "agent_http_429",
                "agent_http_500",
                "agent_http_502",
                "agent_http_503",
                "agent_http_504",
            }
            if not transient and current.status in runs.ACTIVE:
                runs.terminal(
                    current,
                    "failed",
                    "agent_contract_mismatch"
                    if exc.code == "agent_contract_mismatch"
                    else "agent_unavailable",
                )
            if exc.code == "agent_http_404" and current.status not in runs.ACTIVE:
                # Could race an earlier admission. Keep cancellation pending after submission.
                current.agent_done = not bool(current.call_started_at)
            current.lease_until = timezone.now() + timedelta(seconds=15)
            current.save()


def process_agent_runs(limit=3):
    """Bounded outbox pass, including cancellation reconciliation when disabled."""
    seen = []
    for _ in range(limit):
        run = claim(seen)
        if not run:
            break
        seen.append(run.pk)
        reconcile(run)
    return len(seen)
