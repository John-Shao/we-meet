"""Owner ASR controls and worker-scoped input, final-text and execution receipts."""

from django.core.exceptions import ValidationError as ModelValidationError
from django.db import IntegrityError
from django.http import HttpResponse
from django.shortcuts import get_object_or_404

from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.api.agent_internal import AgentTokenAuthentication, HasAgentToken
from core.api.capture_audio import CaptureAudioView
from core.api.meeting_captures import StrictSerializer
from core.services import capture_transcription as service
from core.services.capture_audio import read_verified
from core.services.meeting_captures import CaptureDenied
from core.services.meeting_records import RecordConflict


class SafeErrors:
    """No provider payloads, input object keys or configuration errors reach clients."""

    def handle_exception(self, exc):
        if isinstance(exc, CaptureDenied):
            return Response(status=403)
        if isinstance(exc, (RecordConflict, IntegrityError, ModelValidationError)):
            return Response({"code": "transcription_conflict"}, status=409)
        if isinstance(
            exc,
            (
                models.CaptureTranscriptionJob.DoesNotExist,
                models.CaptureAudioChunk.DoesNotExist,
            ),
        ):
            return Response(status=404)
        return super().handle_exception(exc)


class RequestSerializer(StrictSerializer):
    """New generations and incomplete sources require explicit client intent."""

    expected_job_id = serializers.UUIDField(allow_null=True)
    allow_incomplete = serializers.BooleanField(default=False)


class RequestThrottle(UserRateThrottle):
    """Paid create intent; reads and cancellation have no extra write throttle."""

    scope = "capture_asr_request"
    rate = "6/min"


class CaptureTranscriptionView(SafeErrors, CaptureAudioView):
    """The audio owner alone may spend on a source transcription."""

    def get_throttles(self):
        return [RequestThrottle()] if self.request.method == "POST" else []

    def get(self, request, capture_id):
        capture = self.capture(request, capture_id)
        return Response(service.state(capture.pk, request.user))

    def post(self, request, capture_id):
        capture = self.capture(request, capture_id)
        serializer = RequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = dict(serializer.validated_data)
        payload["expected_job_id"] = (
            str(payload["expected_job_id"]) if payload["expected_job_id"] else None
        )
        key = serializers.UUIDField().run_validation(
            request.headers.get("Idempotency-Key")
        )
        job, created = service.prepare(capture.pk, request.user, key, payload)
        return Response(
            {"job": service.serialize(job), "created": created},
            status=201 if created else 200,
        )


class CancelTranscriptionView(SafeErrors, CaptureAudioView):
    """A known job can be canceled after new-creation switches are disabled."""

    http_method_names = ["post", "options"]

    def post(self, request, capture_id, job_id):
        capture = self.capture(request, capture_id)
        job = get_object_or_404(capture.transcription_jobs, pk=job_id)
        if request.data:
            return Response(status=400)
        return Response(service.serialize(service.cancel(job.pk, request.user)))


class ClaimSerializer(StrictSerializer):
    """A process identity can claim only compatible model/region work."""

    worker_id = serializers.UUIDField()
    model = serializers.CharField(max_length=128)
    region = serializers.ChoiceField(choices=["cn-beijing", "ap-southeast-1"])


class ControlSerializer(StrictSerializer):
    """Audio acknowledgements refer to a fixed 1-based input index and checksum."""

    worker_id = serializers.UUIDField()
    operation = serializers.ChoiceField(choices=["begin", "heartbeat", "ack_input"])
    index = serializers.IntegerField(min_value=1, max_value=4320, required=False)
    checksum = serializers.RegexField(r"^[a-f0-9]{64}$", required=False)

    def validate(self, attrs):
        super().validate(attrs)
        fields = {"index", "checksum"} & set(attrs)
        if fields != (
            {"index", "checksum"} if attrs["operation"] == "ack_input" else set()
        ):
            raise serializers.ValidationError("Invalid operation fields.")
        return attrs


class FinalSerializer(StrictSerializer):
    """The worker cannot assign a user/speaker, a record or a different source track."""

    worker_id = serializers.UUIDField()
    ingest_id = serializers.UUIDField()
    sequence = serializers.IntegerField(min_value=1, max_value=service.MAX_FINALS)
    start_ms = serializers.IntegerField(min_value=0, max_value=43200000)
    end_ms = serializers.IntegerField(min_value=0, max_value=43200000, allow_null=True)
    text = serializers.CharField(max_length=10000, trim_whitespace=False)
    language = serializers.CharField(max_length=16, allow_blank=True, default="")


class ProviderTaskSerializer(StrictSerializer):
    """Actual provider counters only; missing billing observations stay unknown."""

    task_id = serializers.UUIDField()
    finished = serializers.BooleanField()
    input_samples = serializers.IntegerField(min_value=0, max_value=691200000)
    billed_seconds = serializers.IntegerField(
        min_value=0, max_value=86400, allow_null=True
    )


class FinishSerializer(StrictSerializer):
    """The same final receipt can be retried without publishing or billing twice."""

    worker_id = serializers.UUIDField()
    provider_finished = serializers.BooleanField()
    final_sequence = serializers.IntegerField(min_value=0, max_value=service.MAX_FINALS)
    tasks = ProviderTaskSerializer(many=True, max_length=50)

    def validate(self, attrs):
        super().validate(attrs)
        ids = [item["task_id"] for item in attrs["tasks"]]
        if len(ids) != len(set(ids)):
            raise serializers.ValidationError("Duplicate provider task identity.")
        for item in attrs["tasks"]:
            item["task_id"] = str(item["task_id"])
        return attrs


class TranscriptionAgentView(SafeErrors, APIView):
    """Dedicated worker credential plus immutable worker claim on each job."""

    authentication_classes = [AgentTokenAuthentication]
    permission_classes = [HasAgentToken]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response


class ClaimTranscriptionView(TranscriptionAgentView):
    """Return at most one owned attempt; never return a queue of other users' audio."""

    def post(self, request):
        serializer = ClaimSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response({"job": service.claim(**serializer.validated_data)})


class ControlTranscriptionView(TranscriptionAgentView):
    """One-shot provider begin, heartbeat and ordered input delivery."""

    def post(self, request, job_id):
        serializer = ControlSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        worker = data.pop("worker_id")
        operation = data.pop("operation")
        return Response(service.control(job_id, worker, operation, data))


class TranscriptionInputView(TranscriptionAgentView):
    """Read a verified short WAV only during the caller's live execution lease."""

    def get(self, request, job_id, index):
        worker = serializers.UUIDField().run_validation(
            request.headers.get("X-Worker-ID")
        )
        chunk = service.input_chunk(job_id, worker, index)
        try:
            data = read_verified(chunk)
        except Exception:  # noqa: BLE001 -- storage details remain private
            return Response({"code": "input_audio_unavailable"}, status=503)
        service.input_chunk(job_id, worker, index)
        response = HttpResponse(data, content_type="audio/wav")
        response["X-Content-Type-Options"] = "nosniff"
        return response


class IngestTranscriptionView(TranscriptionAgentView):
    """Provider-final text remains hidden until the execution publishes."""

    def post(self, request, job_id):
        serializer = FinalSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        worker = data.pop("worker_id")
        segment, created = service.ingest(job_id, worker, data)
        return Response(
            {"id": str(segment.pk), "created": created}, status=201 if created else 200
        )


class FinishTranscriptionView(TranscriptionAgentView):
    """A terminal late receipt may record observed cost but never upgrade source status."""

    def post(self, request, job_id):
        serializer = FinishSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        worker = data.pop("worker_id")
        return Response(service.serialize(service.finish(job_id, worker, data)))
