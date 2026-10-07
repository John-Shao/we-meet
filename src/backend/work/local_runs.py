"""One account-bound device per run; expired assignments are never replayed."""

import hashlib
import hmac
import json
from datetime import timedelta

from django.conf import settings
from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone

from core.models import User

from . import agent_runs, rollout, runs
from .models import WorkArtifactFile, WorkArtifactVersion, WorkDevice, WorkRun, WorkTask
from .services import MaterialError, organization_for

CONTRACT = "work-device/v1"
FINAL = {"succeeded", "failed", "canceled"}


def encoded(body):
    return json.dumps(
        body, sort_keys=True, ensure_ascii=False, cls=DjangoJSONEncoder
    ).encode()


def enabled(user):
    return bool(
        settings.WORK_ENABLED
        and settings.WORK_LOCAL_AGENT_ENABLED
        and rollout.allows(user)
    )


def device_for(user, identifier):
    return get_object_or_404(
        WorkDevice, id=identifier, owner=user, organization_id=organization_for(user)
    )


@transaction.atomic
def register(user, identifier, name):
    if not enabled(user):
        raise MaterialError("local_coordination_disabled", 503)
    User.objects.select_for_update().get(pk=user.pk)
    device = WorkDevice.objects.filter(pk=identifier).first()
    organization = organization_for(user)
    if device and (
        device.owner_id != user.pk or device.organization_id != organization
    ):
        raise MaterialError("device_unavailable", 409)
    if not device:
        device = WorkDevice(id=identifier, owner=user, organization_id=organization)
    device.name = name
    device.save()
    return device


@transaction.atomic
def admit(user, data, *, workspace=None):
    if not enabled(user):
        raise MaterialError("local_coordination_disabled", 503)
    User.objects.select_for_update().get(pk=user.pk)
    device = device_for(user, data["device_id"])
    previous = WorkRun.objects.filter(pk=data["run_id"]).select_related("task").first()
    frozen = {
        "goal": data["goal"],
        "sources": data["sources"],
        "model": data["model"],
        "workspace_label": data["workspace_label"],
    }
    if workspace:
        frozen.update(workspace_id=str(workspace.pk), remote_requested=True)
    if previous:
        if (
            previous.task.owner_id != user.pk
            or previous.task.organization_id != organization_for(user)
            or previous.device_id != device.pk
            or previous.execution_target != "local"
            or previous.agent_payload.get("admission") != frozen
        ):
            raise MaterialError("idempotency_conflict", 409)
        return previous, False
    if WorkTask.objects.filter(owner=user, request_key=data["run_id"]).exists():
        raise MaterialError("idempotency_conflict", 409)
    if data["model"] != settings.WORK_AGENT_MODEL:
        raise MaterialError("local_model_unavailable", 409)
    budget = min(settings.WORK_AGENT_TOKEN_BUDGET, 80000)
    used = runs.daily_reserved(user.pk)
    if used + budget > settings.WORK_DAILY_TOKEN_BUDGET:
        raise MaterialError("budget_exceeded", 429)
    task = WorkTask(
        owner=user,
        organization_id=device.organization_id,
        request_key=data["run_id"],
        kind="office_agent",
        recipient="",
        goal=data["goal"],
        sources=data["sources"],
    )
    materials = runs.sources_for(task)
    files = [
        {
            "name": f"source-{m.pk}.md",
            "text": m.text,
            "sha256": hashlib.sha256(m.text.encode()).hexdigest(),
        }
        for m in materials
    ]
    if sum(len(item["text"].encode()) for item in files) > 400000:
        raise MaterialError("context_too_large", 413)
    task.save()
    run = WorkRun.objects.create(
        id=data["run_id"],
        task=task,
        request_key=data["run_id"],
        device=device,
        workspace=workspace,
        remote_requested=workspace is not None,
        execution_target="local",
        workspace_label=data["workspace_label"],
        model=data["model"],
        base_url="",
        executor_version=CONTRACT,
        usage_origin="device_reported",
        reserved_tokens=budget,
        max_output_tokens=min(settings.WORK_MAX_OUTPUT_TOKENS, 4096),
        agent_done=True,
        agent_payload={
            "admission": frozen,
            "files": files,
            "limits": {
                "max_model_calls": min(settings.WORK_AGENT_MAX_CALLS, 6),
                "max_total_tokens": budget,
                "max_output_tokens": min(settings.WORK_MAX_OUTPUT_TOKENS, 4096),
            },
        },
    )
    runs.event(run, "queued")
    return run, True


def ticket(run):
    # Stable across lost claim ACKs; not stored in clear text or returned by Work reads.
    message = f"{CONTRACT}:{run.pk}:{run.device_id}:1".encode()
    return hmac.new(settings.SECRET_KEY.encode(), message, hashlib.sha256).hexdigest()


def locked(user, identifier, device_id):
    device_for(user, device_id)
    return get_object_or_404(
        WorkRun.objects.select_for_update().select_related("task"),
        pk=identifier,
        device_id=device_id,
        execution_target="local",
        task__in=runs.visible_tasks(user),
    )


def control(run):
    return {
        "contract": CONTRACT,
        "task_id": str(run.task_id),
        "run_id": str(run.pk),
        "status": run.status,
        "cancel": run.status in {"canceled", "failed"},
        "report_seq": run.local_report_seq,
        "uploaded_files": list(run.files.values_list("name", flat=True)),
    }


@transaction.atomic
def claim(user, identifier, device_id):
    run = locked(user, identifier, device_id)
    if not enabled(user) or run.status in FINAL:
        raise MaterialError("local_assignment_closed", 409)
    if run.remote_requested and (
        not settings.WORK_REMOTE_AGENT_ENABLED or not run.workspace.enabled
    ):
        raise MaterialError("workspace_permission_required", 409)
    runs.sources_for(run.task)
    # A disconnected assignment can be reconciled only by its original device;
    # admission is never replayed automatically, even if claim is retried.
    run.local_claimed = True
    WorkDevice.objects.filter(pk=run.device_id).update(last_seen_at=timezone.now())
    run.lease_until = timezone.now() + timedelta(seconds=90)
    run.save(update_fields=["local_claimed", "lease_until"])
    return {
        **control(run),
        "ticket": ticket(run),
        "goal": run.task.goal,
        "files": run.agent_payload["files"],
        "limits": run.agent_payload["limits"],
        "model": run.model,
        "workspace_id": str(run.workspace_id) if run.workspace_id else None,
    }


@transaction.atomic
def report(user, identifier, data):  # noqa: PLR0912 -- fenced device state machine
    run = locked(user, identifier, data["device_id"])
    if not run.local_claimed or not hmac.compare_digest(ticket(run), data["ticket"]):
        raise MaterialError("local_assignment_invalid", 403)
    fingerprint = hashlib.sha256(encoded(data)).hexdigest()
    if data["seq"] <= run.local_report_seq:
        if data["seq"] != run.local_report_seq or fingerprint != run.local_report_hash:
            raise MaterialError("local_report_conflict", 409)
        return control(run)
    if data["seq"] != run.local_report_seq + 1:
        raise MaterialError("local_report_gap", 409)
    deployment = data["deployment"]
    if (
        deployment.get("contract") != "work-local/v1"
        or deployment.get("engine") != "dsh"
        or deployment.get("model") != run.model
    ):
        raise MaterialError("local_contract_mismatch", 409)
    if run.agent_deployment and run.agent_deployment != deployment:
        raise MaterialError("local_deployment_changed", 409)
    meter = agent_runs.validate_metering(data)
    if meter["calls"] > run.agent_payload["limits"]["max_model_calls"]:
        raise MaterialError("invalid_local_usage")
    if meter["usage"] and sum(meter["usage"].values()) > run.reserved_tokens:
        raise MaterialError("invalid_local_usage")
    previous = run.agent_metering
    if previous and (
        meter["calls"] < previous["calls"]
        or (
            previous["complete"]
            and meter["calls"] == previous["calls"]
            and meter != previous
        )
    ):
        raise MaterialError("local_usage_conflict", 409)
    run.agent_metering = meter
    if meter["complete"] and meter["usage"] is not None:
        run.input_tokens = sum(
            v for k, v in meter["usage"].items() if k != "output_tokens"
        )
        run.output_tokens = meter["usage"]["output_tokens"]
    # Device reports remain labelled; never masquerade as provider billing records.
    run.agent_deployment = deployment
    WorkDevice.objects.filter(pk=run.device_id).update(last_seen_at=timezone.now())
    run.local_report_seq = data["seq"]
    run.local_report_hash = fingerprint
    run.lease_until = timezone.now() + timedelta(seconds=90)
    if run.status not in FINAL:
        try:
            runs.sources_for(run.task)
            if not enabled(user):
                raise MaterialError("local_coordination_disabled")
        except MaterialError as exc:
            runs.terminal(run, "failed", exc.code)
        else:
            state = {"cancelled": "canceled"}.get(data["state"], data["state"])
            if run.status == "running" and state == "queued":
                raise MaterialError("local_state_regression", 409)
            if state in FINAL:
                run.artifact_manifest = (
                    data["artifacts"] if state == "succeeded" else []
                )
                runs.terminal(run, state, data["error_code"])
            elif run.status != state:
                run.status = state
                run.error_code = ""
                runs.event(run, state)
    run.save()
    return control(run)


@transaction.atomic
def sync_files(user, identifier, data):
    run = locked(user, identifier, data["device_id"])
    if not hmac.compare_digest(ticket(run), data["ticket"]):
        raise MaterialError("local_assignment_invalid", 403)
    runs.sources_for(run.task)
    if run.status != "succeeded":
        raise MaterialError("artifact_not_ready", 409)
    manifest = {item["name"]: item for item in run.artifact_manifest}
    changed = False
    for item in data["files"]:
        raw = item["text"].encode()
        expected = manifest.get(item["name"])
        if (
            not expected
            or expected["sha256"] != item["sha256"]
            or expected["bytes"] != len(raw)
            or hashlib.sha256(raw).hexdigest() != item["sha256"]
        ):
            raise MaterialError("artifact_changed", 409)
        existing, created = WorkArtifactFile.objects.get_or_create(
            run=run,
            name=item["name"],
            defaults={"text": item["text"], "sha256": item["sha256"]},
        )
        if not created and (
            existing.sha256 != item["sha256"] or existing.text != item["text"]
        ):
            raise MaterialError("artifact_changed", 409)
        changed = changed or created
    if not run.versions.exists():
        from .executor import MAX_ARTIFACT_CHARS  # noqa: PLC0415

        body = next(
            (
                f["text"]
                for f in data["files"]
                if f["name"].endswith(".md") and len(f["text"]) <= MAX_ARTIFACT_CHARS
            ),
            "# Local deliverables\n\n"
            + "\n".join(f"- {f['name']}" for f in data["files"]),
        )
        WorkArtifactVersion.objects.create(run=run, version=1, body=body, citations=[])
    if changed:
        runs.event(run, "local_files_synced")
    return control(run)


@transaction.atomic
def expire_runs(user=None):
    query = WorkRun.objects.select_for_update(skip_locked=True).filter(
        execution_target="local",
        local_claimed=True,
        status__in=runs.ACTIVE,
        lease_until__lt=timezone.now(),
    )
    if user:
        query = query.filter(task__in=runs.visible_tasks(user))
    for run in query[:100]:
        run.status = "disconnected"
        run.error_code = "local_device_disconnected"
        run.save(update_fields=["status", "error_code"])
        runs.event(run, "disconnected")
