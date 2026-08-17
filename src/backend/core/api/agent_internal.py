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
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError
from django.shortcuts import get_object_or_404

from rest_framework import exceptions, permissions, serializers, status
from rest_framework.authentication import BaseAuthentication
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models
from core.models import Room, Transcript
from core.services.meeting_sessions import (
    MeetingSessionProjectionError,
    MeetingSessionService,
)

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


class _TranscriptIngestSerializer(  # pylint: disable=abstract-method
    serializers.Serializer
):
    """Wire payload accepted by ``POST /api/agent/transcripts/``."""

    room_id = serializers.UUIDField()
    livekit_room_sid = serializers.CharField(
        max_length=64, required=False, allow_blank=True, default=""
    )
    ingest_id = serializers.UUIDField(required=False, allow_null=True)
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

    @staticmethod
    def _matches_replay(transcript, data, room):
        """Return whether an idempotency-key replay carries the same artifact."""

        return all(
            (
                transcript.room_id == room.id,
                transcript.speaker_identity == data["speaker_identity"],
                transcript.speaker_name == (data.get("speaker_name") or ""),
                transcript.text == data["text"],
                transcript.language == (data.get("language") or ""),
                transcript.started_at == data["started_at"],
                transcript.ended_at == data.get("ended_at"),
                transcript.translations == (data.get("translations") or {}),
            )
        )

    @staticmethod
    def _response(transcript, *, created):
        return Response(
            {
                "status": "ok",
                "id": str(transcript.id),
                "session_id": (
                    str(transcript.session_id) if transcript.session_id else None
                ),
                "created": created,
            },
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    # pylint: disable-next=too-many-branches
    def post(self, request):
        """Validate and idempotently persist one session-scoped utterance."""

        serializer = _TranscriptIngestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        room = get_object_or_404(Room, id=data["room_id"])
        ingest_id = data.get("ingest_id")
        existing = None
        if ingest_id is not None:
            existing = (
                Transcript.objects.select_related("session")
                .filter(ingest_id=ingest_id)
                .first()
            )
            supplied_sid = data.get("livekit_room_sid") or None
            existing_sid = (
                existing.session.livekit_room_sid
                if existing is not None and existing.session_id is not None
                else None
            )
            if existing is not None and (
                not self._matches_replay(existing, data, room)
                or (supplied_sid and existing_sid and supplied_sid != existing_sid)
            ):
                logger.error(
                    "transcript.ingest_id_conflict room_id=%s ingest_id=%s",
                    room.id,
                    ingest_id,
                )
                return Response(
                    {"detail": "ingest_id was already used for another transcript"},
                    status=status.HTTP_409_CONFLICT,
                )

        try:
            session = MeetingSessionService().resolve_for_artifact(
                room=room,
                livekit_room_sid=data.get("livekit_room_sid") or None,
                artifact_at=data["started_at"],
                start_source=models.MeetingSession.StartSource.TRANSCRIPT,
            )
        except MeetingSessionProjectionError as err:
            logger.warning(
                "transcript.session_mismatch room_id=%s livekit_room_sid=%s",
                room.id,
                data.get("livekit_room_sid") or "",
            )
            return Response(
                {"detail": str(err)}, status=status.HTTP_409_CONFLICT
            )

        values = {
            "room": room,
            "session": session,
            "speaker_identity": data["speaker_identity"],
            "speaker_name": data.get("speaker_name") or "",
            "text": data["text"],
            "language": data.get("language") or "",
            "started_at": data["started_at"],
            "ended_at": data.get("ended_at"),
            "translations": data.get("translations") or {},
        }
        if ingest_id is None:
            transcript = Transcript.objects.create(**values)
            if session is None:
                logger.warning("transcript.session_unresolved room_id=%s", room.id)
            return self._response(transcript, created=True)

        if existing is not None:
            transcript, created = existing, False
        else:
            try:
                transcript, created = Transcript.objects.get_or_create(
                    ingest_id=ingest_id,
                    defaults=values,
                )
            except (DjangoValidationError, IntegrityError):
                # A concurrent retry may win between the initial SELECT and INSERT.
                transcript = Transcript.objects.filter(ingest_id=ingest_id).first()
                if transcript is None:
                    raise
                created = False

        if not created:
            if not self._matches_replay(transcript, data, room):
                logger.error(
                    "transcript.ingest_id_conflict room_id=%s ingest_id=%s",
                    room.id,
                    ingest_id,
                )
                return Response(
                    {"detail": "ingest_id was already used for another transcript"},
                    status=status.HTTP_409_CONFLICT,
                )
            if transcript.session_id is None and session is not None:
                transcript.session = session
                transcript.save(update_fields=["session", "updated_at"])
            elif (
                transcript.session_id is not None
                and session is not None
                and transcript.session_id != session.id
            ):
                return Response(
                    {"detail": "ingest_id resolves to a different meeting session"},
                    status=status.HTTP_409_CONFLICT,
                )

        if transcript.session_id is None:
            logger.warning(
                "transcript.session_unresolved room_id=%s ingest_id=%s",
                room.id,
                ingest_id,
            )
        return self._response(transcript, created=created)
