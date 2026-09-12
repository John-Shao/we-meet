"""Private Qwen audio translation; explicit source, generation and recipient fences."""

import asyncio
import inspect
import json
import os
import time

from livekit import rtc
from livekit.agents import AutoSubscribe, WorkerOptions, WorkerPermissions, cli

from plugins.qwen_live_translate import (
    TranslationConfig,
    TranslationError,
    TranslationSession,
)
from translation_control import (
    TranslationInput,
    TranslationReporter,
    translation_metadata,
)

EVENT_TOPIC = "meeting.translation.events"
CONTROL_TOPIC = "meeting.translation.control"
MAX_CONTROL_BYTES = 1024
MAX_EVENT_BYTES = 14000
MANUAL_RESPONSE_SECONDS = 30
MANUAL_IDLE_SECONDS = 60


class PrivateTranslation:
    """Translate one human microphone; never subscribe to agent or translated tracks."""

    def __init__(self, ctx, reporter, grant):
        """Only a backend claim supplies source identity and fixed session settings."""
        self.ctx, self.reporter, self.grant = ctx, reporter, grant
        self.options = grant["configuration"]
        if (
            self.options.get("scope") != "controller_only"
            or grant["destination_identity"] != grant["source_identity"]
            or type(self.options.get("audio")) is not bool
        ):
            raise TranslationError("invalid_translation_grant")
        self.channels = {}
        self.stop = asyncio.Event()
        self.allow_text = True
        self.failed = False
        self.audio_source = None
        self.audio_publication = None
        self.stream = None
        self.reader = None
        self.pump = None
        self.watcher = None
        self.input = None
        self.selected_track = None
        self._closing = asyncio.Lock()
        self._closed = False
        self.usage = {"input_tokens": None, "output_tokens": None}

    def matches(self, participant):
        """A reconnect or another device cannot inherit the old source connection."""
        return bool(
            participant
            and participant.identity == self.grant["source_identity"]
            and participant.sid == self.grant["source_participant_sid"]
            and participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
        )

    def halt(self, *, failed=False, deliver_tail=False):
        """Stop playback immediately, independently of provider tail cleanup."""
        self.failed |= failed
        self.allow_text = deliver_tail and not self.failed
        self.stop.set()
        if self.audio_source:
            self.audio_source.clear_queue()

    async def publish(self, event):
        """Never fall back to room-wide data distribution."""
        payload = json.dumps(
            {
                "run_id": self.reporter.identity["run_id"],
                "generation": self.reporter.identity["generation"],
                **event,
            }
        ).encode()
        if len(payload) > MAX_EVENT_BYTES:
            raise TranslationError("translation_event_too_large")
        await self.ctx.room.local_participant.publish_data(
            payload,
            reliable=True,
            destination_identities=[self.grant["destination_identity"]],
            topic=EVENT_TOPIC,
        )

    async def consume(self, direction, event):
        """Keep revoked output and translated audio out of original transcription."""
        if event["type"] == "response_completed":
            for key, count in event["usage"].items():
                if key in self.usage:
                    self.usage[key] = (self.usage[key] or 0) + count
            if self.input:
                self.input.response_completed(direction)
            if self.allow_text:
                await self.publish({"type": "turn_completed", "direction": direction})
            return
        if event["type"] == "audio":
            if self.audio_source and not self.stop.is_set():
                data = event["audio"]
                await self.audio_source.capture_frame(
                    rtc.AudioFrame(
                        data,
                        sample_rate=24000,
                        num_channels=1,
                        samples_per_channel=len(data) // 2,
                    )
                )
        elif self.allow_text and event["type"] in {"target_candidate", "target_final"}:
            await self.publish({"direction": direction, **event})

    async def watch(self):
        """Stop delivery on permission loss without reconnecting or restarting."""
        while not self._closed:
            state = await self.reporter.command("heartbeat")
            if state is None:
                self.halt(failed=True)
            elif state["state"] != "translating":
                self.halt(
                    failed=state["state"] == "incomplete",
                    deliver_tail=state.get("deliver_tail") is True,
                )
            await asyncio.sleep(2)

    async def open(self):
        """Set server subscription ACL before publishing any private output track."""
        self.watcher = asyncio.create_task(self.watch())
        participant = self.ctx.room.remote_participants.get(
            self.grant["source_identity"]
        )
        if not self.matches(participant):
            raise TranslationError("translation_source_unavailable")
        self.ctx.room.local_participant.set_track_subscription_permissions(
            allow_all_participants=False,
            participant_permissions=[
                rtc.ParticipantTrackPermission(
                    participant_identity=self.grant["destination_identity"],
                    allow_all=True,
                )
            ],
        )
        if self.options["audio"]:
            self.audio_source = rtc.AudioSource(24000, 1, queue_size_ms=200)
            track = rtc.LocalAudioTrack.create_audio_track(
                f"translation-{self.reporter.identity['run_id']}", self.audio_source
            )
            self.audio_publication = (
                await self.ctx.room.local_participant.publish_track(
                    track,
                    rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_UNKNOWN),
                )
            )
        manual = self.options["mode"] == "push_to_talk"
        directions = ("forward", "reverse") if manual else ("forward",)
        for direction in directions:
            if self.stop.is_set():
                return
            source, target = self.options["source"], self.options["target"]
            if direction == "reverse":
                source, target = target, source
            config = TranslationConfig.from_env(
                source=source, target=target, audio=self.options["audio"], manual=manual
            )
            if config.model != self.options["model"]:
                raise TranslationError("translation_configuration_changed")
            channel = TranslationSession(
                config,
                lambda event, direction=direction: self.consume(direction, event),
            )
            self.channels[direction] = channel
            await channel.start()
        if self.stop.is_set():
            return
        self.input = TranslationInput(
            self.channels,
            manual=manual,
            on_empty=lambda direction: self.publish(
                {
                    "type": "turn_completed",
                    "direction": direction,
                    "empty": True,
                }
            ),
        )
        self.pump = asyncio.create_task(self.input.pump())
        self.ctx.room.on("track_subscribed", self.on_track)
        self.ctx.room.on("track_published", self.on_publication)
        self.ctx.room.on("track_unpublished", self.on_unpublished)
        self.ctx.room.on("participant_disconnected", self.on_disconnected)
        self.ctx.room.on("data_received", self.on_control)
        for publication in participant.track_publications.values():
            self.on_publication(publication, participant)
        await self.publish(
            {
                "type": "ready",
                "sequence": 0,
                "audio_track_sid": self.audio_publication.sid
                if self.audio_publication
                else None,
            }
        )

    def on_publication(self, publication, participant):
        """Subscribe only to the claimed microphone, never screen/system audio."""
        if (
            not self.stop.is_set()
            and self.matches(participant)
            and publication.source == rtc.TrackSource.SOURCE_MICROPHONE
            and publication.kind == rtc.TrackKind.KIND_AUDIO
        ):
            if self.selected_track and self.selected_track != publication.sid:
                self.halt(failed=True)
                return
            self.selected_track = publication.sid
            publication.set_subscribed(True)
            if publication.track:
                self.on_track(publication.track, publication, participant)

    def on_track(self, track, publication, participant):
        """One stream and one FIFO prevent duplicate subscriptions and audio replay."""
        if (
            self.stop.is_set()
            or not self.matches(participant)
            or publication.sid != self.selected_track
            or self.reader
        ):
            return
        self.stream = rtc.AudioStream(
            track, sample_rate=16000, num_channels=1, frame_size_ms=20
        )
        self.reader = asyncio.create_task(self.read_audio())

    async def read_audio(self):
        """Drain SDK frames promptly into a one-second bounded producer queue."""
        try:
            async for event in self.stream:
                if self.stop.is_set():
                    return
                self.input.audio(bytes(event.frame.data))
            if not self.stop.is_set():
                self.halt(failed=True)
        except Exception:
            self.halt(failed=True)

    def on_unpublished(self, publication, participant):
        """A replaced source cannot silently extend the original authorization."""
        if self.matches(participant) and publication.sid == self.selected_track:
            self.halt(failed=True)

    def on_disconnected(self, participant):
        """Disconnecting the exact source cancels delivery before the next heartbeat."""
        if self.matches(participant):
            self.halt(failed=True)

    def on_control(self, packet):
        """Only the claimed device may control its manual directions and sequence."""
        if (
            packet.topic != CONTROL_TOPIC
            or not self.matches(packet.participant)
            or len(packet.data) > MAX_CONTROL_BYTES
            or not self.input
        ):
            return
        try:
            data = json.loads(packet.data)
            if (
                data.get("run_id") != self.reporter.identity["run_id"]
                or type(data.get("generation")) is not int
                or data.get("generation") != self.reporter.identity["generation"]
            ):
                return
            self.input.control(data["sequence"], data["action"], data["direction"])
        except (ValueError, KeyError, TypeError, AttributeError, TranslationError):
            self.halt(failed=True)

    async def run(self):
        """Watch transport failures while lifecycle polls renew authorization."""
        try:
            await self.open()
            while not self.stop.is_set():
                if (self.pump and self.pump.done()) or any(
                    channel.error_code for channel in self.channels.values()
                ):
                    self.halt(failed=True)
                if self.input and self.input.manual:
                    now = time.monotonic()
                    if (
                        self.input.awaiting_at is not None
                        and now - self.input.awaiting_at > MANUAL_RESPONSE_SECONDS
                    ):
                        self.halt(failed=True)
                    elif now - self.input.last_input_at > MANUAL_IDLE_SECONDS:
                        self.halt(deliver_tail=True)
                await asyncio.sleep(0.1)
        except Exception:
            self.halt(failed=True)
        finally:
            await self.close()

    async def close(self):
        """Stop listening now, then drain ordered audio and bounded provider tails."""
        async with self._closing:
            if self._closed:
                return
            self.stop.set()
            if self.audio_source:
                self.audio_source.clear_queue()
            try:
                if self.stream:
                    await asyncio.wait_for(self.stream.aclose(), 3)
                if self.input and self.pump:
                    self.input.end()
                    await asyncio.wait_for(self.pump, 5)
                results = await asyncio.gather(
                    *(channel.finish() for channel in self.channels.values()),
                    return_exceptions=True,
                )
                self.failed |= any(
                    isinstance(result, BaseException) for result in results
                )
            except Exception:
                self.failed = True
            finally:
                if self.reader:
                    self.reader.cancel()
                    await asyncio.gather(self.reader, return_exceptions=True)
                await asyncio.gather(
                    *(channel.close() for channel in self.channels.values()),
                    return_exceptions=True,
                )
                if self.pump:
                    self.pump.cancel()
                    await asyncio.gather(self.pump, return_exceptions=True)
                cleanup = []
                if self.audio_publication:
                    cleanup.append(
                        self.ctx.room.local_participant.unpublish_track(
                            self.audio_publication.sid
                        )
                    )
                if self.audio_source:
                    cleanup.append(self.audio_source.aclose())
                try:
                    released = await asyncio.wait_for(
                        asyncio.gather(*cleanup, return_exceptions=True), 5
                    )
                    self.failed |= any(
                        isinstance(result, BaseException) for result in released
                    )
                except TimeoutError:
                    self.failed = True
                self._closed = True
                if self.watcher:
                    self.watcher.cancel()
                    await asyncio.gather(self.watcher, return_exceptions=True)
                complete = bool(self.channels) and all(
                    channel.finished for channel in self.channels.values()
                )
                await self.reporter.command(
                    "finish",
                    receipt={
                        "provider_finished": complete,
                        "consumer_finished": not self.failed,
                        **self.usage,
                    },
                )


async def entrypoint(ctx):
    """Claim before starting any provider, with no automatic fallback translator."""
    try:
        metadata = translation_metadata(ctx.job.metadata)
        await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
        sid = ctx.room.sid
        if inspect.isawaitable(sid):
            sid = await sid
        if sid != metadata["livekit_room_sid"]:
            return
        reporter = TranslationReporter.from_env(ctx.room.name, metadata)
        grant = await reporter.command("claim")
        if not grant or grant["state"] != "translating":
            return
        runtime = PrivateTranslation(ctx, reporter, grant)
        ctx.add_shutdown_callback(runtime.close)
        await runtime.run()
    finally:
        ctx.shutdown("translation finished")


async def accept_job(request):
    """Unique identities avoid evicting a winner before duplicate claim rejection."""
    try:
        metadata = translation_metadata(request.job.metadata)
    except (ValueError, TypeError, KeyError):
        await request.reject()
        return
    await request.accept(identity=f"translation-{metadata['run_id']}-{request.id}")


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            request_fnc=accept_job,
            agent_name=os.getenv("ROOM_TRANSLATION_AGENT_NAME", "meeting-translation"),
            permissions=WorkerPermissions(hidden=True),
        )
    )
