"""Dispatch only into the exact active occurrence with an eligible declaration."""

import asyncio
import json
import logging
from contextlib import closing

from django.conf import settings
from django.db import transaction

from asgiref.sync import async_to_sync
from livekit import api
from livekit.protocol.agent import JS_PENDING, JS_RUNNING

from core import models, utils
from core.services import voiceprint_sampling as sampling

logger = logging.getLogger(__name__)
RPC_SECONDS = 5
CLOSE_SECONDS = 2


class SamplingDispatchError(ValueError):
    """Retryable fixed error without media, credentials or participant identities."""


@async_to_sync
async def send(room_name, room_sid, agent_name):
    try:
        client = utils.create_livekit_client()
        try:
            async with asyncio.timeout(RPC_SECONDS):
                rooms = await client.room.list_rooms(
                    api.ListRoomsRequest(names=[room_name])
                )
                if not any(room.sid == room_sid for room in rooms.rooms):
                    return "ended"
                dispatches = await client.agent_dispatch.list_dispatch(room_name)
                for dispatch in dispatches:
                    if dispatch.agent_name != agent_name or dispatch.state.deleted_at:
                        continue
                    try:
                        exact = json.loads(dispatch.metadata) == {
                            "voiceprint": {"livekit_room_sid": room_sid}
                        }
                    except (ValueError, TypeError):
                        continue
                    jobs = dispatch.state.jobs
                    if exact and (
                        not jobs
                        or any(
                            job.state.status in {JS_PENDING, JS_RUNNING} for job in jobs
                        )
                    ):
                        return "existing"
                await client.agent_dispatch.create_dispatch(
                    api.CreateAgentDispatchRequest(
                        agent_name=agent_name,
                        room=room_name,
                        metadata=json.dumps(
                            {"voiceprint": {"livekit_room_sid": room_sid}}
                        ),
                    )
                )
                return "created"
        finally:
            async with asyncio.timeout(CLOSE_SECONDS):
                await client.aclose()
    except Exception:  # noqa: BLE001 -- Transport and SDK failures become a fixed retryable code.
        raise SamplingDispatchError("sampling_dispatch_unavailable") from None


@transaction.atomic
def dispatch(session_id):
    """Serialize competing track/control callbacks and reject stale occurrences."""
    name = settings.MEETING_VOICEPRINT_SAMPLING_AGENT_NAME
    if (
        not sampling.enabled()
        or not name
        or not settings.MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN
    ):
        return "disabled"
    session = (
        models.MeetingSession.objects.select_for_update(of=("self",))
        .select_related("room__organization")
        .filter(pk=session_id, status="active")
        .first()
    )
    if session is None:
        return "ended"
    tracks = (
        models.VoiceprintSamplingTrack.objects.select_related(
            "participation__user", "participation__session__room__organization"
        )
        .filter(
            participation__session=session,
            participation__left_at__isnull=True,
            unpublished_at__isnull=True,
            source="microphone",
            media_type="audio",
            participation__voiceprint_control__paused=False,
            participation__voiceprint_control__shared_microphone=False,
            participation__voiceprint_control__device_group__in=sampling.DEVICE_GROUPS,
        )
        .order_by("pk")
        .iterator(chunk_size=64)
    )
    # Close the PostgreSQL server cursor before this transaction exits/rolls back.
    with closing(tracks):
        for track in tracks:
            try:
                sampling.mapped_owner(track.participation)
                if sampling.state(track.participation)["state"] == "ready":
                    return send(str(session.room_id), session.livekit_room_sid, name)
            except sampling.VoiceprintError:
                continue
    return "no_authorized_source"


def schedule(session_id):
    """Register a task only after the owner/source transaction has committed."""
    if sampling.enabled() and settings.MEETING_VOICEPRINT_SAMPLING_AGENT_NAME:
        from core.tasks.voiceprint_sampling import (  # noqa: PLC0415 -- Task registration may import source guards.
            dispatch_voiceprint_sampler,
        )

        def enqueue():
            try:
                dispatch_voiceprint_sampler.delay(str(session_id))
            except Exception:  # noqa: BLE001 -- Optional dispatch must not turn a committed owner edit into a failure.
                logger.warning("sampling_dispatch_enqueue_unavailable", exc_info=False)

        transaction.on_commit(enqueue)
