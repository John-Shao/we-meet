"""Exact-session public controls and an authenticated agent heartbeat."""

from django.db import IntegrityError
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.api.agent_internal import AgentTokenAuthentication, HasAgentToken
from core.authentication.livekit import LiveKitTokenAuthentication
from core.services.meeting_records import RecordConflict, visible_records
from core.services.online_capture import (
    can_control,
    capture_enabled,
    control_capture,
    heartbeat_capture,
    latest_run,
    serialize_run,
)


class CaptureSourceSerializer(serializers.Serializer):
    """A room cannot silently resolve to its previous occurrence."""

    room_id = serializers.UUIDField()
    livekit_room_sid = serializers.RegexField(r"^RM_[A-Za-z0-9_-]{1,61}$")

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unsupported capture field.")
        return attrs


class CaptureControlSerializer(CaptureSourceSerializer):
    """Explicit operation and last observed run identity prevent stale start/stop."""

    operation = serializers.ChoiceField(choices=["start", "stop"])
    expected_run_id = serializers.UUIDField(allow_null=True)
    key = serializers.UUIDField()


class CaptureHeartbeatSerializer(CaptureSourceSerializer):
    """Only the claimed process may renew this delivery's capture lease."""

    delivery_id = serializers.UUIDField()
    writer_id = serializers.UUIDField()


class OnlineCaptureViewSet(viewsets.GenericViewSet):
    """No LiveKit join-token authentication: current user ACL controls recordings."""

    permission_classes = [permissions.IsAuthenticated]

    def get_throttles(self):
        """Limit potentially billable starts without delaying an explicit stop."""
        if (
            self.request.method == "POST"
            and self.request.data.get("operation") == "start"
        ):
            return [CaptureStartThrottle()]
        return []

    @action(detail=False, methods=["get", "post"])
    def control(self, request):
        """Read before the first original sentence; POST alone can reserve a note."""
        serializer = (
            CaptureControlSerializer
            if request.method == "POST"
            else CaptureSourceSerializer
        )(data=request.data if request.method == "POST" else request.query_params)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        session = get_object_or_404(
            models.MeetingSession,
            room_id=data["room_id"],
            livekit_room_sid=data["livekit_room_sid"],
        )
        manager = can_control(session, request.user)
        if (
            not manager
            and not visible_records(request.user, ability="read_transcript")
            .filter(meeting_session=session)
            .exists()
        ):
            return Response(status=404)
        if request.method == "GET":
            return Response(
                {
                    "available": capture_enabled() and session.status == "active",
                    "can_control": manager,
                    "current": serialize_run(latest_run(session)),
                }
            )
        if not manager:
            return Response(status=403)
        try:
            result, run, replayed = control_capture(
                session.pk,
                request.user,
                data["key"],
                {
                    "operation": data["operation"],
                    "expected_run_id": str(data["expected_run_id"])
                    if data["expected_run_id"]
                    else None,
                },
            )
        except PermissionError:
            return Response(status=403)
        except (RecordConflict, IntegrityError) as exc:
            detail = (
                str(exc)
                if isinstance(exc, RecordConflict)
                else "Capture intent conflicts."
            )
            return Response({"detail": detail}, status=409)
        return Response(
            {"result": result, "current": serialize_run(run), "replayed": replayed}
        )


class OnlineCaptureHeartbeatView(APIView):
    """Remain reachable when a rollout flag is disabled, so running agents can stop."""

    authentication_classes = [AgentTokenAuthentication]
    permission_classes = [HasAgentToken]

    def post(self, request):
        """Poll state and renew the exclusive writer, without creating a run."""
        serializer = CaptureHeartbeatSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            run = heartbeat_capture(data["delivery_id"], data)
        except models.OnlineCaptureRun.DoesNotExist:
            return Response(status=404)
        except RecordConflict:
            return Response(
                {"detail": "Capture writer or source conflicts."}, status=409
            )
        return Response(
            {"status": "ok", "id": str(run.delivery_id), "state": run.state}
        )


class CaptureStartThrottle(UserRateThrottle):
    """Each authenticated user has a separate capture-start budget."""

    scope = "online_capture_starts"
    rate = "6/min"


class OnlineCaptureStatusView(APIView):
    """Minimal recording notice for joining participants, including anonymous guests."""

    authentication_classes = [LiveKitTokenAuthentication]
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        """A join token may read capture state only, never materials or run metadata."""
        serializer = CaptureSourceSerializer(data=request.query_params)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        video = getattr(request.auth, "video", None)
        if not video or not video.room_join or video.room != str(data["room_id"]):
            return Response(status=403)
        session = get_object_or_404(models.MeetingSession, **data, status="active")
        run = latest_run(session)
        return Response({"state": run.state if run else "off"})
