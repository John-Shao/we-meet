"""Visible microphone sampler: opt-in origins, one bounded clip, then unsubscribe."""

import asyncio
import inspect
import io
import json
import wave
from collections import deque

from livekit import rtc
from livekit.agents import AutoSubscribe

from voiceprint.client import (
    MAX_CLIP_MS,
    MIN_CLIP_MS,
    SamplingClient,
    SamplingError,
    grant_valid,
    identifier,
)

FRAME_CAPACITY = 8
RATE = 24000
MAX_PCM_BYTES = RATE * 2 * 10
IDLE_SECONDS = 30


def metadata(raw):
    """Dispatch carries only a room occurrence reference, never authorization."""
    try:
        value = json.loads(raw)
        if set(value) != {"voiceprint"} or set(value["voiceprint"]) != {
            "livekit_room_sid"
        }:
            raise ValueError
        return identifier(value["voiceprint"]["livekit_room_sid"])
    except (ValueError, TypeError, KeyError):
        raise SamplingError("sampling_metadata_invalid") from None


class FrameQueue:
    """Bound SDK buffering and detect any dropped frames instead of stitching gaps."""

    def __init__(self, capacity=FRAME_CAPACITY):
        """Keep at most eight SDK frames; overflow permanently invalidates the clip."""
        self.capacity = capacity
        self.frames = deque()
        self.ready = asyncio.Event()
        self.overflow = False

    def put(self, item):
        """Discard the oldest reference on overflow and signal failure to the reader."""
        if len(self.frames) >= self.capacity:
            self.frames.popleft()
            self.overflow = True
        self.frames.append(item)
        self.ready.set()

    async def get(self):
        """A discontinuous clip must never proceed to admission or quality analysis."""
        while not self.frames:
            await self.ready.wait()
        if self.overflow:
            raise SamplingError("sampling_frame_overflow")
        self.ready.clear()
        return self.frames.popleft()


async def audio_stream(track):
    """Guard the pinned SDK's bounded queue before its first event-loop yield."""
    stream = rtc.AudioStream(
        track,
        capacity=FRAME_CAPACITY,
        sample_rate=RATE,
        num_channels=1,
        frame_size_ms=20,
    )
    # The pinned SDK silently drops oldest frames. A guard makes that event fatal.
    # Fail closed if a future SDK no longer exposes the probed queue contract.
    if (
        not hasattr(stream, "_queue")
        or not hasattr(stream._queue, "put")
        or not hasattr(stream._queue, "get")
    ):
        await asyncio.wait_for(stream.aclose(), timeout=2)
        raise SamplingError("sampling_sdk_incompatible")
    stream._queue = FrameQueue()
    return stream


def wav_bytes(pcm):
    """Canonical mono PCM16 WAV, never a disk file or an external media URL."""
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(RATE)
        writer.writeframes(pcm)
    return output.getvalue()


def wipe(value):
    """Overwrite and release the buffers owned by this sampler."""
    value[:] = b"\x00" * len(value)
    value.clear()


async def collect(stream, maximum, authorized, *, on_frame=None):
    """Capture a bounded continuous interval and independently recheck authority."""
    if type(maximum) is not int or not MIN_CLIP_MS <= maximum <= MAX_CLIP_MS:
        raise SamplingError("sampling_budget_invalid")
    pcm = bytearray()
    transferred = False

    async def read():
        limit = RATE * 2 * maximum // 1000
        while len(pcm) < limit:
            event = await asyncio.wait_for(anext(stream), timeout=1)
            frame = event.frame
            if (
                frame.sample_rate != RATE
                or frame.num_channels != 1
                or type(frame.samples_per_channel) is not int
                or not 1 <= frame.samples_per_channel <= RATE // 10
                or frame.data.nbytes != frame.samples_per_channel * 2
            ):
                raise SamplingError("sampling_frame_invalid")
            pcm.extend(bytes(frame.data)[: limit - len(pcm)])
            if on_frame is not None:
                on_frame()
        return bytearray(wav_bytes(pcm))

    async def watch():
        while True:
            await asyncio.sleep(0.5)
            if not await authorized():
                raise SamplingError("sampling_authorization_revoked")

    reader = asyncio.create_task(read())
    watcher = asyncio.create_task(watch())
    try:
        done, _ = await asyncio.wait(
            (reader, watcher),
            timeout=maximum / 1000 + 3,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if watcher in done:
            await watcher
        if reader not in done:
            raise SamplingError("sampling_capture_timeout")
        result = await reader
        if getattr(stream._queue, "overflow", False) or not await authorized():
            raise SamplingError("sampling_authorization_revoked")
        transferred = True
        return result
    finally:
        reader.cancel()
        watcher.cancel()
        try:
            await asyncio.gather(reader, watcher, return_exceptions=True)
        finally:
            wipe(pcm)
            if (
                not transferred
                and reader.done()
                and not reader.cancelled()
                and reader.exception() is None
            ):
                wipe(reader.result())


class Sampler:
    """One subscription per room process; no frame queues per unauthorized user."""

    def __init__(self, ctx, client, room_sid):
        """Freeze the room occurrence and track only currently owned resources."""
        self.ctx, self.client, self.room_sid = ctx, client, room_sid
        self.stopped = asyncio.Event()
        self.publication = None
        self.stream = None
        self.cursor = 0
        self.last_authorized = asyncio.get_running_loop().time()
        self.phase = "waiting"
        self.sequence = 0

    async def validate(self, grant, origin):
        """Bounded, ordered progress carries no frames, text or user labels."""
        progress = getattr(self.client, "progress", None)
        if progress is None:
            return await self.client.validate(grant, origin)
        self.sequence += 1
        return await progress(grant, origin, self.phase, self.sequence)

    def received_frame(self):
        """Do not claim sampling until a validated PCM frame was received."""
        self.phase = "sampling"

    def current(self, participant, publication, origin, identity):
        """Reject reconnects, replacements, mute and agent tracks."""
        return (
            not self.stopped.is_set()
            and participant.sid == origin["participant_sid"]
            and participant.identity == identity
            and participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
            and publication.sid == origin["track_sid"]
            and publication.source == rtc.TrackSource.SOURCE_MICROPHONE
            and publication.kind == rtc.TrackKind.KIND_AUDIO
            and not publication.muted
            and self.ctx.room.remote_participants.get(identity) is participant
            and participant.track_publications.get(publication.sid) is publication
        )

    async def attempt(self, participant, publication):
        """Subscribe only with a permit and discard every failed interval."""
        origin = {
            "room_sid": self.room_sid,
            "participant_sid": identifier(participant.sid),
            "track_sid": identifier(publication.sid),
        }
        identity = participant.identity
        if not self.current(participant, publication, origin, identity):
            return
        grant = await self.client.issue(origin)
        if grant is None:
            return
        grant_valid(grant, origin, identity)
        self.phase = "waiting"

        async def authorized():
            # Validation yields; mute/reconnect can change the source in flight.
            return (
                self.current(participant, publication, origin, identity)
                and await self.validate(grant, origin)
                and self.current(participant, publication, origin, identity)
            )

        wav = None
        try:
            if not await authorized():
                return
            self.last_authorized = asyncio.get_running_loop().time()
            try:
                self.publication = publication
                publication.set_subscribed(True)
                async with asyncio.timeout(2):
                    while publication.track is None:
                        if not self.current(participant, publication, origin, identity):
                            raise SamplingError("sampling_source_changed")
                        await asyncio.sleep(0.02)
                self.stream = await audio_stream(publication.track)
                wav = await collect(
                    self.stream,
                    grant["max_duration_ms"],
                    authorized,
                    on_frame=self.received_frame,
                )
            finally:
                await self.release()
            self.phase = "uploading"
            if wav is not None and await authorized():
                await self.client.upload(grant, origin, wav)
        finally:
            if wav is not None:
                wipe(wav)
            self.phase = "stopped"
            progress = getattr(self.client, "progress", None)
            if progress is not None:
                self.sequence += 1
                try:
                    await progress(grant, origin, self.phase, self.sequence)
                except (SamplingError, OSError, TimeoutError):
                    pass  # Never extend stale progress after losing its authority.

    async def release(self):
        """Always stop receiving before closing media resources or sending a receipt."""
        publication, self.publication = self.publication, None
        stream, self.stream = self.stream, None
        try:
            if publication is not None:
                publication.set_subscribed(False)
        finally:
            if stream is not None:
                try:
                    await asyncio.wait_for(stream.aclose(), timeout=2)
                except (TimeoutError, RuntimeError):
                    self.stopped.set()
                    raise

    async def close(self):
        """Mark all authorization callbacks invalid during worker shutdown."""
        self.stopped.set()
        await self.release()

    async def run(self):
        """Rotate bounded metadata candidates fairly; denied sources never subscribe."""
        self.ctx.room.on("disconnected", lambda *_args: self.stopped.set())
        while not self.stopped.is_set():
            if asyncio.get_running_loop().time() - self.last_authorized >= IDLE_SECONDS:
                break
            selected = self.next_source()
            if selected:
                try:
                    await self.attempt(*selected)
                except (SamplingError, OSError, TimeoutError, StopAsyncIteration):
                    pass  # No raw exceptions, identity, token or audio enter logs.
            try:
                await asyncio.wait_for(self.stopped.wait(), timeout=1)
            except TimeoutError:
                pass

    def next_source(self):
        """Rotate all human microphones without per-source audio buffers."""
        first = selected = None
        count = 0
        for participant in self.ctx.room.remote_participants.values():
            if participant.kind != rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD:
                continue
            for publication in participant.track_publications.values():
                if (
                    publication.source != rtc.TrackSource.SOURCE_MICROPHONE
                    or publication.kind != rtc.TrackKind.KIND_AUDIO
                    or publication.muted
                ):
                    continue
                source = (participant, publication)
                if first is None:
                    first = source
                if count == self.cursor:
                    selected = source
                count += 1
        if selected is not None:
            self.cursor += 1
            return selected
        self.cursor = 1 if first is not None else 0
        return first


async def entrypoint(ctx):
    """Connect visibly with automatic subscriptions disabled."""
    runtime = None
    try:
        room_sid = metadata(ctx.job.metadata)
        client = SamplingClient.from_env()
        await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
        actual_sid = ctx.room.sid
        if inspect.isawaitable(actual_sid):
            actual_sid = await actual_sid
        if actual_sid != room_sid:
            return
        runtime = Sampler(ctx, client, room_sid)
        ctx.add_shutdown_callback(runtime.close)
        await runtime.run()
    finally:
        if runtime is not None:
            await runtime.close()
        ctx.shutdown("voiceprint sampling stopped")


async def accept_job(request):
    """Reject disabled or malformed jobs before connecting to any room."""
    try:
        from voiceprint.configuration import switch  # noqa: PLC0415

        if not (
            switch("MEETING_VOICEPRINT_ENABLED")
            and switch("MEETING_VOICEPRINT_SAMPLING_ENABLED")
        ):
            raise SamplingError("sampling_disabled")
        metadata(request.job.metadata)
        SamplingClient.from_env()
    except (SamplingError, ValueError, TypeError):
        await request.reject()
        return
    await request.accept(
        identity="voiceprint-sampler-" + str(request.id), name="Voiceprint sampling"
    )


def main():
    """Run an independent visible worker without media/data publication permissions."""
    from voiceprint.runtime import main as run  # noqa: PLC0415

    run()
