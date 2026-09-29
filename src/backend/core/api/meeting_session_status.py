"""A joining client may wait for webhook projection without probing control APIs."""

from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models
from core.api.online_capture import CaptureSourceSerializer
from core.authentication.livekit import LiveKitTokenAuthentication
from core.services.meeting_interpretation import present
from core.services.online_capture import can_control


class MeetingSessionStatusView(APIView):
    """Expose readiness only; join tokens never grant translation controls."""

    authentication_classes = [LiveKitTokenAuthentication]
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        serializer = CaptureSourceSerializer(data=request.query_params)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        video = getattr(request.auth, "video", None)
        if not video or not video.room_join or video.room != str(data["room_id"]):
            return Response(status=403)

        session = (
            models.MeetingSession.objects.select_related("room")
            .filter(**data, status="active")
            .first()
        )
        manager = bool(session and can_control(session, request.user))
        response = Response(
            {
                "ready": session is not None,
                "interpretation": bool(
                    session and (manager or present(session, request.user).exists())
                ),
                "translation": manager,
            }
        )
        response["Cache-Control"] = "private, no-store"
        return response
