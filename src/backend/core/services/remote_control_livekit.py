"""Read current connection evidence from LiveKit, never from event payloads."""

import asyncio
import json
import logging
from dataclasses import dataclass

from aiohttp import ClientError
from asgiref.sync import async_to_sync
from livekit import api
from livekit.protocol.models import ParticipantInfo, TrackSource

from core import utils


class RemoteControlError(Exception):
    """Public, stable error code without upstream or input content."""

    def __init__(self, code, status=409):
        self.code = code
        self.status = status
        super().__init__(code)


@dataclass(frozen=True)
class Snapshot:
    room_sid: str
    participants: dict


@async_to_sync
async def snapshot(room_id):
    client = utils.create_livekit_client()
    try:
        async with asyncio.timeout(3):
            room_name = str(room_id)
            before = await client.room.list_rooms(
                api.ListRoomsRequest(names=[room_name])
            )
            people = await client.room.list_participants(
                api.ListParticipantsRequest(room=room_name)
            )
            after = await client.room.list_rooms(
                api.ListRoomsRequest(names=[room_name])
            )
            if (
                len(before.rooms) != 1
                or len(after.rooms) != 1
                or before.rooms[0].sid != after.rooms[0].sid
            ):
                raise RemoteControlError("connection_changed")
            return Snapshot(
                after.rooms[0].sid, {p.identity: p for p in people.participants}
            )
    except (TimeoutError, ClientError, OSError, api.TwirpError) as exc:
        raise RemoteControlError("presence_unavailable", 503) from exc
    finally:
        await client.aclose()


def participant(evidence, user, expected_sid=None):
    entry = evidence.participants.get(str(user.sub))
    if (
        entry is None
        or not entry.sid
        or entry.state != ParticipantInfo.ACTIVE
        or entry.kind != ParticipantInfo.STANDARD
        or entry.permission.hidden
        or entry.permission.recorder
        or entry.permission.agent
        or not entry.permission.can_publish_data
        or (expected_sid is not None and entry.sid != expected_sid)
    ):
        raise RemoteControlError("participant_unavailable")
    return entry


def screen_allowed(entry):
    permission = entry.permission
    if not permission.can_publish or (
        permission.can_publish_sources
        and TrackSource.SCREEN_SHARE not in permission.can_publish_sources
    ):
        raise RemoteControlError("screen_share_not_allowed", 403)


def screen_track(entry, track_sid):
    screen_allowed(entry)
    if not any(
        t.sid == track_sid and t.source == TrackSource.SCREEN_SHARE and not t.muted
        for t in entry.tracks
    ):
        raise RemoteControlError("screen_share_unavailable")


def screen_tracks(entry):
    """Current account's eligible track SIDs, not a claim about capture pixels."""
    try:
        screen_allowed(entry)
    except RemoteControlError:
        return []
    return sorted(
        {
            track.sid
            for track in entry.tracks
            if track.sid
            and track.source == TrackSource.SCREEN_SHARE
            and not track.muted
        }
    )


@async_to_sync
async def notify(room_id, identities, notice):
    """A wake-up hint only. Receivers must fetch and verify the current state."""
    client = utils.create_livekit_client()
    try:
        async with asyncio.timeout(3):
            for identity in identities:
                await client.room.send_data(
                    api.SendDataRequest(
                        room=str(room_id),
                        destination_identities=[identity],
                        topic="we-meet.remote-control.v1.signal",
                        kind="RELIABLE",
                        data=json.dumps(notice, separators=(",", ":")).encode(),
                    )
                )
    except (TimeoutError, ClientError, OSError, api.TwirpError):
        # Polling and the native lease deadline remain authoritative.
        logging.getLogger(__name__).warning("remote_control.state_hint_unavailable")
    finally:
        await client.aclose()
