"""Opt-in independent capture protocol; no audio upload or ASR is implied."""

from django.core.exceptions import ValidationError as ModelValidationError
from django.db import IntegrityError
from django.http import Http404

from rest_framework import permissions, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.api.agent_internal import AgentTokenAuthentication, HasAgentToken
from core.services.meeting_captures import (
    GRANT_MAX_AGE,
    CaptureDenied,
    capture_state,
    captures_enabled,
    command_capture,
    create_capture,
    ingest_original,
    issue_writer_grant,
)
from core.services.meeting_records import RecordConflict, visible_records


class StrictSerializer(serializers.Serializer):
    """Reject fields that imply unsupported tenant, identity or media control."""

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise ValidationError("Unsupported capture field.")
        return attrs


class CreateCaptureSerializer(StrictSerializer):
    """A randomly generated device lease is distinct from its display identifier."""

    device_id = serializers.CharField(max_length=128)
    lease_key = serializers.UUIDField()
    title = serializers.CharField(max_length=500, default="", allow_blank=True)
    retention_mode = serializers.ChoiceField(choices=["media", "text"])

    def validate_lease_key(self, value):
        """Require a random UUID, not a timestamp-derived identifier."""
        if value.version != 4:
            raise ValidationError("Generate a random UUID v4 for the lease.")
        return str(value)


class CaptureCommandSerializer(StrictSerializer):
    """Explicit device command against the last observed control revision."""

    command = serializers.ChoiceField(
        choices=["start", "pause", "resume", "interrupt", "stop", "finalize"]
    )
    device_id = serializers.CharField(max_length=128)
    expected_revision = serializers.IntegerField(min_value=1)


class CaptureThrottle(UserRateThrottle):
    """Control commands only; status/receipt polling has no extra write throttle."""

    scope = "meeting_capture_commands"
    rate = "60/min"


class CaptureProtocolMixin:
    """Fail closed and prevent browser/proxy caching of leases or original text."""

    def initial(self, request, *args, **kwargs):
        if not captures_enabled():
            raise Http404
        return super().initial(request, *args, **kwargs)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response


def conflict_response():
    return Response(
        {
            "code": "capture_conflict",
            "message": "Refresh capture state and acknowledged receipts before retrying.",
        },
        status=409,
    )


def operation_response(operation, replay, *, status):
    """Return both the historical receipt and current state after a replay."""
    operation.capture.refresh_from_db()
    return Response(
        {
            "operation_id": str(operation.pk),
            "replayed": replay,
            "result": operation.result,
            "capture": capture_state(operation.capture),
        },
        status=status,
    )


class CaptureSessionViewSet(CaptureProtocolMixin, viewsets.GenericViewSet):
    """Only the current capture creator can inspect device state or control it."""

    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return models.CaptureSession.objects.filter(
            created_by=self.request.user,
            record_id__in=visible_records(self.request.user, ability="read_transcript")
            .filter(owner=self.request.user)
            .values("pk"),
        )

    def get_throttles(self):
        return (
            [CaptureThrottle()]
            if self.request.method == "POST"
            else super().get_throttles()
        )

    def create(self, request):
        """Preparing means metadata exists; the microphone has not been opened."""
        serializer = CreateCaptureSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        key = serializers.UUIDField().run_validation(
            request.headers.get("Idempotency-Key")
        )
        try:
            operation, replay = create_capture(
                request.user, key, serializer.validated_data
            )
        except CaptureDenied as exc:
            raise PermissionDenied("Capture creation is not authorized.") from exc
        except (RecordConflict, IntegrityError, ModelValidationError):
            return conflict_response()
        return operation_response(operation, replay, status=200 if replay else 201)

    def retrieve(self, request, pk=None):
        return Response(capture_state(self.get_object()))

    @action(detail=True, methods=["post"])
    def commands(self, request, pk=None):
        capture = self.get_object()
        serializer = CaptureCommandSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        key = serializers.UUIDField().run_validation(
            request.headers.get("Idempotency-Key")
        )
        lease = serializers.UUIDField().run_validation(
            request.headers.get("X-Capture-Lease")
        )
        try:
            operation, replay = command_capture(
                capture.pk, request.user, key, lease, serializer.validated_data
            )
        except CaptureDenied as exc:
            raise PermissionDenied(
                "Current capture ownership and device lease are required."
            ) from exc
        except (RecordConflict, IntegrityError, ModelValidationError):
            return conflict_response()
        return operation_response(operation, replay, status=200)

    @action(detail=True, methods=["get"], url_path="transcript-receipts")
    def transcript_receipts(self, request, pk=None):
        """Bounded receipt recovery by source sequence; contains no transcript text."""
        capture = self.get_object()
        track = serializers.CharField(max_length=128).run_validation(
            request.query_params.get("source_track_id")
        )
        after = serializers.IntegerField(min_value=0, max_value=100000).run_validation(
            request.query_params.get("after_sequence", 0)
        )
        rows = list(
            capture.original_segments.filter(
                source_track_id=track, source_sequence__gt=after
            )
            .order_by("source_sequence")
            .values("id", "ingest_id", "source_sequence")[:201]
        )
        return Response(
            {
                "results": rows[:200],
                "next_after_sequence": rows[199]["source_sequence"]
                if len(rows) > 200
                else None,
                "coverage_status": "unverified",
            }
        )


class WriterGrantSerializer(StrictSerializer):
    """The trusted gateway must prove the end user's device lease."""

    capture_id = serializers.UUIDField()
    device_id = serializers.CharField(max_length=128)
    lease_key = serializers.UUIDField()
    expected_revision = serializers.IntegerField(min_value=1)
    source_track_id = serializers.CharField(max_length=128)


class OriginalIngestSerializer(StrictSerializer):
    """Only bounded final text with explicit source and monotonic offsets."""

    record_id = serializers.UUIDField()
    capture_id = serializers.UUIDField()
    ingest_id = serializers.UUIDField()
    source_track_id = serializers.CharField(max_length=128)
    source_sequence = serializers.IntegerField(min_value=1, max_value=100000)
    start_ms = serializers.IntegerField(min_value=0, max_value=604800000)
    end_ms = serializers.IntegerField(min_value=0, max_value=604800000, allow_null=True)
    speaker_key = serializers.CharField(max_length=128)
    speaker_label = serializers.CharField(max_length=128)
    identity_type = serializers.ChoiceField(choices=["diarized", "unknown"])
    text = serializers.CharField(max_length=20000, trim_whitespace=False)
    language = serializers.CharField(max_length=16, allow_blank=True)
    final = serializers.BooleanField()

    def validate(self, attrs):
        super().validate(attrs)
        if not attrs["final"] or not attrs["text"].strip():
            raise ValidationError("Only non-empty final text is accepted.")
        if attrs["end_ms"] is not None and attrs["end_ms"] < attrs["start_ms"]:
            raise ValidationError("End offset precedes start offset.")
        return attrs


class CaptureAgentView(CaptureProtocolMixin, APIView):
    """Internal credential is mandatory even when a signed grant is provided."""

    authentication_classes = [AgentTokenAuthentication]
    permission_classes = [HasAgentToken]

    def handle_exception(self, exc):
        if isinstance(exc, CaptureDenied):
            return Response({"code": "capture_writer_denied"}, status=403)
        if isinstance(
            exc, (models.CaptureSession.DoesNotExist, models.MeetingRecord.DoesNotExist)
        ):
            return Response(status=404)
        if isinstance(exc, (RecordConflict, IntegrityError, ModelValidationError)):
            return conflict_response()
        return super().handle_exception(exc)


class CaptureWriterGrantView(CaptureAgentView):
    """Scope a gateway to one capture, source track and current control revision."""

    def post(self, request):
        serializer = WriterGrantSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        token = issue_writer_grant(serializer.validated_data)
        return Response({"writer_grant": token, "expires_in": GRANT_MAX_AGE})


class IngestRecordOriginalView(CaptureAgentView):
    """Original text writes never use the legacy Room-based transcript endpoint."""

    def post(self, request):
        serializer = OriginalIngestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        token = serializers.CharField(max_length=4096).run_validation(
            request.headers.get("X-Capture-Writer")
        )
        segment, created = ingest_original(token, serializer.validated_data)
        return Response(
            {
                "id": str(segment.pk),
                "ingest_id": str(segment.ingest_id),
                "created": created,
            },
            status=201 if created else 200,
        )
