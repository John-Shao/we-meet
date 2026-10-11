"""Synthetic native RTC sampler probe; use only in an isolated local Docker network.

The local permit fixture tests transport/media/lifecycle, not backend consent or
biometric accuracy. No microphone, camera, cloud ASR or production room is opened.
"""

import asyncio
import contextlib
import io
import json
import math
import os
import struct
import sys
import wave
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import aiohttp
from aiohttp import web
from livekit import api, rtc

from voiceprint.runtime import configure_logging


async def until(predicate, *, seconds=30):
    """Bound every observation; a timeout is a failing probe, never success."""
    async with asyncio.timeout(seconds):
        while not predicate():
            await asyncio.sleep(0.05)


def phase(name):
    """Emit fixed probe stages, never RTC identities or credentials."""
    print(json.dumps({"event": "probe_phase", "phase": name}), flush=True)


async def run():
    """Run real worker dispatch, Opus/PCM, private HTTP, revocation and room close."""
    configure_logging()
    fixture = json.loads(Path(os.environ["SAMPLER_PROBE_CONFIG"]).read_text())
    key, secret = fixture["api_key"], fixture["api_secret"]
    state = {
        "origin": None,
        "identity": str(uuid4()),
        "grants": {},
        "uploads": 0,
        "frames": 0,
        "denied": 0,
        "phases": [],
        "revoked": False,
    }

    def authenticate(request):
        if request.headers.get("X-Voiceprint-Agent-Token") != fixture["sampling_token"]:
            raise web.HTTPForbidden()

    async def issue(request):
        authenticate(request)
        body = await request.json()
        if (
            state["revoked"]
            or any(body.get(k) != v for k, v in (state["origin"] or {}).items())
            or state["origin"] is None
        ):
            state["denied"] += 1
            raise web.HTTPForbidden()
        grant = {
            **state["origin"],
            "id": str(uuid4()),
            "user_id": str(uuid4()),
            "session_id": str(uuid4()),
            "identity": state["identity"],
            "token": "P" * 43,
            "max_duration_ms": 3000,
            "expires_at": (
                datetime.now(timezone.utc) + timedelta(seconds=30)
            ).isoformat(),
            "sample_rate": 24000,
            "channels": 1,
        }
        state["grants"][grant["id"]] = grant
        return web.json_response(grant)

    async def validate(request):
        authenticate(request)
        body = await request.json()
        grant = state["grants"].get(request.match_info["id"])
        if state["revoked"] or grant is None or body.get("token") != grant["token"]:
            raise web.HTTPForbidden()
        if any(body.get(k) != v for k, v in state["origin"].items()):
            raise web.HTTPForbidden()
        phase = body.get("activity_phase")
        state["phases"].append((grant["id"], phase))
        # Revoke the second clip only after actual PCM has begun arriving.
        if state["uploads"] == 1 and phase == "sampling":
            state["revoked"] = True
            raise web.HTTPForbidden()
        return web.json_response(grant)

    async def upload(request):
        authenticate(request)
        grant = state["grants"].get(request.match_info["id"])
        assert not state["revoked"] and grant is not None
        assert request.headers.get("X-Voiceprint-Permit-Token") == grant["token"]
        assert dict(request.query) == state["origin"]
        body = await request.read()
        assert len(body) <= 480044
        with wave.open(io.BytesIO(body), "rb") as wav:
            assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (
                24000,
                1,
                2,
            )
            assert wav.getnframes() == 72000
            samples = struct.unpack(
                "<" + "h" * wav.getnframes(), wav.readframes(wav.getnframes())
            )
            assert max(abs(value) for value in samples) > 1000
            state["frames"] = len(samples)
        phases = [
            phase for identity, phase in state["phases"] if identity == grant["id"]
        ]
        assert (
            phases[0] == "waiting"
            and "sampling" in phases
            and phases[-1] == "uploading"
        )
        state["uploads"] += 1
        return web.json_response({"id": str(uuid4())}, status=202)

    app = web.Application(client_max_size=480044)
    prefix = "/api/agent/voiceprint-sampling/permits/"
    app.router.add_post(prefix, issue)
    app.router.add_post(prefix + "{id}/validate/", validate)
    app.router.add_put(prefix + "{id}/clip/", upload)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", 8095).start()
    client = api.LiveKitAPI("http://livekit:7880", key, secret)
    rooms, sources, tasks = [], [], []
    room_name = str(uuid4())
    second_room = str(uuid4())
    subscriptions = [0, 0]
    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=2)
        ) as http:

            async def ready():
                try:
                    async with http.get("http://sampler:8094/health/ready") as response:
                        return response.status == 200
                except aiohttp.ClientError:
                    return False

            async with asyncio.timeout(45):
                while not await ready():
                    await asyncio.sleep(0.2)
            phase("worker_registered")
            created = await client.room.create_room(
                api.CreateRoomRequest(name=room_name)
            )
            await client.room.create_room(api.CreateRoomRequest(name=second_room))

            async def publisher(index):
                room = rtc.Room()
                rooms.append(room)
                room.on(
                    "local_track_subscribed",
                    lambda _track: subscriptions.__setitem__(
                        index, subscriptions[index] + 1
                    ),
                )
                identity = state["identity"] if index == 0 else str(uuid4())
                token = (
                    api.AccessToken(key, secret)
                    .with_identity(identity)
                    .with_grants(
                        api.VideoGrants(
                            room_join=True,
                            room=room_name,
                            can_publish=True,
                            can_subscribe=True,
                        )
                    )
                    .to_jwt()
                )
                await room.connect(
                    "ws://livekit:7880",
                    token,
                    options=rtc.RoomOptions(auto_subscribe=False),
                )
                phase("publisher_connected")
                source = rtc.AudioSource(24000, 1, queue_size_ms=40)
                sources.append(source)
                publication = await room.local_participant.publish_track(
                    rtc.LocalAudioTrack.create_audio_track("synthetic-tone", source),
                    rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
                )
                phase("track_published")
                if index == 0:
                    state["origin"] = {
                        "room_sid": created.sid,
                        "participant_sid": room.local_participant.sid,
                        "track_sid": publication.sid,
                    }

                async def feed():
                    position = 0
                    while True:
                        data = b"".join(
                            struct.pack(
                                "<h",
                                int(
                                    8000
                                    * math.sin(
                                        2 * math.pi * 440 * (position + n) / 24000
                                    )
                                ),
                            )
                            for n in range(480)
                        )
                        position += 480
                        await source.capture_frame(rtc.AudioFrame(data, 24000, 1, 480))
                        await asyncio.sleep(0.02)

                tasks.append(asyncio.create_task(feed()))

            await publisher(0)
            await publisher(1)
            phase("publishers_ready")
            await client.agent_dispatch.create_dispatch(
                api.CreateAgentDispatchRequest(
                    room=room_name,
                    agent_name="fixture-sampler",
                    metadata=json.dumps(
                        {"voiceprint": {"livekit_room_sid": created.sid}}
                    ),
                )
            )
            phase("job_dispatched")
            await until(lambda: state["uploads"] == 1)
            phase("clip_uploaded")
            await until(lambda: state["revoked"])
            await asyncio.sleep(2)
            assert state["uploads"] == 1
            assert subscriptions[0] >= 1 and subscriptions[1] == 0
            assert state["denied"] > 0
            participants = await client.room.list_participants(
                api.ListParticipantsRequest(room=room_name)
            )
            agents = [
                participant
                for participant in participants.participants
                if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
            ]
            assert len(agents) == 1
            permission = agents[0].permission
            assert (
                not permission.hidden
                and not permission.can_publish
                and not permission.can_publish_data
                and not permission.can_update_metadata
            )
            assert agents[0].name == "Voiceprint sampling"
            metrics = await (await http.get("http://sampler:8094/metrics")).text()
            assert "voiceprint_sampler_active_rooms 1\n" in metrics
            assert "voiceprint_sampler_room_capacity 1\n" in metrics
            # A real second room offer must not create a second active SDK child.
            second = await client.room.list_rooms(
                api.ListRoomsRequest(names=[second_room])
            )
            await client.agent_dispatch.create_dispatch(
                api.CreateAgentDispatchRequest(
                    room=second_room,
                    agent_name="fixture-sampler",
                    metadata=json.dumps(
                        {"voiceprint": {"livekit_room_sid": second.rooms[0].sid}}
                    ),
                )
            )
            await asyncio.sleep(3)
            other = await client.room.list_participants(
                api.ListParticipantsRequest(room=second_room)
            )
            assert not other.participants
            await client.room.delete_room(api.DeleteRoomRequest(room=room_name))
            async with asyncio.timeout(20):
                while (
                    "voiceprint_sampler_active_rooms 0\n"
                    not in await (await http.get("http://sampler:8094/metrics")).text()
                ):
                    await asyncio.sleep(0.2)
            assert await ready()
            assert (await http.get("http://sampler:8094/worker")).status == 404
            print(
                json.dumps(
                    {
                        "status": "passed",
                        "pcm_frames": state["frames"],
                        "uploads": 1,
                        "denied_subscription": False,
                        "revocation_discarded": True,
                        "room_capacity": 1,
                        "room_close_released": True,
                    }
                )
            )
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for room in rooms:
            await room.disconnect()
        for source in sources:
            await source.aclose()
        for name in (room_name, second_room):
            with contextlib.suppress(Exception):
                await client.room.delete_room(api.DeleteRoomRequest(room=name))
        await client.aclose()
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except Exception as error:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "code": "sampler_native_probe_failed",
                    "failure": type(error).__name__,
                }
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from None
