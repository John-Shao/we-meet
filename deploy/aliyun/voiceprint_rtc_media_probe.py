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
from time import time_ns

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
    subscribed_tracks = set()
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

            async def publisher(index, actor, *, name=None):
                room = rtc.Room()
                rooms.append(room)

                def subscribed(track):
                    subscriptions[index] += 1
                    subscribed_tracks.add(track.sid)

                room.on("local_track_subscribed", subscribed)
                token = (
                    api.AccessToken(fixture["api_key"], fixture["api_secret"])
                    .with_identity(actor["identity"])
                    .with_grants(
                        api.VideoGrants(
                            room_join=True,
                            room=name or room_name,
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
                return room, await publish_microphone(room)

            async def publish_microphone(room):
                """Publish a fresh native track, including replacements on one connection."""
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
                return publication

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
            if fixture.get("media_boundaries"):
                # Keep the paused sampler's existing one-room capacity occupied;
                # its normal 30s idle deadline releases it without a restart.
                async with http.get("http://sampler:8094/metrics") as response:
                    require(
                        "voiceprint_sampler_active_rooms 1\n" in await response.text(),
                        "capacity_occupied",
                    )
                capacity_name = seed["capacity_room"]
                capacity = await client.room.create_room(
                    api.CreateRoomRequest(name=capacity_name)
                )
                capacity_publisher, _publication = await publisher(
                    0, owner, name=capacity_name
                )
                capacity_query = {
                    "room_sid": capacity.sid,
                    "participant_sid": capacity_publisher.local_participant.sid,
                }
                async with asyncio.timeout(25):
                    while True:
                        connection = await owner_request(
                            "GET",
                            "sampling-connection/",
                            params=capacity_query,
                            allowed=(200, 404),
                        )
                        if "control" in connection:
                            break
                        await asyncio.sleep(1)
                capacity_control = connection["control"]
                capacity_control = await owner_request(
                    "PATCH",
                    "sampling-control/",
                    data={
                        "session_id": capacity_control["session_id"],
                        "participant_sid": capacity_query["participant_sid"],
                        "expected_revision": 0,
                        "paused": False,
                        "shared_microphone": False,
                        "device_group": "headset",
                    },
                )
                async with asyncio.timeout(15):
                    while True:
                        dispatches = await client.agent_dispatch.list_dispatch(
                            capacity_name
                        )
                        empty = next(
                            (
                                item
                                for item in dispatches
                                if item.agent_name == "fixture-sampler"
                                and not item.state.jobs
                                and not item.state.deleted_at
                                and json.loads(item.metadata)
                                == {"voiceprint": {"livekit_room_sid": capacity.sid}}
                            ),
                            None,
                        )
                        if empty is not None:
                            break
                        await asyncio.sleep(0.2)
                phase("capacity_forced_real_empty_dispatch")
                async with asyncio.timeout(90):
                    while True:
                        capacity_control = await owner_request(
                            "GET",
                            "sampling-control/",
                            params={
                                "session_id": capacity_control["session_id"],
                                "participant_sid": capacity_query["participant_sid"],
                            },
                        )
                        if capacity_control["runtime"]["state"] == "sampling":
                            break
                        await asyncio.sleep(2)
                capacity_control = await owner_request(
                    "PATCH",
                    "sampling-control/",
                    data={
                        "session_id": capacity_control["session_id"],
                        "participant_sid": capacity_query["participant_sid"],
                        "expected_revision": capacity_control["revision"],
                        "paused": True,
                        "shared_microphone": False,
                        "device_group": "headset",
                    },
                )
                retired = await client.agent_dispatch.get_dispatch(
                    empty.id, capacity_name
                )
                dispatches = await client.agent_dispatch.list_dispatch(capacity_name)
                require(
                    (retired is None or retired.state.deleted_at)
                    and any(
                        item.id != empty.id
                        and item.agent_name == "fixture-sampler"
                        and item.state.jobs
                        for item in dispatches
                    ),
                    "empty_receipt_replaced_and_assigned",
                )
                require(
                    (await fixture_request("/state"))["candidates"] == 3,
                    "capacity_recovery_no_extra_candidate",
                )
                await client.room.delete_room(api.DeleteRoomRequest(room=capacity_name))
                await capacity_publisher.disconnect()
                phase("real_empty_dispatch_recovered")
            await client.room.delete_room(api.DeleteRoomRequest(room=room_name))
            async with asyncio.timeout(20):
                while True:
                    state = await fixture_request("/state")
                    async with http.get("http://sampler:8094/metrics") as response:
                        released = (
                            "voiceprint_sampler_active_rooms 0\n"
                            in await response.text()
                        )
                    if (
                        state["ended_sessions"]
                        == (3 if fixture.get("media_boundaries") else 2)
                        and released
                    ):
                        break
                    await asyncio.sleep(0.2)
            phase("active_pause_and_occurrence_cleanup")
            if fixture.get("media_boundaries"):

                async def stop_feeds():
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    tasks.clear()
                    for source in sources:
                        await source.aclose()
                    sources.clear()

                async def connected(room_sid, participant_sid):
                    query = {"room_sid": room_sid, "participant_sid": participant_sid}
                    async with asyncio.timeout(35):
                        while True:
                            connection = await owner_request(
                                "GET",
                                "sampling-connection/",
                                params=query,
                                allowed=(200, 404),
                            )
                            if "control" in connection:
                                return query, connection["control"]
                            await asyncio.sleep(1)

                async def change(control, query, *, paused=False, group="headset"):
                    return await owner_request(
                        "PATCH",
                        "sampling-control/",
                        data={
                            "session_id": control["session_id"],
                            "participant_sid": query["participant_sid"],
                            "expected_revision": control["revision"],
                            "paused": paused,
                            "shared_microphone": False,
                            "device_group": group,
                        },
                    )

                async def runtime(control, query, expected, *, minimum_permits=0):
                    result = {
                        "runtime": {"state": "unavailable", "reason": "http_deadline"}
                    }

                    async def observe(event):
                        dispatches = await client.agent_dispatch.list_dispatch(
                            room_name
                        )
                        state = await fixture_request("/state")
                        async with http.get("http://sampler:8094/metrics") as response:
                            metrics = await response.text()

                        def exact_scope(item):
                            try:
                                return json.loads(item.metadata) == {
                                    "voiceprint": {
                                        "livekit_room_sid": query["room_sid"]
                                    }
                                }
                            except (ValueError, TypeError):
                                return False

                        print(
                            json.dumps(
                                {
                                    "event": event,
                                    "expected": expected,
                                    "runtime_state": result["runtime"]["state"],
                                    "runtime_reason": result["runtime"]["reason"],
                                    "permits": state["permits"],
                                    "dispatches": [
                                        {
                                            "deleted": bool(item.state.deleted_at),
                                            "sampler_agent": item.agent_name
                                            == "fixture-sampler",
                                            "same_scope": exact_scope(item),
                                            "age_seconds": (
                                                time_ns() - item.state.created_at
                                            )
                                            // 1_000_000_000
                                            if item.state.created_at
                                            else None,
                                            "jobs": [
                                                job.state.status
                                                for job in item.state.jobs
                                            ],
                                        }
                                        for item in dispatches
                                    ],
                                    "sampler_idle": "voiceprint_sampler_active_rooms 0\n"
                                    in metrics,
                                    "sampler_ready": "voiceprint_sampler_ready 1\n"
                                    in metrics,
                                }
                            ),
                            flush=True,
                        )

                    started = asyncio.get_running_loop().time()
                    observed = False
                    try:
                        # Recovery scans use a 30s recheck plus 15s Beat cadence;
                        # leave room for RPC and native process initialization.
                        async with asyncio.timeout(75):
                            while True:
                                result = await owner_request(
                                    "GET",
                                    "sampling-control/",
                                    params={
                                        "session_id": control["session_id"],
                                        "participant_sid": query["participant_sid"],
                                    },
                                )
                                if result["runtime"]["state"] == expected:
                                    if (
                                        not minimum_permits
                                        or (await fixture_request("/state"))["permits"]
                                        >= minimum_permits
                                    ):
                                        return result
                                if (
                                    not observed
                                    and asyncio.get_running_loop().time() - started
                                    >= 25
                                ):
                                    await observe("boundary_runtime_pending")
                                    observed = True
                                await asyncio.sleep(2)
                    except TimeoutError:
                        await observe("boundary_runtime_deadline")
                        raise RuntimeError(
                            "rtc_media_probe_runtime_" + expected
                        ) from None

                async def close_occurrence(count):
                    await client.room.delete_room(api.DeleteRoomRequest(room=room_name))
                    async with asyncio.timeout(20):
                        while True:
                            state = await fixture_request("/state")
                            async with http.get(
                                "http://sampler:8094/metrics"
                            ) as response:
                                released = (
                                    "voiceprint_sampler_active_rooms 0\n"
                                    in await response.text()
                                )
                            if state["ended_sessions"] == count and released:
                                require(
                                    state["candidates"] == 3, "no_interrupted_candidate"
                                )
                                return state
                            await asyncio.sleep(0.2)

                await stop_feeds()
                third = await client.room.create_room(
                    api.CreateRoomRequest(name=room_name)
                )
                phase("native_mute_room_created")
                media_room, original = await publisher(0, owner)
                media_query, control = await connected(
                    third.sid, media_room.local_participant.sid
                )
                control = await change(control, media_query)
                phase("native_mute_declaration_committed")
                control = await runtime(control, media_query, "sampling")
                original.track.mute()
                control = await runtime(control, media_query, "waiting")
                await asyncio.sleep(1)
                state = await fixture_request("/state")
                require(
                    state["candidates"] == 3 and state["permit_bindings_consistent"],
                    "mute_discards_capture",
                )
                phase("native_mute_discarded")
                muted_revision = control["revision"]
                unmute_started = asyncio.get_running_loop().time()
                original.track.unmute()
                control = await runtime(
                    control,
                    media_query,
                    "sampling",
                    minimum_permits=state["permits"] + 1,
                )
                require(
                    control["revision"] == muted_revision
                    and not control["paused"]
                    and (await fixture_request("/state"))["candidates"] == 3,
                    "unmute_recovers_without_control_change",
                )
                print(
                    json.dumps(
                        {
                            "event": "rtc_media_probe_phase",
                            "phase": "native_unmute_automatically_recovered",
                            "elapsed_seconds": round(
                                asyncio.get_running_loop().time() - unmute_started, 2
                            ),
                        }
                    ),
                    flush=True,
                )
                before_replacement = await fixture_request("/state")
                await media_room.local_participant.unpublish_track(original.sid)
                replacement = await publish_microphone(media_room)
                require(replacement.sid != original.sid, "replacement_track_sid")
                control = await runtime(
                    control,
                    media_query,
                    "sampling",
                    minimum_permits=before_replacement["permits"] + 1,
                )
                state = await fixture_request("/state")
                require(
                    state["permits"] > before_replacement["permits"]
                    and state["permit_bindings_consistent"]
                    and state["candidates"] == 3
                    and replacement.sid in subscribed_tracks,
                    "replacement_requires_fresh_permit",
                )
                control = await change(control, media_query, paused=True)
                await close_occurrence(4)
                phase("native_unmute_and_replacement_bound")

                await stop_feeds()
                fourth = await client.room.create_room(
                    api.CreateRoomRequest(name=room_name)
                )
                first_connection, first_publication = await publisher(0, owner)
                first_query, control = await connected(
                    fourth.sid, first_connection.local_participant.sid
                )
                control = await change(control, first_query)
                control = await runtime(control, first_query, "sampling")
                first_publication.track.mute()
                control = await runtime(control, first_query, "waiting")
                async with asyncio.timeout(8):
                    while True:
                        dispatches = await client.agent_dispatch.list_dispatch(
                            room_name
                        )
                        previous_dispatch = next(
                            (
                                item
                                for item in dispatches
                                if item.agent_name == "fixture-sampler"
                                and not item.state.deleted_at
                                and any(
                                    job.state.status in {0, 1}
                                    for job in item.state.jobs
                                )
                                and json.loads(item.metadata)
                                == {"voiceprint": {"livekit_room_sid": fourth.sid}}
                            ),
                            None,
                        )
                        if previous_dispatch is not None:
                            break
                        await asyncio.sleep(0.2)
                async with asyncio.timeout(55):
                    while True:
                        async with http.get("http://sampler:8094/metrics") as response:
                            metrics = await response.text()
                        if "voiceprint_sampler_active_rooms 0\n" in metrics:
                            break
                        await asyncio.sleep(1)
                stopped_dispatch = await client.agent_dispatch.get_dispatch(
                    previous_dispatch.id, room_name
                )
                print(
                    json.dumps(
                        {
                            "event": "rtc_media_probe_phase",
                            "phase": "long_mute_sampler_idle",
                            "jobs": [
                                job.state.status for job in stopped_dispatch.state.jobs
                            ]
                            if stopped_dispatch is not None
                            else [],
                            "sampler_ready": "voiceprint_sampler_ready 1\n" in metrics,
                        }
                    ),
                    flush=True,
                )
                before_resume = await fixture_request("/state")
                frozen_revision = control["revision"]
                idle_resume_started = asyncio.get_running_loop().time()
                first_publication.track.unmute()
                control = await runtime(
                    control,
                    first_query,
                    "sampling",
                    minimum_permits=before_resume["permits"] + 1,
                )
                # Stop this proof clip before waiting for asynchronously attached
                # dispatch job metadata; recovery must not add a fourth sample.
                first_publication.track.mute()

                def fresh_dispatch(item):
                    return (
                        item.id != previous_dispatch.id
                        and item.agent_name == "fixture-sampler"
                        and any(job.state.status in {0, 1} for job in item.state.jobs)
                        and json.loads(item.metadata)
                        == {"voiceprint": {"livekit_room_sid": fourth.sid}}
                    )

                async with asyncio.timeout(8):
                    inspected = False
                    while True:
                        dispatches = await client.agent_dispatch.list_dispatch(
                            room_name
                        )
                        if not inspected:
                            print(
                                json.dumps(
                                    {
                                        "event": "rtc_media_probe_phase",
                                        "phase": "new_dispatch_job_observation",
                                        "control_revision_unchanged": control[
                                            "revision"
                                        ]
                                        == frozen_revision,
                                        "receipts": [
                                            {
                                                "different_id": item.id
                                                != previous_dispatch.id,
                                                "sampler_agent": item.agent_name
                                                == "fixture-sampler",
                                                "same_scope": json.loads(item.metadata)
                                                == {
                                                    "voiceprint": {
                                                        "livekit_room_sid": fourth.sid
                                                    }
                                                }
                                                if item.agent_name == "fixture-sampler"
                                                else False,
                                                "jobs": [
                                                    job.state.status
                                                    for job in item.state.jobs
                                                ],
                                            }
                                            for item in dispatches
                                        ],
                                    }
                                ),
                                flush=True,
                            )
                            inspected = True
                        if any(fresh_dispatch(item) for item in dispatches):
                            break
                        await asyncio.sleep(0.2)
                retired_dispatch = await client.agent_dispatch.get_dispatch(
                    previous_dispatch.id, room_name
                )
                retired_jobs = (
                    [job.state.status for job in retired_dispatch.state.jobs]
                    if retired_dispatch is not None
                    else []
                )
                old_ended = (
                    retired_dispatch is None
                    or bool(retired_dispatch.state.deleted_at)
                    or bool(retired_jobs)
                    and all(status in {2, 3} for status in retired_jobs)
                )
                print(
                    json.dumps(
                        {
                            "event": "rtc_media_probe_phase",
                            "phase": "idle_recovery_dispatch_evidence",
                            "old_receipt_present": retired_dispatch is not None,
                            "old_jobs": retired_jobs,
                            "old_ended": old_ended,
                            "control_revision_unchanged": control["revision"]
                            == frozen_revision,
                            "new_active_dispatch": any(
                                fresh_dispatch(item) for item in dispatches
                            ),
                            "candidate_count": (await fixture_request("/state"))[
                                "candidates"
                            ],
                        }
                    ),
                    flush=True,
                )
                require(
                    control["revision"] == frozen_revision
                    and old_ended
                    and any(fresh_dispatch(item) for item in dispatches)
                    and (await fixture_request("/state"))["candidates"] == 3,
                    "idle_exit_replaced_without_control_change",
                )
                print(
                    json.dumps(
                        {
                            "event": "rtc_media_probe_phase",
                            "phase": "long_mute_idle_exit_recovered",
                            "elapsed_seconds": round(
                                asyncio.get_running_loop().time() - idle_resume_started,
                                2,
                            ),
                        }
                    ),
                    flush=True,
                )
                await first_connection.disconnect()
                await stop_feeds()
                reconnected, new_publication = await publisher(0, owner)
                new_query, control = await connected(
                    fourth.sid, reconnected.local_participant.sid
                )
                require(
                    new_query["participant_sid"] != first_query["participant_sid"]
                    and control["revision"] == 0
                    and control["shared_microphone"],
                    "reconnect_requires_declaration",
                )
                old = await owner_request(
                    "GET", "sampling-connection/", params=first_query, allowed=(403,)
                )
                require(
                    old.get("code") == "voiceprint_sampling_connection_ended",
                    "old_participant_rejected",
                )
                await asyncio.sleep(1)
                require(
                    new_publication.sid not in subscribed_tracks,
                    "reconnect_not_implicitly_subscribed",
                )
                control = await change(control, new_query, group="handset")
                await runtime(control, new_query, "sampling")
                state = await close_occurrence(5)
                require(
                    state["permit_bindings_consistent"]
                    and state["consumed_permits"] == 3,
                    "disconnect_and_room_interrupt_discarded",
                )
                phase("native_reconnect_and_room_interrupt_bound")
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
                        "empty_dispatch_recovered": bool(
                            fixture.get("media_boundaries")
                        ),
                        "native_media_boundaries": bool(
                            fixture.get("media_boundaries")
                        ),
                        "automatic_unmute_recovered": bool(
                            fixture.get("media_boundaries")
                        ),
                        "idle_exit_recovered": bool(fixture.get("media_boundaries")),
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
        probe_line = None
        for failure in (error, error.__cause__):
            trace = failure.__traceback__ if failure is not None else None
            while trace is not None:
                if trace.tb_frame.f_code.co_filename == __file__:
                    probe_line = trace.tb_lineno
                trace = trace.tb_next
        print(
            json.dumps(
                {
                    "status": "failed",
                    "code": code,
                    "failure": type(error).__name__,
                    "probe_line": probe_line,
                }
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from None
