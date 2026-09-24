"""Manager-only, exact-room-occurrence cloud recording controls."""

from django.core.exceptions import ValidationError as ModelValidationError
from django.db import IntegrityError
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.api.online_capture import CaptureSourceSerializer
from core.services import cloud_recording
from core.services.meeting_records import RecordConflict
from core.services.online_capture import can_control


class CloudRecordingControlSerializer(CaptureSourceSerializer):
    """Explicit last-observed recording identity is mandatory even on first start."""

    key = serializers.UUIDField()
    operation = serializers.ChoiceField(choices=["start", "stop"])
    expected_recording_id = serializers.UUIDField(allow_null=True)


class CloudRecordingStartThrottle(UserRateThrottle):
    """Bound potentially billable reservations independently of state polling."""

    scope = "cloud_recording_starts"
    rate = "6/min"


class CloudRecordingReadThrottle(UserRateThrottle):
    """Allow visible polling while bounding manager-only reads."""

    scope = "cloud_recording_reads"
    rate = "120/min"


class CloudRecordingView(APIView):
    """No join token, room slug fallback or automatic recording side effects."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [CloudRecordingReadThrottle]

    def get_throttles(self):
        """A rollout or start budget must never prevent stopping a known recording."""
        if self.request.method == "POST":
            return (
                [CloudRecordingStartThrottle()]
                if self.request.data.get("operation") == "start"
                else []
            )
        return super().get_throttles()

    def finalize_response(self, request, response, *args, **kwargs):
        """Control identities must not survive in shared HTTP caches."""
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    def get(self, request):
        """Return only this concrete session's video recording and capabilities."""
        serializer = CaptureSourceSerializer(data=request.query_params)
        serializer.is_valid(raise_exception=True)
        session = get_object_or_404(
            models.MeetingSession.objects.select_related("room"),
            **serializer.validated_data,
        )
        if not can_control(session, request.user):
            return Response(status=404)
        return Response(cloud_recording.state(session))

    def post(self, request):
        """Accept a durable command; accepted is not proof that an egress is running."""
        serializer = CloudRecordingControlSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        session = get_object_or_404(
            models.MeetingSession,
            room_id=data["room_id"],
            livekit_room_sid=data["livekit_room_sid"],
        )
        if not can_control(session, request.user):
            return Response(status=404)
        try:
            command, replayed = cloud_recording.control(
                session.pk,
                request.user,
                data["key"],
                {
                    "operation": data["operation"],
                    "expected_recording_id": str(data["expected_recording_id"])
                    if data["expected_recording_id"]
                    else None,
                },
            )
        except PermissionError:
            return Response(status=404)
        except cloud_recording.RecordingCapacityError:
            return Response(
                {
                    "detail": "Recording service is busy. Try again after the current recording finishes.",
                    "code": "recording_capacity_reached",
                },
                status=409,
            )
        except (RecordConflict, IntegrityError, ModelValidationError):
            return Response(
                {"detail": "Cloud recording intent conflicts; refresh its state."},
                status=409,
            )
        session.refresh_from_db()
        return Response(
            {
                "command": cloud_recording.serialize_command(command),
                "current": cloud_recording.state(session),
                "replayed": replayed,
            },
            status=200 if replayed else 202,
        )
