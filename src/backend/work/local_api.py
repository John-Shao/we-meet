"""Versioned native device coordination without local paths or SDK objects."""

import re

from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from . import local_runs
from .api import WorkUser
from .services import MaterialError
from .task_api import SourceInput, run_data, task_data


class StrictInput(serializers.Serializer):
    def to_internal_value(self, data):
        if not isinstance(data, dict) or set(data) - set(self.fields):
            raise serializers.ValidationError({"code": "invalid_local_request"})
        return super().to_internal_value(data)


class DeviceInput(StrictInput):
    device_id = serializers.UUIDField()
    name = serializers.CharField(max_length=80)


class AdmissionInput(StrictInput):
    run_id = serializers.UUIDField()
    device_id = serializers.UUIDField()
    goal = serializers.CharField(max_length=2000)
    model = serializers.RegexField(r"^[A-Za-z0-9._-]{1,80}$")
    workspace_label = serializers.CharField(max_length=120)
    sources = SourceInput(many=True, max_length=10, default=list)

    def validate_sources(self, value):
        if len({v["id"] for v in value}) != len(value):
            raise serializers.ValidationError("duplicate_source")
        return [{**v, "id": str(v["id"])} for v in value]


class ClaimInput(StrictInput):
    device_id = serializers.UUIDField()


class ManifestInput(StrictInput):
    name = serializers.CharField(max_length=120)
    sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    bytes = serializers.IntegerField(min_value=0, max_value=400000)

    def validate_name(self, value):
        if not re.fullmatch(r"[\w-][\w .-]{0,99}\.(?:md|txt|csv|json)", value):
            raise serializers.ValidationError("invalid_filename")
        stem = value.split(".")[0].upper().rstrip(" ")
        if stem in {"CON", "PRN", "AUX", "NUL"} or re.fullmatch(
            r"(?:COM|LPT)[0-9]", stem
        ):
            raise serializers.ValidationError("invalid_filename")
        return value


class FileInput(ManifestInput):
    bytes = None
    text = serializers.CharField(
        max_length=400000, allow_blank=True, trim_whitespace=False
    )


class ReportInput(StrictInput):
    device_id = serializers.UUIDField()
    ticket = serializers.RegexField(r"^[a-f0-9]{64}$")
    seq = serializers.IntegerField(min_value=1, max_value=1000000000)
    state = serializers.ChoiceField(
        choices=["queued", "running", "succeeded", "failed", "cancelled"]
    )
    deployment = serializers.JSONField()
    metering = serializers.JSONField()
    error_code = serializers.RegexField(r"^[a-z_]{0,40}$", default="", allow_blank=True)
    artifacts = ManifestInput(many=True, max_length=20, default=list)

    def validate_artifacts(self, value):
        if (
            len({v["name"].casefold() for v in value}) != len(value)
            or sum(v["bytes"] for v in value) > 400000
        ):
            raise serializers.ValidationError("invalid_artifacts")
        return value

    def validate_deployment(self, value):
        if (
            not isinstance(value, dict)
            or set(value)
            != {"contract", "engine", "model", "runtime_version", "adapter_version"}
            or any(not isinstance(v, str) or len(v) > 100 for v in value.values())
        ):
            raise serializers.ValidationError("invalid_deployment")
        return value


class SyncInput(ClaimInput):
    ticket = serializers.RegexField(r"^[a-f0-9]{64}$")
    files = FileInput(many=True, min_length=1, max_length=20)

    def validate_files(self, value):
        if (
            len({v["name"].casefold() for v in value}) != len(value)
            or sum(len(v["text"].encode()) for v in value) > 400000
        ):
            raise serializers.ValidationError("invalid_artifacts")
        return value


class DeviceView(APIView):
    permission_classes = [WorkUser]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    def handle_exception(self, exc):
        if isinstance(exc, MaterialError):
            return Response({"code": exc.code}, status=exc.status)
        return super().handle_exception(exc)

    def post(self, request):
        if not local_runs.enabled(request.user):
            raise MaterialError("local_coordination_disabled", 503)
        form = DeviceInput(data=request.data)
        form.is_valid(raise_exception=True)
        device = local_runs.register(
            request.user, form.validated_data["device_id"], form.validated_data["name"]
        )
        return Response({"contract": local_runs.CONTRACT, "device_id": str(device.pk)})


class LocalAdmissionView(DeviceView):
    def post(self, request):
        form = AdmissionInput(data=request.data)
        form.is_valid(raise_exception=True)
        run, created = local_runs.admit(request.user, form.validated_data)
        return Response(
            {
                "contract": local_runs.CONTRACT,
                "task": task_data(run.task, True),
                "run": run_data(run),
            },
            status=201 if created else 200,
        )


class LocalRunView(DeviceView):
    operation = "claim"

    def post(self, request, pk):
        form_class = {"claim": ClaimInput, "report": ReportInput, "sync": SyncInput}[
            self.operation
        ]
        form = form_class(data=request.data)
        form.is_valid(raise_exception=True)
        data = form.validated_data
        if self.operation == "claim":
            value = local_runs.claim(request.user, pk, data["device_id"])
        elif self.operation == "report":
            value = local_runs.report(request.user, pk, data)
        else:
            value = local_runs.sync_files(request.user, pk, data)
        return Response(value)
