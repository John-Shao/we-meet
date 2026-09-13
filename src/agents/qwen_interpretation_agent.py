"""Shared Qwen interpretation with isolated inputs and restricted output tracks."""

import asyncio
import inspect
import json
import os
import time

from livekit import rtc
from livekit.agents import AutoSubscribe, WorkerOptions, WorkerPermissions, cli

from interpretation_control import (
    GrantLease,
    InterpretationReporter,
    interpretation_metadata,
)
from plugins.qwen_live_translate import (
    TranslationConfig,
    TranslationError,
    TranslationSession,
)
from translation_archive_delivery import ArchiveDelivery
from translation_control import TranslationInput

EVENT_TOPIC = "meeting.interpretation.events"
MAX_EVENT_BYTES = 14000
MAX_SOURCE_LIFETIMES = 256
MAX_LIVE_STREAMS = 32


async def bounded_fanout(coroutines):
    """Cancel every sibling send when one recipient fails or times out."""
    tasks = [asyncio.create_task(coroutine) for coroutine in coroutines]
    try:
        await asyncio.wait_for(asyncio.gather(*tasks), 3)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class SourceTranslation:
    """One microphone, provider session, bounded FIFO and translated audio track."""

    def __init__(self, runtime, source, publication):
        """Freeze participation and track identity before opening the provider."""
        self.runtime, self.source, self.publication = runtime, dict(source), publication
        self.track_sid = publication.sid
        self.session = None
        self.input = self.stream = self.reader = self.pump = None
        self.audio_source = self.output = None
        self.opened = self.closed = False
        self.stop = asyncio.Event()
        self.closing = asyncio.Lock()
        self.task = None
        self.ready_listeners = set()
        self.ready_refresh_at = 0.0

    def accepting(self):
        """Fence source startup and reads against current connection grants."""
        return (
            not self.stop.is_set()
            and not self.runtime.stop.is_set()
            and self.source in self.runtime.lease.current_sources(self.runtime.room)
        )

    async def start_session(self):
        """Cancel a stalled handshake promptly when the source grant disappears."""
        task = asyncio.create_task(self.session.start())
        try:
            while not task.done():
                if not self.accepting():
                    raise TranslationError("interpretation_start_revoked")
                await asyncio.wait({task}, timeout=0.1)
            await task
            if not self.accepting():
                raise TranslationError("interpretation_start_revoked")
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def consume(self, event):
        """Forward translated output only; source candidates never become formal ASR."""
        if event["type"] == "response_completed":
            self.runtime.account(event["usage"])
        elif event["type"] == "audio":
            if self.runtime.can_output() and self.audio_source:
                pcm = event["audio"]
                await self.audio_source.capture_frame(
                    rtc.AudioFrame(
                        pcm,
                        sample_rate=24000,
                        num_channels=1,
                        samples_per_channel=len(pcm) // 2,
                    )
                )
        elif event["type"] in {"target_candidate", "target_final"}:
            if self.runtime.archive and event["type"] == "target_final":
                self.runtime.archive.enqueue(self.source, event)
            await self.runtime.publish(self, event)

    async def read_audio(self):
        """SDK frames enter one bounded queue, never independent send tasks."""
        try:
            async for event in self.stream:
                if not self.accepting():
                    return
                self.input.audio(bytes(event.frame.data))
            if not self.stop.is_set() and not self.runtime.stop.is_set():
                self.runtime.halt(failed=True)
        except Exception:
            self.runtime.halt(failed=True)

    async def run(self):
        """Start a source once; provider failures never replay its audio."""
        try:
            if not self.accepting():
                return
            config = TranslationConfig.from_env(
                target=self.runtime.lease.configuration["target"],
                source=None,
                audio=True,
            )
            if config.model != self.runtime.lease.configuration["model"]:
                raise TranslationError("interpretation_model_changed")
            self.session = TranslationSession(config, self.consume)
            self.input = TranslationInput({"forward": self.session}, manual=False)
            self.audio_source = rtc.AudioSource(24000, 1, queue_size_ms=200)
            track = rtc.LocalAudioTrack.create_audio_track(
                f"interpretation-{self.source['participation_id']}", self.audio_source
            )
            self.output = await self.runtime.room.local_participant.publish_track(
                track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_UNKNOWN)
            )
            if not self.accepting():
                return
            await self.start_session()
            self.opened = True
            self.stream = rtc.AudioStream(
                self.publication.track,
                sample_rate=16000,
                num_channels=1,
                frame_size_ms=20,
            )
            self.reader = asyncio.create_task(self.read_audio())
            self.pump = asyncio.create_task(self.input.pump())
            await self.runtime.publish(self, {"type": "ready"})
            while not self.stop.is_set() and not self.runtime.stop.is_set():
                if self.session.error_code or self.pump.done():
                    raise TranslationError("interpretation_source_failed")
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            self.runtime.failed = True
            raise
        except Exception:
            self.runtime.halt(failed=True)
        finally:
            await self.close()

    async def close(self):  # noqa: PLR0912 -- drain and cleanup own distinct resources
        """Drain admitted audio and authorized tail within the backend stop deadline."""
        async with self.closing:
            if self.closed:
                return
            self.stop.set()
            complete = False
            try:
                async with asyncio.timeout(22):
                    if self.reader:
                        self.reader.cancel()
                        await asyncio.gather(self.reader, return_exceptions=True)
                    if self.stream:
                        await self.stream.aclose()
                    if self.opened and self.pump and self.runtime.can_output():
                        self.input.end()
                        await asyncio.wait_for(self.pump, 2)
                        await self.session.finish()
                        complete = self.session.finished
                    if self.audio_source and self.runtime.can_output():
                        await self.audio_source.wait_for_playout()
            except Exception:
                self.runtime.halt(failed=True)
            finally:
                self.runtime.provider_complete &= complete
                if self.pump and not self.pump.done():
                    self.pump.cancel()
                    await asyncio.gather(self.pump, return_exceptions=True)
                if self.audio_source:
                    self.audio_source.clear_queue()
                try:
                    async with asyncio.timeout(2):
                        if self.session:
                            await self.session.close()
                        if self.output:
                            await self.runtime.room.local_participant.unpublish_track(
                                self.output.sid
                            )
                        if self.audio_source:
                            await self.audio_source.aclose()
                except Exception:
                    self.runtime.failed = True
                self.closed = True


class SharedInterpretation:
    """Reconcile backend grants into isolated inputs and subscribed-only output."""

    def __init__(self, ctx, reporter, grant):
        """Accept a claimed generation before any track or provider is opened."""
        self.ctx, self.room, self.reporter = ctx, ctx.room, reporter
        self.lease = GrantLease()
        self.lease.accept(grant)
        self.stop = asyncio.Event()
        self.closed = self.failed = False
        self.provider_complete = True
        self.sources = {}
        self.seen = set()
        self.watcher = None
        self.closing = asyncio.Lock()
        self.usage = {"input_tokens": None, "output_tokens": None}
        self.missing_usage = set()
        self.output_limit = asyncio.Semaphore(8)
        self.last_permissions = None
        record_id = self.lease.configuration.get("archive_record_id")
        self.archive = (
            ArchiveDelivery(reporter, record_id, self.lease.configuration["target"])
            if record_id
            else None
        )

    def can_output(self):
        """No output survives lease expiry or absence of matching live listeners."""
        return not self.failed and bool(self.lease.current_listeners(self.room))

    def account(self, usage):
        """Incomplete usage remains unknown instead of a misleading partial total."""
        for key in self.usage:
            if key not in usage:
                self.missing_usage.add(key)
            elif key not in self.missing_usage:
                self.usage[key] = (self.usage[key] or 0) + usage[key]

    def permissions(self):
        """Set server-side subscription ACL before publishing any generated track."""
        listeners = self.lease.current_listeners(self.room) if not self.failed else []
        identities = tuple(sorted(row["identity"] for row in listeners))
        if identities == self.last_permissions:
            return
        self.room.local_participant.set_track_subscription_permissions(
            allow_all_participants=False,
            participant_permissions=[
                rtc.ParticipantTrackPermission(
                    participant_identity=identity, allow_all=True
                )
                for identity in identities
            ],
        )
        self.last_permissions = identities

    def halt(self, *, failed=False, tail=False):
        """Stop new input; error/permission paths also revoke output immediately."""
        self.failed |= failed
        self.stop.set()
        if not tail or self.failed:
            self.lease.deny()
            self.permissions()
            for source in self.sources.values():
                if source.audio_source:
                    source.audio_source.clear_queue()

    async def publish(self, source, event):
        """Send per-listener revisions without room broadcast."""
        if not self.can_output():
            return
        base = {
            "channel_id": self.reporter.identity["channel_id"],
            "generation": self.reporter.identity["generation"],
            "type": event["type"],
            "target": self.lease.configuration["target"],
            "source_participation_id": source.source["participation_id"],
            "source_participant_sid": source.source["participant_sid"],
            "audio_track_sid": source.output.sid if source.output else None,
        }
        for field in ["text", "stash", "response_id", "item_id"]:
            if field in event:
                base[field] = event[field]

        async def send(listener):
            async with self.output_limit:
                key = (listener["subscription_id"], listener["revision"])
                if (
                    listener not in self.lease.current_listeners(self.room)
                    or self.failed
                    or (event["type"] == "ready" and key in source.ready_listeners)
                ):
                    return
                payload = json.dumps(
                    {
                        **base,
                        "subscription_id": listener["subscription_id"],
                        "subscription_revision": listener["revision"],
                    }
                ).encode()
                if len(payload) > MAX_EVENT_BYTES:
                    raise TranslationError("interpretation_event_too_large")
                await self.room.local_participant.publish_data(
                    payload,
                    reliable=True,
                    destination_identities=[listener["identity"]],
                    topic=EVENT_TOPIC,
                )
                if event["type"] == "ready":
                    source.ready_listeners.add(key)

        await bounded_fanout(
            send(listener) for listener in self.lease.current_listeners(self.room)
        )

    def disconnected(self, participant):
        """Revoke the exact former connection before awaiting another heartbeat."""
        self.lease.disconnected(participant)
        self.permissions()
        for source in self.sources.values():
            if (
                source.source["identity"] == participant.identity
                and source.source["participant_sid"] == participant.sid
            ):
                source.stop.set()

    def reconcile(self):  # noqa: PLR0912 -- source retirement and admission are fenced
        """Track authorized standard microphones without audio replay."""
        self.permissions()
        authorized = {
            row["participation_id"]: row
            for row in self.lease.current_sources(self.room)
        }
        for key, source in list(self.sources.items()):
            if key not in authorized:
                source.stop.set()
            if source.task.done():
                if source.task.cancelled() or source.task.exception():
                    self.halt(failed=True)
                del self.sources[key]
        if not self.lease.input_allowed or self.stop.is_set() or not self.can_output():
            return
        for key, row in authorized.items():
            participant = self.room.remote_participants[row["identity"]]
            publications = [
                publication
                for publication in participant.track_publications.values()
                if publication.kind == rtc.TrackKind.KIND_AUDIO
                and publication.source == rtc.TrackSource.SOURCE_MICROPHONE
            ]
            if len(publications) > 1:
                self.halt(failed=True)
                return
            if not publications:
                if key in self.sources:
                    self.sources[key].stop.set()
                continue
            publication = publications[0]
            if key in self.sources:
                if self.sources[key].track_sid != publication.sid:
                    self.halt(failed=True)
                continue
            if key in self.seen:
                self.halt(failed=True)
                return
            if (
                len(self.seen) >= MAX_SOURCE_LIFETIMES
                or len(self.sources) >= MAX_LIVE_STREAMS
            ):
                self.halt(failed=True)
                return
            publication.set_subscribed(True)
            if publication.track:
                source = SourceTranslation(self, row, publication)
                self.sources[key] = source
                self.seen.add(key)
                source.task = asyncio.create_task(source.run())

    async def watch(self):
        """Refresh listeners while also keeping the stop-tail lease alive."""
        while not self.closed:
            try:
                reply = await self.reporter.command("heartbeat")
                if reply is None:
                    raise TranslationError("interpretation_control_unavailable")
                self.lease.accept(reply)
                self.permissions()
                listeners = {
                    (row["subscription_id"], row["revision"])
                    for row in self.lease.current_listeners(self.room)
                }
                ready = []
                for source in list(self.sources.values()):
                    if time.monotonic() >= source.ready_refresh_at:
                        source.ready_listeners.clear()
                        source.ready_refresh_at = time.monotonic() + 10
                    source.ready_listeners.intersection_update(listeners)
                    if source.opened and not source.closed:
                        ready.append(self.publish(source, {"type": "ready"}))
                await bounded_fanout(ready)
                if self.lease.state != "translating":
                    self.halt(
                        failed=self.lease.state == "incomplete", tail=self.lease.tail
                    )
            except Exception:
                self.halt(failed=True)
            await asyncio.sleep(2)

    async def run(self):
        """Poll local expiry even when an asynchronous backend heartbeat stalls."""
        self.permissions()
        self.room.on("participant_disconnected", self.disconnected)
        if self.archive:
            self.archive.start()
        self.watcher = asyncio.create_task(self.watch())
        try:
            while not self.stop.is_set():
                if not self.lease.input_allowed:
                    self.halt(failed=True)
                self.reconcile()
                await asyncio.sleep(0.1)
        except Exception:
            self.halt(failed=True)
        finally:
            await self.close()

    async def close(self):
        """Close every owned stream and publish one immutable completion receipt."""
        async with self.closing:
            if self.closed:
                return
            self.stop.set()
            started_at = time.monotonic()
            try:
                results = await asyncio.wait_for(
                    asyncio.gather(
                        *(source.task for source in self.sources.values()),
                        return_exceptions=True,
                    ),
                    24,
                )
                if any(isinstance(result, BaseException) for result in results):
                    self.failed = True
            except TimeoutError:
                self.failed = True
            finally:
                archive_finished = None
                if self.archive:
                    archive_finished = await self.archive.finish(
                        24 - (time.monotonic() - started_at)
                    )
                self.lease.deny()
                self.permissions()
                self.closed = True
                if self.watcher:
                    self.watcher.cancel()
                    await asyncio.gather(self.watcher, return_exceptions=True)
                for key in self.missing_usage:
                    self.usage[key] = None
                await self.reporter.command(
                    "finish",
                    receipt={
                        "provider_finished": self.provider_complete,
                        "consumer_finished": not self.failed,
                        **self.usage,
                        **(
                            {"archive_finished": archive_finished}
                            if self.archive
                            else {}
                        ),
                    },
                )


async def entrypoint(ctx):
    """Connect without auto-subscription and claim before any paid provider work."""
    try:
        metadata = interpretation_metadata(ctx.job.metadata)
        await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
        sid = ctx.room.sid
        if inspect.isawaitable(sid):
            sid = await sid
        if sid != metadata["livekit_room_sid"]:
            return
        reporter = InterpretationReporter.from_env(ctx.room.name, metadata)
        grant = await reporter.command("claim")
        if not grant or grant["state"] != "translating":
            return
        runtime = SharedInterpretation(ctx, reporter, grant)
        ctx.add_shutdown_callback(runtime.close)
        await runtime.run()
    finally:
        ctx.shutdown("interpretation finished")


async def accept_job(request):
    """Give duplicate dispatch a distinct identity before the backend claim."""
    try:
        metadata = interpretation_metadata(request.job.metadata)
    except (ValueError, TypeError, KeyError):
        await request.reject()
        return
    await request.accept(
        identity=f"interpretation-{metadata['channel_id']}-{request.id}"
    )


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            request_fnc=accept_job,
            agent_name=os.getenv(
                "ROOM_INTERPRETATION_AGENT_NAME", "meeting-interpretation"
            ),
            permissions=WorkerPermissions(hidden=True),
        )
    )
