"""Android submits requests; the original desktop explicitly takes each task."""

from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone

from rest_framework import serializers
from rest_framework.response import Response

from core.models import User

from . import local_runs, runs
from .local_api import DeviceView, StrictInput
from .models import WorkDevice, WorkRun, WorkWorkspace
from .services import MaterialError, organization_for
from .task_api import run_data, task_data


def enabled():
    return local_runs.enabled() and settings.WORK_REMOTE_AGENT_ENABLED


def ensure_enabled():
    if not enabled():
        raise MaterialError("remote_coordination_disabled", 503)


def workspaces(user):
    return WorkWorkspace.objects.filter(
        device__owner=user, device__organization_id=organization_for(user)
    )


def workspace_data(w):
    return {
        "id": str(w.pk),
        "device_id": str(w.device_id),
        "device_name": w.device.name,
        "label": w.label,
        "model": w.model,
        "enabled": w.enabled,
        "online": w.last_seen_at >= timezone.now() - timedelta(seconds=30),
    }


class WorkspaceInput(StrictInput):
    device_id = serializers.UUIDField()
    workspace_id = serializers.UUIDField()
    label = serializers.CharField(max_length=120)
    model = serializers.RegexField(r"^[A-Za-z0-9._-]{1,80}$")
    enabled = serializers.BooleanField()


class RemoteTaskInput(StrictInput):
    run_id = serializers.UUIDField()
    workspace_id = serializers.UUIDField()
    goal = serializers.CharField(max_length=2000)


class InboxInput(StrictInput):
    device_id = serializers.UUIDField()
    workspace_ids = serializers.ListField(child=serializers.UUIDField(), max_length=20)


class WorkspaceView(DeviceView):
    def get(self, request):
        ensure_enabled()
        return Response(
            {
                "contract": local_runs.CONTRACT,
                "workspaces": [
                    workspace_data(w)
                    for w in workspaces(request.user)
                    .select_related("device")
                    .order_by("label")[:100]
                ],
            }
        )

    @transaction.atomic
    def post(self, request):
        ensure_enabled()
        form = WorkspaceInput(data=request.data)
        form.is_valid(raise_exception=True)
        data = form.validated_data
        User.objects.select_for_update().get(pk=request.user.pk)
        device = local_runs.device_for(request.user, data["device_id"])
        w = WorkWorkspace.objects.filter(pk=data["workspace_id"]).first()
        if w and w.device_id != device.pk:
            raise MaterialError("workspace_unavailable", 409)
        if data["model"] != settings.WORK_AGENT_MODEL:
            raise MaterialError("local_model_unavailable", 409)
        if not w:
            if workspaces(request.user).count() >= 100:
                raise MaterialError("workspace_limit", 429)
            w = WorkWorkspace(id=data["workspace_id"], device=device)
        w.label, w.model, w.enabled, w.last_seen_at = (
            data["label"],
            data["model"],
            data["enabled"],
            timezone.now(),
        )
        w.save()
        if not w.enabled:
            for run in (
                WorkRun.objects.select_for_update()
                .filter(workspace=w, remote_requested=True)
                .exclude(status__in=local_runs.FINAL)
            ):
                runs.terminal(run, "canceled", "workspace_permission_required")
        return Response(
            {"contract": local_runs.CONTRACT, "workspace": workspace_data(w)}
        )


class RemoteTaskView(DeviceView):
    @transaction.atomic
    def post(self, request):
        ensure_enabled()
        form = RemoteTaskInput(data=request.data)
        form.is_valid(raise_exception=True)
        data = form.validated_data
        User.objects.select_for_update().get(pk=request.user.pk)
        w = get_object_or_404(workspaces(request.user), pk=data["workspace_id"])
        previous = (
            WorkRun.objects.filter(pk=data["run_id"]).select_related("task").first()
        )
        if previous:
            if (
                previous.task.owner_id != request.user.pk
                or previous.task.organization_id != organization_for(request.user)
                or previous.workspace_id != w.pk
                or not previous.remote_requested
                or previous.task.goal != data["goal"]
            ):
                raise MaterialError("idempotency_conflict", 409)
            return Response(
                {
                    "contract": local_runs.CONTRACT,
                    "task": task_data(previous.task, True),
                    "run": run_data(previous),
                }
            )
        if not w.enabled:
            raise MaterialError("workspace_permission_required", 409)
        # An offline alias can receive a queued request. Only its original desktop
        # may claim it after fresh native folder consent and explicit task review.
        run, created = local_runs.admit(
            request.user,
            {
                "run_id": data["run_id"],
                "device_id": w.device_id,
                "goal": data["goal"],
                "model": w.model,
                "workspace_label": w.label,
                "sources": [],
            },
            workspace=w,
        )
        return Response(
            {
                "contract": local_runs.CONTRACT,
                "task": task_data(run.task, True),
                "run": run_data(run),
            },
            status=201 if created else 200,
        )


class InboxView(DeviceView):
    def post(self, request):
        ensure_enabled()
        form = InboxInput(data=request.data)
        form.is_valid(raise_exception=True)
        data = form.validated_data
        device = local_runs.device_for(request.user, data["device_id"])
        eligible = workspaces(request.user).filter(
            device=device, enabled=True, pk__in=data["workspace_ids"]
        )
        eligible.update(last_seen_at=timezone.now())
        WorkDevice.objects.filter(pk=device.pk).update(last_seen_at=timezone.now())
        pending = WorkRun.objects.filter(
            task__in=runs.visible_tasks(request.user),
            device=device,
            workspace__in=eligible,
            remote_requested=True,
            local_claimed=False,
            status="queued",
        ).select_related("task")
        return Response(
            {
                "contract": local_runs.CONTRACT,
                "pending": [
                    {
                        "run_id": str(r.pk),
                        "task_id": str(r.task_id),
                        "workspace_id": str(r.workspace_id),
                        "workspace_label": r.workspace_label,
                        "goal": r.task.goal,
                        "model": r.model,
                    }
                    for r in pending.order_by("created_at", "id")[:20]
                ],
            }
        )
