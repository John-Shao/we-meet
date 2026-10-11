"""Explicit paid capture attribution with account, source and revision fences."""

from django.core.exceptions import ValidationError as ModelValidationError
from django.db import IntegrityError

from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from core import models
from core.api.meeting_command_receipt import MeetingCommandReceiptMixin
from core.api.voiceprint import PrivateVoiceprintView, StrictSerializer, StrictVersion
from core.services import capture_diarization as control
from core.services import capture_diarization_commands as commands
from core.services import capture_diarization_worker as worker
from core.services.meeting_captures import CaptureDenied
from core.services.meeting_records import RecordConflict


class Submission(StrictSerializer):
    expected_revision = StrictVersion(min_value=1)


class SubmissionThrottle(UserRateThrottle):
    scope = "capture_diarization_request"
    rate = "6/min"


class CaptureDiarizationView(MeetingCommandReceiptMixin, PrivateVoiceprintView):
    http_method_names = ["get", "post", "options"]

    def get_throttles(self):
        return [SubmissionThrottle()] if self.request.method == "POST" else []

    def handle_exception(self, exc):
        if isinstance(
            exc,
            (
                models.CaptureSession.DoesNotExist,
                models.CaptureDiarizationJob.DoesNotExist,
            ),
        ):
            return Response(status=404)
        if isinstance(exc, CaptureDenied):
            return Response(status=403)
        if isinstance(exc, (RecordConflict, IntegrityError, ModelValidationError)):
            return Response({"code": "capture_diarization_conflict"}, status=409)
        return super().handle_exception(exc)

    def get(self, request, capture_id):
        if request.query_params:
            return Response(status=400)
        return Response(commands.state(capture_id, request.user))

    def post(self, request, capture_id):
        commands.capture_for(capture_id, request.user)
        payload = Submission(data=request.data)
        payload.is_valid(raise_exception=True)
        key = serializers.UUIDField().run_validation(
            request.headers.get("Idempotency-Key")
        )
        # Known command receipts stay readable after paid execution is disabled.
        known = models.CaptureDiarizationJob.objects.filter(
            requested_by=request.user, key=key
        ).exists()
        if not known and not worker.enabled():
            return Response({"code": "capture_diarization_unavailable"}, status=503)
        job, created = control.prepare(
            capture_id, request.user, key, **payload.validated_data
        )
        return Response(
            {"job": commands.serialize(job), "created": created},
            status=201 if created else 200,
        )


class CancelCaptureDiarizationView(CaptureDiarizationView):
    http_method_names = ["post", "options"]

    def get_throttles(self):
        return []

    def post(self, request, capture_id, job_id):
        capture = commands.capture_for(capture_id, request.user)
        if not capture.diarization_jobs.filter(pk=job_id).exists():
            return Response(status=404)
        payload = Submission(data=request.data)
        payload.is_valid(raise_exception=True)
        return Response(
            {
                "job": commands.serialize(
                    commands.cancel(job_id, request.user, **payload.validated_data)
                )
            }
        )
