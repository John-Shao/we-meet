"""Internal API endpoints called by agent workers.

These are NOT part of the public ``/api/v{n}/`` surface: they live under
``/api/agent/`` and authenticate via a shared secret (``AGENT_INTERNAL_API_TOKEN``)
sent in the ``X-Agent-Token`` header. The token is injected into the agent
worker pods via the same secret-management pipeline used for LiveKit /
Doubao credentials.

Endpoints:
    POST /api/agent/transcripts/   — multi_user_transcriber writes one row
                                     per FINAL_TRANSCRIPT event
"""

import logging

from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.shortcuts import get_object_or_404

from rest_framework import exceptions, permissions, serializers, status
from rest_framework.authentication import BaseAuthentication
from rest_framework.response import Response
from rest_framework.views import APIView

from core.models import Room, Transcript

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


class AgentTokenAuthentication(BaseAuthentication):
    """Authenticate agent worker requests via a shared bearer-style header.

    The expected header is ``X-Agent-Token: <token>``. The token is compared
    against ``settings.AGENT_INTERNAL_API_TOKEN``; if the setting is unset or
    empty the endpoint is unreachable (fail-closed).

    The request's ``user`` is set to ``AnonymousUser`` (a real Django user
    type) so any user-touching middleware doesn't explode on attribute
    access. The actual gate is :class:`HasAgentToken` reading
    ``request.auth``.
    """

    def authenticate(self, request):
        token = request.META.get("HTTP_X_AGENT_TOKEN", "")
        if not token:
            return None  # no header → fall through; HasAgentToken returns 403

        expected = getattr(settings, "AGENT_INTERNAL_API_TOKEN", "") or ""
        if not expected or token != expected:
            raise exceptions.AuthenticationFailed("Invalid agent token")

        return (AnonymousUser(), token)


class HasAgentToken(permissions.BasePermission):
    """Allow only requests that carried a valid ``X-Agent-Token``."""

    def has_permission(self, request, view):
        return request.auth is not None


# ---------------------------------------------------------------------------
# Transcript ingestion
# ---------------------------------------------------------------------------


class _TranscriptIngestSerializer(serializers.Serializer):
    """Wire payload accepted by ``POST /api/agent/transcripts/``."""

    room_id = serializers.UUIDField()
    speaker_identity = serializers.CharField(max_length=128)
    speaker_name = serializers.CharField(
        max_length=128, required=False, allow_blank=True, default=""
    )
    text = serializers.CharField()
    language = serializers.CharField(
        max_length=16, required=False, allow_blank=True, default=""
    )
    started_at = serializers.DateTimeField()
    ended_at = serializers.DateTimeField(required=False, allow_null=True)
    translations = serializers.DictField(
        child=serializers.CharField(allow_blank=True),
        required=False,
        default=dict,
        help_text="Best-effort translations keyed by ISO code (e.g. en-us).",
    )


class IngestTranscriptView(APIView):
    """Persist one FINAL_TRANSCRIPT event from the transcriber agent."""

    authentication_classes = [AgentTokenAuthentication]
    permission_classes = [HasAgentToken]

    def post(self, request):
        serializer = _TranscriptIngestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        room = get_object_or_404(Room, id=data["room_id"])

        Transcript.objects.create(
            room=room,
            speaker_identity=data["speaker_identity"],
            speaker_name=data.get("speaker_name") or "",
            text=data["text"],
            language=data.get("language") or "",
            started_at=data["started_at"],
            ended_at=data.get("ended_at"),
            translations=data.get("translations") or {},
        )
        return Response({"status": "ok"}, status=status.HTTP_201_CREATED)
