"""Manager-only, exact-room-occurrence cloud recording controls."""

from django.shortcuts import get_object_or_404

from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.api.online_capture import CaptureSourceSerializer
from core.services import cloud_recording
from core.services.online_capture import can_control


class CloudRecordingReadThrottle(UserRateThrottle):
    """Allow visible polling while bounding manager-only reads."""

    scope = "cloud_recording_reads"
    rate = "120/min"


class CloudRecordingView(APIView):
    """No join token, room slug fallback or automatic recording side effects."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [CloudRecordingReadThrottle]

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
