"""Authenticated device-owner final text receipts; no PCM passes through this API."""

from rest_framework import serializers
from rest_framework.response import Response

from core.api.capture_audio import CaptureAudioView
from core.api.capture_transcription import FinalSerializer, RequestThrottle, SafeErrors
from core.api.meeting_captures import StrictSerializer
from core.services import capture_direct_asr as service
from core.services.capture_transcription import serialize


class StartSerializer(StrictSerializer):
    device_id = serializers.CharField(max_length=128)
    expected_job_id = serializers.UUIDField(allow_null=True)


class RangeSerializer(StrictSerializer):
    start_ms = serializers.IntegerField(min_value=0, max_value=43200000)
    end_ms = serializers.IntegerField(min_value=1, max_value=43200000)


class DirectFinalSerializer(FinalSerializer):
    worker_id = None


class SyncSerializer(StrictSerializer):
    device_id = serializers.CharField(max_length=128)
    operation = serializers.ChoiceField(choices=["sync", "finish"])
    ranges = RangeSerializer(many=True, max_length=50)
    finals = DirectFinalSerializer(many=True, max_length=50)
    final_sequence = serializers.IntegerField(min_value=0, max_value=20000)
    complete = serializers.BooleanField()


class CaptureDirectAsrStartView(SafeErrors, CaptureAudioView):
    throttle_classes = [RequestThrottle]

    def post(self, request, capture_id):
        self.capture(request, capture_id)
        body = StartSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        job, created = service.start(
            capture_id,
            request.user,
            serializers.UUIDField().run_validation(
                request.headers.get("X-Capture-Lease")
            ),
            serializers.UUIDField().run_validation(
                request.headers.get("Idempotency-Key")
            ),
            body.validated_data,
        )
        return Response(
            {"job": serialize(job), "created": created}, status=201 if created else 200
        )


class CaptureDirectAsrSyncView(SafeErrors, CaptureAudioView):
    def post(self, request, capture_id, job_id):
        self.capture(request, capture_id)
        body = SyncSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        for row in body.validated_data["finals"]:
            row["ingest_id"] = str(row["ingest_id"])
        job = service.sync(
            capture_id,
            job_id,
            request.user,
            serializers.UUIDField().run_validation(
                request.headers.get("X-Capture-Lease")
            ),
            body.validated_data,
        )
        return Response(serialize(job))
