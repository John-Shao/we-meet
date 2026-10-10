"""Native synthetic publishers against real backend consent, permits and queues."""

# Fixed CLI aggregate output is part of the native probe's evidence protocol.
# ruff: noqa: T201

import asyncio
import json
import math
import os
import ssl
import struct
import sys
from pathlib import Path

import aiohttp
from livekit import api, rtc
from voiceprint.runtime import configure_logging


def require(value, code):
    """Fixed fixture failures must not expose session cookies or private payloads."""
    if not value:
        raise RuntimeError("rtc_media_probe_" + code)


def phase(name):
    """Report only known synthetic probe stages."""
    print(json.dumps({"event": "rtc_media_probe_phase", "phase": name}), flush=True)


async def run():  # noqa: PLR0912, PLR0915 -- Keep this single ordered media scenario and resource lifetime together.
    """Exercise genuine HTTPS owner APIs, signed webhooks and RTC media admission."""
    configure_logging()
    fixture = json.loads(Path(os.environ["VOICEPRINT_RTC_PROBE_CONFIG"]).read_text())
    ca = ssl.create_default_context(cafile="/fixture/backend-ca.crt")
    driver_headers = {"X-Fixture-Driver-Token": fixture["driver_token"]}
    client = api.LiveKitAPI(
        "http://livekit:7880", fixture["api_key"], fixture["api_secret"]
    )
    rooms, sources, tasks = [], [], []
    subscriptions = [0, 0]
    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=5), cookie_jar=aiohttp.DummyCookieJar()
        ) as http:

            async def fixture_request(path, *, mutation=False):
                async with http.request(
                    "POST" if mutation else "GET",
                    "http://backend:8766" + path,
                    headers=driver_headers,
                ) as response:
                    require(response.status == 200, "fixture_http")
                    return await response.json()

            async with asyncio.timeout(60):
                while True:
                    try:
                        seed = await fixture_request("/fixture")
                        async with http.get(
                            "http://sampler:8094/health/ready"
                        ) as response:
                            if response.status == 200:
                                break
                    except (aiohttp.ClientError, RuntimeError):
                        pass
                    await asyncio.sleep(0.2)
            phase("fixture_and_sampler_ready")
            owner, denied = seed["users"]
            room_name = seed["room"]

            async def owner_request(  # noqa: PLR0913 -- Explicit actor, payload and expected response contract.
                method, path, *, data=None, params=None, actor=owner, allowed=(200,)
            ):
                headers = {
                    "X-Voiceprint-Owner": actor["id"],
                    "X-CSRFToken": actor["csrf"],
                    "Origin": "https://backend:8000",
                    "Cookie": f"{seed['cookie_name']}={actor['cookie']}; {seed['csrf_cookie_name']}={actor['csrf']}",
                }
                async with http.request(
                    method,
                    "https://backend:8000/api/v1.0/voiceprint/" + path,
                    json=data,
                    params=params,
                    headers=headers,
                    ssl=ca,
                    allow_redirects=False,
                ) as response:
                    require(
                        response.status in allowed, "owner_http_" + str(response.status)
                    )
                    require(
                        "no-store" in response.headers.get("Cache-Control", ""),
                        "private_cache",
                    )
                    return await response.json()

            preference = await owner_request(
                "PATCH",
                "settings/",
                data={
                    "organization_id": None,
                    "expected_version": 0,
                    "allow_enrollment": True,
                    "allow_accumulation": True,
                },
            )
            require(preference["version"] == 1, "owner_consent")
            created = await client.room.create_room(
                api.CreateRoomRequest(name=room_name)
            )
            phase("owner_consent_and_room_created")

            async def publisher(index, actor):
                room = rtc.Room()
                rooms.append(room)
                room.on(
                    "local_track_subscribed",
                    lambda _track: subscriptions.__setitem__(
                        index, subscriptions[index] + 1
                    ),
                )
                token = (
                    api.AccessToken(fixture["api_key"], fixture["api_secret"])
                    .with_identity(actor["identity"])
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
                source = rtc.AudioSource(24000, 1, queue_size_ms=40)
                sources.append(source)
                publication = await room.local_participant.publish_track(
                    rtc.LocalAudioTrack.create_audio_track("synthetic-tone", source),
                    rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
                )

                async def feed():
                    position = 0
                    while True:
                        data = b"".join(
                            struct.pack(
                                "<h",
                                int(
                                    3500
                                    * math.sin(
                                        2 * math.pi * 300 * (position + n) / 24000
                                    )
                                    + 1000
                                    * math.sin(
                                        2 * math.pi * 750 * (position + n) / 24000
                                    )
                                ),
                            )
                            for n in range(480)
                        )
                        position += 480
                        await source.capture_frame(rtc.AudioFrame(data, 24000, 1, 480))
                        await asyncio.sleep(0.02)

                tasks.append(asyncio.create_task(feed()))
                return room, publication

            owner_room, _publication = await publisher(0, owner)
            await publisher(1, denied)
            phase("publishers_ready")
            query = {
                "room_sid": created.sid,
                "participant_sid": owner_room.local_participant.sid,
            }
            async with asyncio.timeout(35):
                while True:
                    connection = await owner_request(
                        "GET", "sampling-connection/", params=query, allowed=(200, 404)
                    )
                    if "control" in connection:
                        break
                    await asyncio.sleep(0.2)
            control = connection["control"]
            require(
                control["shared_microphone"]
                and control["state"] == "shared_microphone",
                "initial_declaration",
            )
            require(connection["permission"]["allow_accumulation"], "current_consent")
            await asyncio.sleep(1)
            require(subscriptions == [0, 0], "no_implicit_subscription")
            control = await owner_request(
                "PATCH",
                "sampling-control/",
                data={
                    "session_id": control["session_id"],
                    "participant_sid": query["participant_sid"],
                    "expected_revision": control["revision"],
                    "paused": False,
                    "shared_microphone": False,
                    "device_group": "headset",
                },
            )
            require(control["state"] == "ready", "owner_declaration")
            phase("declaration_committed_real_dispatch")
            # No direct LiveKit dispatch or sampler permit fixture is used here.
            async with asyncio.timeout(200):
                while True:
                    candidates = (await owner_request("GET", "samples/"))["results"]
                    require(len(candidates) <= 3, "session_audio_budget")
                    if len(candidates) == 3 and all(
                        sample["confirmable"] for sample in candidates
                    ):
                        break
                    await asyncio.sleep(2)
            phase("three_real_qwen_candidates_ready")
            require(
                subscriptions[0] > 0 and subscriptions[1] == 0,
                "denied_track_never_subscribed",
            )
            denied_samples = await owner_request("GET", "samples/", actor=denied)
            require(not denied_samples["results"], "denied_owner_has_no_candidates")
            before = await fixture_request("/state")
            require(
                before["templates"] == 0
                and before["encrypted_audio"]
                and before["encrypted_embeddings"] == 3,
                "unconfirmed_encrypted",
            )
            require(
                before["webhook_success"] >= 5
                and before["consumed_permits"] == 3
                and before["denied_owner_candidates"] == 0,
                "trusted_admission",
            )
            for sample in candidates:
                result = await owner_request(
                    "POST",
                    f"samples/{sample['id']}/decision/",
                    data={"expected_version": preference["version"], "accepted": True},
                )
                require(result["status"] == "confirmed", "owner_confirmation")
            phase("owner_confirmed")
            async with asyncio.timeout(90):
                while True:
                    state = await fixture_request("/state")
                    if state["templates"] == 1:
                        break
                    await asyncio.sleep(1)
            require(
                state["support_samples"] == [3]
                and state["basis_roles"] == ["baseline"]
                and state["encrypted_templates"],
                "real_owner_baseline",
            )
            await fixture_request("/maintain", mutation=True)
            async with asyncio.timeout(20):
                while (await fixture_request("/state"))["audio_present"]:
                    await asyncio.sleep(0.2)
            phase("encrypted_baseline_and_audio_cleanup")
            await client.room.delete_room(api.DeleteRoomRequest(room=room_name))
            async with asyncio.timeout(20):
                while (
                    "voiceprint_sampler_active_rooms 0\n"
                    not in await (await http.get("http://sampler:8094/metrics")).text()
                ):
                    await asyncio.sleep(0.2)
            async with asyncio.timeout(20):
                while (await fixture_request("/state"))["ended_sessions"] != 1:
                    await asyncio.sleep(0.2)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            tasks.clear()
            for source in sources:
                await source.aclose()
            sources.clear()
            second = await client.room.create_room(
                api.CreateRoomRequest(name=room_name)
            )
            require(second.sid != created.sid, "new_occurrence_sid")
            second_room, _publication = await publisher(0, owner)
            second_query = {
                "room_sid": second.sid,
                "participant_sid": second_room.local_participant.sid,
            }
            async with asyncio.timeout(35):
                while True:
                    connection = await owner_request(
                        "GET",
                        "sampling-connection/",
                        params=second_query,
                        allowed=(200, 404),
                    )
                    if "control" in connection:
                        break
                    await asyncio.sleep(0.2)
            old = await owner_request(
                "GET",
                "sampling-connection/",
                params=query,
                allowed=(403,),
            )
            require(
                old.get("code") == "voiceprint_sampling_connection_ended",
                "old_occurrence_closed",
            )
            control = connection["control"]
            require(
                control["revision"] == 0 and control["shared_microphone"],
                "new_occurrence_declaration",
            )
            control = await owner_request(
                "PATCH",
                "sampling-control/",
                data={
                    "session_id": control["session_id"],
                    "participant_sid": second_query["participant_sid"],
                    "expected_revision": 0,
                    "paused": False,
                    "shared_microphone": False,
                    "device_group": "headset",
                },
            )
            async with asyncio.timeout(25):
                while True:
                    control = await owner_request(
                        "GET",
                        "sampling-control/",
                        params={
                            "session_id": control["session_id"],
                            "participant_sid": second_query["participant_sid"],
                        },
                    )
                    if control["runtime"]["state"] == "sampling":
                        break
                    await asyncio.sleep(1)
            phase("new_occurrence_sampling")
            control = await owner_request(
                "PATCH",
                "sampling-control/",
                data={
                    "session_id": control["session_id"],
                    "participant_sid": second_query["participant_sid"],
                    "expected_revision": control["revision"],
                    "paused": True,
                    "shared_microphone": False,
                    "device_group": "headset",
                },
            )
            require(
                control["state"] == "paused"
                and control["runtime"]["state"] == "stopped",
                "active_pause_projection",
            )
            await asyncio.sleep(2)
            state = await fixture_request("/state")
            require(
                state["candidates"] == 3 and state["canceled_permits"] >= 1,
                "active_pause_discarded",
            )
            await client.room.delete_room(api.DeleteRoomRequest(room=room_name))
            async with asyncio.timeout(20):
                while True:
                    state = await fixture_request("/state")
                    async with http.get("http://sampler:8094/metrics") as response:
                        released = (
                            "voiceprint_sampler_active_rooms 0\n"
                            in await response.text()
                        )
                    if state["ended_sessions"] == 2 and released:
                        break
                    await asyncio.sleep(0.2)
            phase("active_pause_and_occurrence_cleanup")
            await fixture_request("/finish", mutation=True)
            print(
                json.dumps(
                    {
                        "status": "passed",
                        "signed_webhooks": True,
                        "owner_https_csrf": True,
                        "real_dispatch": True,
                        "real_beat": True,
                        "new_occurrence_bound": True,
                        "active_pause_discarded": True,
                        "rtc_candidates": 3,
                        "owner_baseline": True,
                        "denied_subscribed": False,
                    }
                ),
                flush=True,
            )
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for room in rooms:
            await room.disconnect()
        for source in sources:
            await source.aclose()
        await client.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except Exception as error:  # noqa: BLE001 -- Report a fixed failure instead of private transport exception text.
        code = (
            str(error)
            if isinstance(error, RuntimeError)
            and str(error).startswith("rtc_media_probe_")
            else "rtc_media_probe_failed"
        )
        print(
            json.dumps(
                {"status": "failed", "code": code, "failure": type(error).__name__}
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from None
