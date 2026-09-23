"""Task, ordered progress and versioned private artifact endpoints."""

from django.db import transaction
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone

from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from core.models import User

from . import runs
from .api import MaterialPagination, MaterialViewSet, WorkUser
from .executor import MAX_ARTIFACT_CHARS
from .models import WorkArtifactVersion, WorkRun
from .services import MaterialError


class SourceInput(serializers.Serializer):
    id = serializers.UUIDField()
    checksum = serializers.RegexField("^[a-f0-9]{64}$")
    parser_version = serializers.CharField(max_length=40)
    generation = serializers.IntegerField(min_value=1)


class TaskInput(serializers.Serializer):
    recipient = serializers.CharField(max_length=200)
    goal = serializers.CharField(max_length=2000)
    background = serializers.CharField(max_length=4000, allow_blank=True, default="")
    sources = SourceInput(many=True, min_length=1, max_length=10)

    def validate_sources(self, value):
        if len({item["id"] for item in value}) != len(value):
            raise serializers.ValidationError("duplicate_source")
        return [{**item, "id": str(item["id"])} for item in value]


class ArtifactInput(serializers.Serializer):
    base_version = serializers.IntegerField(min_value=1)
    body = serializers.CharField(max_length=MAX_ARTIFACT_CHARS, trim_whitespace=False)


def run_data(run):
    return {
        "id": str(run.pk),
        "status": run.status,
        "error_code": run.error_code,
        "model": run.model,
        "executor_version": run.executor_version,
        "reserved_tokens": run.reserved_tokens,
        "input_tokens": run.input_tokens,
        "output_tokens": run.output_tokens,
        "created_at": run.created_at,
        "finished_at": run.finished_at,
    }


def task_data(task, detail=False):
    data = {
        "id": str(task.pk),
        "recipient": task.recipient,
        "goal": task.goal,
        "created_at": task.created_at,
        "runs": [run_data(run) for run in task.runs.all()],
    }
    if detail:
        data.update(background=task.background, sources=task.sources)
    return data


def artifact_data(version):
    return {
        "version": version.version,
        "body": version.body,
        "citations": version.citations,
        "origin": version.origin,
        "adopted_at": version.adopted_at,
        "created_at": version.created_at,
    }


class TaskViewSet(viewsets.GenericViewSet):
    """All reads scoped to owner/current org; no public download URLs."""

    permission_classes = [WorkUser]
    pagination_class = MaterialPagination

    def get_queryset(self):
        return runs.visible_tasks(self.request.user).prefetch_related("runs")

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    def handle_exception(self, exc):
        if isinstance(exc, MaterialError):
            return Response({"code": exc.code}, status=exc.status)
        return super().handle_exception(exc)

    def list(self, request):
        page = self.paginate_queryset(self.get_queryset())
        return self.get_paginated_response([task_data(task) for task in page])

    def create(self, request):
        form = TaskInput(data=request.data)
        form.is_valid(raise_exception=True)
        task, created = runs.create_task(
            request.user, form.validated_data, MaterialViewSet.request_key(request)
        )
        return Response(task_data(task, True), status=201 if created else 200)

    def retrieve(self, request, pk=None):
        return Response(task_data(self.get_object(), True))

    @action(detail=True, methods=["post"])
    def retry(self, request, pk=None):
        key = MaterialViewSet.request_key(request)
        with transaction.atomic():
            User.objects.select_for_update().get(pk=request.user.pk)
            task = get_object_or_404(self.get_queryset().select_for_update(), pk=pk)
            run = runs.new_run(task, key)
        return Response(run_data(run), status=202)


class RunViewSet(TaskViewSet):
    """Run endpoints validate task ownership and source permission on delivery."""

    def get_queryset(self):
        return WorkRun.objects.filter(task__in=runs.visible_tasks(self.request.user))

    @action(detail=True, methods=["get"])
    def events(self, request, pk=None):
        run = self.get_object()
        try:
            after = int(request.query_params.get("after", "0"))
            if after < 0:
                raise ValueError
        except ValueError:
            return Response({"code": "invalid_sequence"}, status=400)
        entries = list(
            run.events.filter(seq__gt=after).values("seq", "type", "created_at")[:100]
        )
        return Response(
            {
                "run": run_data(run),
                "events": entries,
                "next_after": entries[-1]["seq"] if entries else after,
            }
        )

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        with transaction.atomic():
            run = get_object_or_404(self.get_queryset().select_for_update(), pk=pk)
            if run.status in runs.ACTIVE:
                runs.terminal(run, "canceled")
        return Response(run_data(run))

    @action(detail=True, methods=["get", "post"])
    def artifact(self, request, pk=None):
        with transaction.atomic():
            run = get_object_or_404(self.get_queryset().select_for_update(), pk=pk)
            runs.sources_for(run.task)
            latest = run.versions.last()
            if not latest:
                return Response({"code": "artifact_not_ready"}, status=409)
            if request.method == "POST":
                form = ArtifactInput(data=request.data)
                form.is_valid(raise_exception=True)
                if form.validated_data["base_version"] != latest.version:
                    return Response({"code": "version_conflict"}, status=409)
                if latest.version >= 100:
                    return Response({"code": "artifact_version_limit"}, status=429)
                latest = WorkArtifactVersion.objects.create(
                    run=run,
                    version=latest.version + 1,
                    body=form.validated_data["body"],
                    citations=latest.citations,
                    origin="edited",
                )
            elif request.query_params.get("version"):
                try:
                    number = int(request.query_params["version"])
                except ValueError:
                    return Response({"code": "invalid_version"}, status=400)
                latest = get_object_or_404(run.versions, version=number)
        return Response(artifact_data(latest))

    @action(detail=True, methods=["post"])
    def adopt(self, request, pk=None):
        with transaction.atomic():
            run = get_object_or_404(self.get_queryset().select_for_update(), pk=pk)
            runs.sources_for(run.task)
            version = run.versions.last()
            if not version or request.data.get("version") != version.version:
                return Response({"code": "version_conflict"}, status=409)
            if not version.adopted_at:
                version.adopted_at = timezone.now()
                version.save(update_fields=["adopted_at"])
                runs.event(run, "artifact_adopted")
        return Response(artifact_data(version))

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        run = self.get_object()
        runs.sources_for(run.task)
        try:
            version = int(request.query_params.get("version", "0"))
        except ValueError:
            return Response({"code": "invalid_version"}, status=400)
        artifact = get_object_or_404(run.versions, version=version)
        response = HttpResponse(
            artifact.body, content_type="text/markdown; charset=utf-8"
        )
        response["Content-Disposition"] = (
            f'attachment; filename="communication-{run.pk}-v{version}.md"'
        )
        response["X-Content-Type-Options"] = "nosniff"
        return response
