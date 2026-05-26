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
from django.shortcuts import get_object_or_404

from rest_framework import exceptions, serializers, status
from rest_framework.authentication import BaseAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from core.models import Room, Transcript

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


class _AgentPrincipal:
    """Marker object set as ``request.user`` after agent-token auth succeeds.

    DRF's ``IsAuthenticated`` permission checks ``user.is_authenticated``, so
    expose ``True`` on this sentinel. The principal carries no permissions
    beyond the agent-internal endpoints — it must never reach a public
    viewset.
    """

    is_authenticated = True
    is_anonymous = False

    def __str__(self) -> str:
        return "agent-worker"


class AgentTokenAuthentication(BaseAuthentication):
    """Authenticate agent worker requests via a shared bearer-style header.

    The expected header is ``X-Agent-Token: <token>``. The token is compared
    against ``settings.AGENT_INTERNAL_API_TOKEN``; if the setting is unset or
    empty the endpoint is unreachable (fail-closed).
    """

    def authenticate(self, request):
        token = request.META.get("HTTP_X_AGENT_TOKEN", "")
        if not token:
            return None  # no header → fall through; DRF returns 401/403

        expected = getattr(settings, "AGENT_INTERNAL_API_TOKEN", "") or ""
        if not expected or token != expected:
            raise exceptions.AuthenticationFailed("Invalid agent token")

        return (_AgentPrincipal(), token)


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


class IngestTranscriptView(APIView):
    """Persist one FINAL_TRANSCRIPT event from the transcriber agent."""

    authentication_classes = [AgentTokenAuthentication]
    permission_classes = [IsAuthenticated]

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
        )
        return Response({"status": "ok"}, status=status.HTTP_201_CREATED)
