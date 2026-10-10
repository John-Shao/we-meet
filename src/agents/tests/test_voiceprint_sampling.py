"""Synthetic RTC frames and isolated HTTP; never open a microphone or cloud ASR."""

import asyncio
import io
import json
import unittest
import wave
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

from livekit import rtc
from livekit.agents import AutoSubscribe

from voiceprint import sampler
from voiceprint.client import SamplingClient, SamplingError, grant_valid


def fixture():
    """One human microphone publication and a fully bound private permit."""
    origin = {
        "room_sid": "RM_fixture",
        "participant_sid": "PA_fixture",
        "track_sid": "TR_fixture",
    }
    publication = SimpleNamespace(
        sid=origin["track_sid"],
        kind=rtc.TrackKind.KIND_AUDIO,
        source=rtc.TrackSource.SOURCE_MICROPHONE,
        muted=False,
        track=object(),
        set_subscribed=mock.Mock(),
    )
    participant = SimpleNamespace(
        sid=origin["participant_sid"],
        identity="signed-sub",
        kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD,
        track_publications={publication.sid: publication},
    )
    room = SimpleNamespace(
        sid=origin["room_sid"],
        name=str(uuid4()),
        remote_participants={participant.identity: participant},
    )
    ctx = SimpleNamespace(room=room)
    grant = {
        **origin,
        "id": str(uuid4()),
        "user_id": str(uuid4()),
        "session_id": str(uuid4()),
        "identity": participant.identity,
        "token": "A" * 43,
        "max_duration_ms": 3000,
        "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat(),
        "sample_rate": 24000,
        "channels": 1,
    }
    client = SimpleNamespace(
        issue=mock.AsyncMock(return_value=grant),
        validate=mock.AsyncMock(return_value=True),
        upload=mock.AsyncMock(return_value={"id": str(uuid4())}),
    )
    return ctx, participant, publication, client, grant, origin


class Stream:
    """Frames use the real SDK's signed-int16 memoryview layout."""

    def __init__(self, *, delay=0):
        """Keep synthetic frame references and lifetime evidence bounded."""
        self._queue = sampler.FrameQueue()
        self.delay = delay
        self.aclose = mock.AsyncMock()
        self.count = 0

    async def __anext__(self):
        """Produce one synthetic 20ms frame at a controllable interval."""
        await asyncio.sleep(self.delay)
        self.count += 1
        frame = rtc.AudioFrame(b"\x01\x00" * 480, 24000, 1, 480)
        return SimpleNamespace(frame=frame)


class SamplingRuntimeTests(unittest.IsolatedAsyncioTestCase):
    """Exercise selective subscription, authorization loss and bounded media."""

    async def test_native_sdk_source_guard_and_close_with_synthetic_pcm(self):
        """Use native FFI audio only; no microphone or cloud connection."""
        source = rtc.AudioSource(24000, 1, queue_size_ms=20)
        track = rtc.LocalAudioTrack.create_audio_track("synthetic-fixture", source)
        stream = await sampler.audio_stream(track)

        async def produce():
            for _ in range(150):
                await source.capture_frame(
                    rtc.AudioFrame(b"\x01\x00" * 480, 24000, 1, 480)
                )
            await source.wait_for_playout()

        task = asyncio.create_task(produce())
        try:
            audio = await sampler.collect(
                stream, 3000, mock.AsyncMock(return_value=True)
            )
            await asyncio.wait_for(task, timeout=2)
            with wave.open(io.BytesIO(audio), "rb") as reader:
                self.assertEqual(reader.getnframes(), 72000)
            self.assertFalse(stream._queue.overflow)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await asyncio.wait_for(stream.aclose(), timeout=2)
            await source.aclose()

    async def test_valid_clip_is_canonical_bounded_and_unsubscribed_before_upload(self):
        """PCM from actual SDK frame objects survives admission formatting."""
        ctx, participant, publication, client, grant, _ = fixture()
        runtime = sampler.Sampler(ctx, client, ctx.room.sid)
        stream = Stream()
        captured = []
        client.upload.side_effect = lambda _grant, _origin, wav: captured.append(
            bytes(wav)
        )
        with mock.patch.object(
            sampler, "audio_stream", mock.AsyncMock(return_value=stream)
        ):
            await runtime.attempt(participant, publication)
        self.assertEqual(
            publication.set_subscribed.call_args_list,
            [mock.call(True), mock.call(False)],
        )
        stream.aclose.assert_awaited_once()
        client.upload.assert_awaited_once()
        audio = captured[0]
        self.assertEqual(client.upload.call_args.args[2], bytearray())
        with wave.open(io.BytesIO(audio), "rb") as reader:
            self.assertEqual(
                (reader.getnchannels(), reader.getframerate(), reader.getnframes()),
                (1, 24000, 72000),
            )
        self.assertLessEqual(len(audio), sampler.MAX_PCM_BYTES + 44)
        self.assertEqual(stream.count, 150)

    async def test_denied_or_wrong_origin_never_subscribes(self):
        """Neither metadata nor an unavailable permit grants a media subscription."""
        for kind in (
            "denied",
            "agent",
            "screen",
            "muted",
            "reconnected",
            "wrong_grant",
        ):
            with self.subTest(kind=kind):
                ctx, participant, publication, client, grant, _ = fixture()
                if kind == "denied":
                    client.issue.return_value = None
                elif kind == "agent":
                    participant.kind = rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
                elif kind == "screen":
                    publication.source = rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO
                elif kind == "muted":
                    publication.muted = True
                elif kind == "reconnected":
                    ctx.room.remote_participants[participant.identity] = (
                        SimpleNamespace()
                    )
                else:
                    grant["participant_sid"] = "PA_other"
                runtime = sampler.Sampler(ctx, client, ctx.room.sid)
                try:
                    await runtime.attempt(participant, publication)
                except SamplingError:
                    self.assertEqual(kind, "wrong_grant")
                publication.set_subscribed.assert_not_called()
                client.upload.assert_not_awaited()

    async def test_mid_clip_revocation_discards_every_byte_and_closes(self):
        """A failed heartbeat cannot be treated as a successful partial capture."""
        ctx, participant, publication, client, _, _ = fixture()
        client.validate.side_effect = [True, False]
        runtime = sampler.Sampler(ctx, client, ctx.room.sid)
        stream = Stream(delay=0.01)
        with mock.patch.object(
            sampler, "audio_stream", mock.AsyncMock(return_value=stream)
        ):
            with self.assertRaisesRegex(SamplingError, "authorization_revoked"):
                await runtime.attempt(participant, publication)
        client.upload.assert_not_awaited()
        self.assertEqual(
            publication.set_subscribed.call_args_list,
            [mock.call(True), mock.call(False)],
        )
        stream.aclose.assert_awaited_once()

    async def test_queue_overflow_is_fatal_and_never_stitches_gaps(self):
        """The SDK's silent drop behavior is surfaced as a rejected clip."""
        queue = sampler.FrameQueue()
        for index in range(sampler.FRAME_CAPACITY + 1):
            queue.put(index)
        self.assertEqual(len(queue.frames), sampler.FRAME_CAPACITY)
        with self.assertRaisesRegex(SamplingError, "frame_overflow"):
            await queue.get()
        stream = Stream()
        stream._queue = queue
        with self.assertRaises(SamplingError):
            await sampler.collect(stream, 3000, mock.AsyncMock(return_value=True))

    async def test_cancellation_always_unsubscribes_and_never_uploads(self):
        """Worker shutdown retrieves its collector and heartbeat tasks."""
        ctx, participant, publication, client, _, _ = fixture()
        runtime = sampler.Sampler(ctx, client, ctx.room.sid)
        stream = Stream(delay=0.01)
        with mock.patch.object(
            sampler, "audio_stream", mock.AsyncMock(return_value=stream)
        ):
            task = asyncio.create_task(runtime.attempt(participant, publication))
            await asyncio.sleep(0.03)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(
            publication.set_subscribed.call_args_list[-1], mock.call(False)
        )
        stream.aclose.assert_awaited_once()
        client.upload.assert_not_awaited()

    async def test_entrypoint_disables_automatic_subscription_and_checks_room_sid(self):
        """A room mismatch shuts down without subscribing."""
        ctx, _, _, _, _, _ = fixture()
        ctx.job = SimpleNamespace(
            metadata=json.dumps({"voiceprint": {"livekit_room_sid": "RM_other"}})
        )
        ctx.connect = mock.AsyncMock()
        ctx.shutdown = mock.Mock()
        with mock.patch.object(SamplingClient, "from_env", return_value=object()):
            await sampler.entrypoint(ctx)
        ctx.connect.assert_awaited_once_with(
            auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE
        )
        ctx.shutdown.assert_called_once()

    async def test_ambiguous_issue_and_upload_reuse_the_same_nonce_and_bytes(self):
        """Transport retries reuse the same reservation and audio."""
        client = SamplingClient(
            "http://localhost:9", "synthetic-distinct-sampler-token-001"
        )
        _, _, _, _, grant, origin = fixture()
        with mock.patch.object(
            client, "_send", new_callable=mock.AsyncMock, side_effect=[None, grant]
        ) as send:
            self.assertEqual(await client.issue(origin), grant)
            self.assertEqual(send.call_args_list[0], send.call_args_list[1])
        result = {"id": str(uuid4())}
        with mock.patch.object(
            client, "_send", new_callable=mock.AsyncMock, side_effect=[None, result]
        ) as send:
            self.assertEqual(
                await client.upload(grant, origin, b"bounded-fixture"), result
            )
            self.assertEqual(send.call_args_list[0], send.call_args_list[1])

    async def test_all_microphone_metadata_is_rotated_without_a_room_size_cutoff(self):
        """Later participants stay eligible without per-user audio queues."""
        ctx, participant, publication, client, _, _ = fixture()
        ctx.room.remote_participants = {}
        for index in range(140):
            peer = SimpleNamespace(
                kind=participant.kind,
                identity=str(index),
                track_publications={publication.sid: publication},
            )
            ctx.room.remote_participants[peer.identity] = peer
        runtime = sampler.Sampler(ctx, client, ctx.room.sid)
        selected = [runtime.next_source()[0].identity for _ in range(141)]
        self.assertEqual(selected[:140], [str(index) for index in range(140)])
        self.assertEqual(selected[140], "0")

    async def test_real_http_deadline_redirect_compression_and_byte_budget(self):
        """A local TCP fixture cannot trickle forever or redirect the sampler secret."""
        from voiceprint import (  # noqa: PLC0415 -- Local HTTP deadline fixture.
            client as transport,
        )

        mode = {"value": "ok"}
        paths = []

        async def serve(reader, writer):
            try:
                headers = await reader.readuntil(b"\r\n\r\n")
                paths.append(headers.split(b"\r\n", 1)[0])
                if mode["value"] == "slow":
                    writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{")
                    await writer.drain()
                    await asyncio.sleep(0.4)
                    writer.write(b"}")
                elif mode["value"] == "redirect":
                    writer.write(
                        b"HTTP/1.1 302 Found\r\nLocation: /forbidden\r\n"
                        b"Content-Length: 0\r\n\r\n"
                    )
                elif mode["value"] == "compressed":
                    writer.write(
                        b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n"
                        b"Content-Length: 2\r\n\r\n{}"
                    )
                else:
                    body = (
                        b"{}"
                        if mode["value"] == "ok"
                        else b"x" * (transport.MAX_RESPONSE + 1)
                    )
                    writer.write(
                        b"HTTP/1.1 200 OK\r\nContent-Length: "
                        + str(len(body)).encode()
                        + b"\r\n\r\n"
                        + body
                    )
                await writer.drain()
            except (ConnectionError, asyncio.IncompleteReadError):
                pass
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        client = SamplingClient(
            f"http://127.0.0.1:{port}", "synthetic-distinct-sampler-token-001"
        )
        async with server:
            self.assertEqual(await client._send("POST", "", b""), {})
            for name in ("redirect", "compressed", "too_large", "slow"):
                mode["value"] = name
                with mock.patch.object(transport, "HTTP_SECONDS", 0.15):
                    before = asyncio.get_running_loop().time()
                    self.assertIsNone(await client._send("POST", "", b""))
                    self.assertLess(asyncio.get_running_loop().time() - before, 0.4)
            self.assertFalse(any(b"/forbidden" in path for path in paths))
            await asyncio.sleep(0.45)

    def test_grant_and_configuration_reject_unbound_or_unbounded_values(self):
        """Do not accept broad durations, expired grants or secret-bearing URLs."""
        _, _, _, _, grant, origin = fixture()
        for change in (
            {"max_duration_ms": True},
            {"max_duration_ms": 10001},
            {"token": "声" * 43},
            {"identity": "another"},
            {"room_sid": "RM_other"},
        ):
            with self.assertRaises(SamplingError):
                grant_valid({**grant, **change}, origin, "signed-sub")
        for url in (
            "file:///secret",
            "http://user:secret@localhost",
            "http://localhost?forward=1",
        ):
            with self.assertRaises(SamplingError):
                SamplingClient(url, "synthetic-distinct-sampler-token-001")


if __name__ == "__main__":
    unittest.main()
