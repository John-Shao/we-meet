"""Private gateway admission and expiring standalone translation worker controls."""

from django.core.exceptions import (
    ObjectDoesNotExist,
)
from django.core.exceptions import (
    ValidationError as ModelValidationError,
)
from django.db import IntegrityError

from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from core.api.agent_internal import AgentTokenAuthentication, HasAgentToken
from core.api.capture_audio import AudioUploadThrottle, CaptureAudioView
from core.services import capture_translation_archive
from core.services import capture_translation_worker as service
from core.services.meeting_records import RecordConflict


class StrictSerializer(serializers.Serializer):
    def to_internal_value(self, data):
        if not isinstance(data, dict) or set(data) - set(self.fields):
            raise serializers.ValidationError("Unknown translation field.")
        return super().to_internal_value(data)


class TicketSerializer(StrictSerializer):
    device_id = serializers.CharField(max_length=128)
    run_id = serializers.UUIDField()
    generation = serializers.IntegerField(min_value=1)


class CaptureTranslationTicketView(CaptureAudioView):
    throttle_classes = [AudioUploadThrottle]
    http_method_names = ["post", "options"]

    def post(self, request, capture_id):
        self.capture(request, capture_id)
        serializer = TicketSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        lease = serializers.UUIDField().run_validation(
            request.headers.get("X-Capture-Lease")
        )
        try:
            return Response(
                service.ticket(
                    capture_id, request.user, lease, serializer.validated_data
                )
            )
        except (PermissionError, ObjectDoesNotExist):
            return Response(status=404)
        except RecordConflict:
            return Response(
                {"detail": "Translation is not awaiting a connection."}, status=409
            )


class ClaimSerializer(StrictSerializer):
    ticket = serializers.CharField(max_length=4096, trim_whitespace=False)
    worker_id = serializers.UUIDField()


class WorkerSerializer(StrictSerializer):
    worker_id = serializers.UUIDField()
    operation = serializers.ChoiceField(choices=["begin", "ready", "heartbeat"])


class FinishSerializer(StrictSerializer):
    worker_id = serializers.UUIDField()
    complete = serializers.BooleanField()
    input_tokens = serializers.IntegerField(min_value=0, max_value=10**12)
    output_tokens = serializers.IntegerField(min_value=0, max_value=10**12)
    audio_seconds = serializers.IntegerField(min_value=0, max_value=43200)
    segment_count = serializers.IntegerField(
        min_value=0, max_value=20000, required=False
    )


class SegmentSerializer(StrictSerializer):
    worker_id = serializers.UUIDField()
    capture_id = serializers.UUIDField()
    generation = serializers.IntegerField(min_value=1)
    direction = serializers.ChoiceField(choices=["forward", "reverse"])
    response_id = serializers.CharField(max_length=128, trim_whitespace=False)
    item_id = serializers.CharField(max_length=128, trim_whitespace=False)
    text = serializers.CharField(max_length=20000, trim_whitespace=False)


class CaptureTranslationAgentView(APIView):
    authentication_classes = [AgentTokenAuthentication]
    permission_classes = [HasAgentToken]
    http_method_names = ["post", "options"]

    def handle_exception(self, exc):
        if isinstance(exc, (PermissionError, ObjectDoesNotExist)):
            return Response(status=404)
        if isinstance(exc, (RecordConflict, ModelValidationError, IntegrityError)):
            return Response(
                {"detail": "Translation worker state conflicts."}, status=409
            )
        return super().handle_exception(exc)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response


class CaptureTranslationClaimView(CaptureTranslationAgentView):
    def post(self, request):
        serializer = ClaimSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(
            service.claim(
                serializer.validated_data["ticket"],
                serializer.validated_data["worker_id"],
            )
        )


class CaptureTranslationControlView(CaptureTranslationAgentView):
    def post(self, request, run_id):
        serializer = WorkerSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(service.advance(run_id, **serializer.validated_data))


class CaptureTranslationFinishView(CaptureTranslationAgentView):
    def post(self, request, run_id):
        serializer = FinishSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        return Response(service.finish(run_id, data.pop("worker_id"), data))


class CaptureTranslationSegmentView(CaptureTranslationAgentView):
    def post(self, request, run_id):
        serializer = SegmentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        return Response(
            capture_translation_archive.append(run_id, data.pop("worker_id"), data)
        )
