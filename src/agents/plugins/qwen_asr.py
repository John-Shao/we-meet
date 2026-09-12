"""Qwen streaming ASR with explicit finish acknowledgement and source timestamps."""

import asyncio
import hashlib
import json
import math
import os
import re
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone

from livekit.agents import APIConnectionError, stt
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS
from websockets.asyncio.client import connect

SAMPLE_RATE = 16000
MAX_BUFFER_SECONDS = 10
MAX_SENTENCES = 100000
MAX_SENTENCE_CHARS = 20000
MAX_FINISH_TIMEOUT = 30
TIMESTAMP_TOLERANCE_MS = 250
INPUT_IDLE_SECONDS = 5


class QwenASRError(RuntimeError):
    """Sanitized protocol error; never include audio, transcript or credentials."""


class DirectConnect(connect):
    """Never forward a provider credential through an HTTP redirect."""

    def process_redirect(self, exc):
        """Abort redirects instead of following a Location header."""
        return exc


@dataclass(frozen=True)
class QwenASRConfig:
    """Settings are frozen for a participant session; secrets are excluded from repr."""

    api_key: str = field(repr=False)
    workspace: str
    region: str = "cn-beijing"
    model: str = "qwen-audio-3.0-asr-flash-streaming"
    finish_timeout: float = 15

    def __post_init__(self):
        """Only configured workspace endpoints receive credentials."""
        if not self.api_key or not re.fullmatch(r"[A-Za-z0-9-]+", self.workspace):
            raise ValueError("Qwen ASR requires an API key and valid workspace ID")
        if self.region not in {"cn-beijing", "ap-southeast-1"}:
            raise ValueError("Unsupported Qwen ASR region")
        if not self.model or not 0 < self.finish_timeout <= MAX_FINISH_TIMEOUT:
            raise ValueError("Invalid Qwen ASR model or finish timeout")

    @property
    def url(self):
        """Build an operator-controlled TLS endpoint."""
        return f"wss://{self.workspace}.{self.region}.maas.aliyuncs.com/api-ws/v1/inference"

    @classmethod
    def from_env(cls):
        """Reuse the dedicated DashScope credentials without touching other LLMs."""
        return cls(
            api_key=os.getenv("DASHSCOPE_API_KEY", ""),
            workspace=os.getenv("DASHSCOPE_WORKSPACE_ID", ""),
            region=os.getenv("QWEN_ASR_REGION", "cn-beijing"),
            model=os.getenv("QWEN_ASR_MODEL", "qwen-audio-3.0-asr-flash-streaming"),
        )


@dataclass(frozen=True)
class ASRSentence:
    """Provider-final sentence; identity remains stable through HTTP write retries."""

    ingest_id: str
    text: str
    language: str
    start_ms: int
    end_ms: int | None


class AudioTimeline:
    """Map PCM offsets to observed input time without compressing input pauses."""

    def __init__(self):
        """The first frame establishes the UTC/monotonic anchor."""
        self.origin = None
        self._clock_origin = 0.0
        self.duration_ms = 0.0
        self.runs = []

    def append(self, duration_ms):
        """Record discontinuities; later wall-clock adjustments cannot move text."""
        observed = time.monotonic() - duration_ms / 1000
        if self.origin is None:
            self.origin = datetime.now(timezone.utc) - timedelta(
                milliseconds=duration_ms
            )
            self._clock_origin = observed
            self.runs.append((0.0, 0.0))
        elapsed = (observed - self._clock_origin) * 1000
        source_start, wall_start = self.runs[-1]
        expected = wall_start + self.duration_ms - source_start
        if elapsed - expected > TIMESTAMP_TOLERANCE_MS:
            self.runs.append((self.duration_ms, elapsed))
        self.duration_ms += duration_ms

    def at(self, source_ms, *, end=False):
        """At a discontinuity an end belongs to the preceding audio run."""
        if self.origin is None:
            raise QwenASRError("asr_result_without_audio")
        run = self.runs[0]
        for candidate in self.runs[1:]:
            if candidate[0] > source_ms or (end and candidate[0] == source_ms):
                break
            run = candidate
        return self.origin + timedelta(milliseconds=run[1] + source_ms - run[0])


class QwenASRSession:
    """One provider task, with no automatic audio replay or reconnection."""

    def __init__(self, config, *, connector=DirectConnect):
        """Create an independent source identity and bounded result ledger."""
        self.config = config
        self.connector = connector
        self.task_id = str(uuid.uuid4())
        self.input_samples = 0
        self.connection_started = False
        self.provider_finished = False
        self.billed_seconds = 0.0
        self.billing_observed = False
        self._finals = {}
        self._finish_sent = False

    def _command(self, action):
        payload = {"input": {}}
        if action == "run-task":
            payload.update(
                task_group="audio",
                task="asr",
                function="recognition",
                model=self.config.model,
                parameters={
                    "format": "pcm",
                    "sample_rate": SAMPLE_RATE,
                    "heartbeat": True,
                },
            )
        return json.dumps(
            {
                "header": {
                    "action": action,
                    "task_id": self.task_id,
                    "streaming": "duplex",
                },
                "payload": payload,
            }
        )

    def observation(self, stream_id):
        """Only non-content counters leave the provider adapter."""
        return {
            "type": "task",
            "stream_id": stream_id,
            "task_id": self.task_id,
            "finished": self.provider_finished,
            "input_samples": self.input_samples,
            "final_sentences": len(self._finals),
            "billed_seconds": self.billed_seconds,
        }

    def _parse(self, raw):
        event = json.loads(raw)
        header = event["header"]
        if (
            header.get("task_id") != self.task_id
            or header.get("event") == "task-failed"
        ):
            raise QwenASRError("asr_provider_rejected")
        return header.get("event"), event.get("payload", {})

    def _sentence(self, payload, callback):
        sentence = payload.get("output", {}).get("sentence", {})
        if sentence.get("heartbeat") or sentence.get("sentence_end") is not True:
            return
        number, start, end = (
            sentence.get(key) for key in ("sentence_id", "begin_time", "end_time")
        )
        text = sentence.get("text", "")
        if (
            type(number) is not int
            or number < 1
            or type(start) is not int
            or start < 0
            or (end is not None and (type(end) is not int or end < start))
            or not isinstance(text, str)
            or len(text) > MAX_SENTENCE_CHARS
            or max(start, end or start)
            > self.input_samples * 1000 / SAMPLE_RATE + TIMESTAMP_TOLERANCE_MS
        ):
            raise QwenASRError("asr_invalid_sentence")
        fingerprint = hashlib.sha256(
            json.dumps([text, start, end], ensure_ascii=False).encode()
        ).hexdigest()
        if number in self._finals:
            if self._finals[number] != fingerprint:
                raise QwenASRError("asr_conflicting_final")
            return
        if len(self._finals) >= MAX_SENTENCES:
            raise QwenASRError("asr_sentence_limit")
        self._finals[number] = fingerprint
        self._usage(payload)
        if text.strip():
            callback(
                ASRSentence(
                    ingest_id=str(uuid.uuid5(uuid.UUID(self.task_id), str(number))),
                    text=text,
                    language="",
                    start_ms=start,
                    end_ms=end,
                )
            )

    def _usage(self, payload):
        duration = (payload.get("usage") or {}).get("duration")
        if type(duration) in (int, float) and math.isfinite(duration) and duration >= 0:
            self.billing_observed = True
            self.billed_seconds = max(self.billed_seconds, duration)

    async def run(self, audio, callback):
        """Drain FINAL events after finish-task; early close is always incomplete."""
        try:
            iterator = audio.__aiter__()
            first = await anext(iterator, None)
            if first is None:
                return  # An unused/muted input must not open a billable connection.

            async def chunks():
                yield first
                async for chunk in iterator:
                    yield chunk

            self.connection_started = True
            async with self.connector(
                self.config.url,
                additional_headers={"Authorization": f"Bearer {self.config.api_key}"},
                proxy=None,
                open_timeout=10,
                close_timeout=3,
                max_size=1024 * 1024,
                max_queue=16,
            ) as ws:
                await ws.send(self._command("run-task"))
                async with asyncio.timeout(10):
                    kind, _ = self._parse(await ws.recv())
                if kind != "task-started":
                    raise QwenASRError("asr_start_not_acknowledged")
                done = asyncio.Event()

                async def send_audio():
                    async for chunk in chunks():
                        if not chunk or len(chunk) % 2:
                            raise QwenASRError("asr_invalid_pcm")
                        self.input_samples += len(chunk) // 2
                        async with asyncio.timeout(5):
                            await ws.send(chunk)
                    self._finish_sent = True
                    async with asyncio.timeout(self.config.finish_timeout):
                        await ws.send(self._command("finish-task"))
                        await done.wait()

                async def receive():
                    while True:
                        kind, payload = self._parse(await ws.recv())
                        if kind == "result-generated":
                            self._sentence(payload, callback)
                        elif kind == "task-finished":
                            if not self._finish_sent:
                                raise QwenASRError("asr_premature_finish")
                            self.provider_finished = True
                            self._usage(payload)
                            done.set()
                            return
                        else:
                            raise QwenASRError("asr_unexpected_event")

                async with asyncio.TaskGroup() as group:
                    group.create_task(send_audio())
                    group.create_task(receive())
        except asyncio.CancelledError:
            raise
        except Exception:
            self.provider_finished = False
            raise QwenASRError("asr_stream_failed") from None


class QwenSTT(stt.STT):
    """LiveKit adapter retaining source timestamps outside the simplified UI event."""

    def __init__(self, config, *, on_final=None, on_failure=None, on_observation=None):
        """Freeze provider selection and observation callbacks per participant."""
        super().__init__(
            capabilities=stt.STTCapabilities(streaming=True, interim_results=False)
        )
        self.config = config
        self.on_final = on_final
        self.on_failure = on_failure
        self.on_observation = on_observation

    async def _recognize_impl(self, buffer, **kwargs):
        """Only realtime PCM is supported by this adapter."""
        raise NotImplementedError("Use Qwen streaming recognition")

    def stream(self, *, conn_options=DEFAULT_API_CONNECT_OPTIONS, **kwargs):
        """Never let SDK retries silently replay a partially consumed audio source."""
        return QwenSpeechStream(self, replace(conn_options, max_retry=0))


class QwenSpeechStream(stt.SpeechStream):
    """Bound queued PCM and finish the provider task before releasing its stream."""

    def __init__(self, provider, options):
        """Set state before SpeechStream schedules its processing task."""
        self.provider = provider
        self.timeline = AudioTimeline()
        self.buffered_seconds = 0.0
        self.session = QwenASRSession(provider.config)
        self._source_offset_ms = 0.0
        self._close_lock = asyncio.Lock()
        self._closed_once = False
        self._stream_id = str(uuid.uuid4())
        self._observe({"type": "stream_started", "model": provider.config.model})
        super().__init__(stt=provider, conn_options=options, sample_rate=SAMPLE_RATE)

    def _observe(self, event):
        if self.provider.on_observation:
            self.provider.on_observation({"stream_id": self._stream_id, **event})

    def _fail(self, reason="asr_stream_failed"):
        self._observe({"type": "failure", "code": reason})
        if self.provider.on_failure:
            self.provider.on_failure()

    def push_frame(self, frame):
        """Input overflow is explicit; never drop queued audio and claim success."""
        duration = frame.samples_per_channel / frame.sample_rate
        if (
            frame.num_channels != 1
            or self.buffered_seconds + duration > MAX_BUFFER_SECONDS
        ):
            self._fail("asr_buffer_exceeded")
            raise APIConnectionError("Qwen ASR input format or buffer limit exceeded")
        self.timeline.append(duration * 1000)
        self.buffered_seconds += duration
        super().push_frame(frame)

    async def _run(self):
        """Bridge resampled mono PCM and publish final source events once."""

        async def audio():
            while True:
                try:
                    async with asyncio.timeout(INPUT_IDLE_SECONDS):
                        item = await anext(self._input_ch, None)
                except TimeoutError:
                    # Seal idle tasks; reopen on actual input, never fake silence.
                    return
                if item is None:
                    return
                if isinstance(item, self._FlushSentinel):
                    continue
                self.buffered_seconds = max(
                    0, self.buffered_seconds - item.samples_per_channel / SAMPLE_RATE
                )
                yield bytes(item.data)

        def final(sentence):
            start = self.timeline.at(self._source_offset_ms + sentence.start_ms)
            end = (
                self.timeline.at(self._source_offset_ms + sentence.end_ms, end=True)
                if sentence.end_ms is not None
                else None
            )
            if self.provider.on_final:
                self.provider.on_final(sentence, start, end)
            self._event_ch.send_nowait(
                stt.SpeechEvent(
                    type=stt.SpeechEventType.FINAL_TRANSCRIPT,
                    alternatives=[
                        stt.SpeechData(
                            language=sentence.language,
                            text=sentence.text,
                            start_time=sentence.start_ms / 1000,
                            end_time=(sentence.end_ms or sentence.start_ms) / 1000,
                        )
                    ],
                )
            )

        try:
            while True:
                try:
                    await self.session.run(audio(), final)
                finally:
                    if self.session.connection_started:
                        self._observe(self.session.observation(self._stream_id))
                self._source_offset_ms += (
                    self.session.input_samples * 1000 / SAMPLE_RATE
                )
                if self._input_ch.closed and self._input_ch.empty():
                    break
                self.session = QwenASRSession(self.provider.config)
        except asyncio.CancelledError:
            self._fail()
            raise
        except Exception:
            self._fail()
            raise APIConnectionError("Qwen ASR stream did not finish") from None
        finally:
            self._observe({"type": "stream_finished"})

    async def aclose(self):
        """Wait for final provider output before canceling the SDK reader."""
        async with self._close_lock:
            if self._closed_once:
                return
            try:
                if not self._input_ch.closed:
                    self.end_input()
                async with asyncio.timeout(self.provider.config.finish_timeout + 5):
                    await asyncio.shield(self._task)
            except asyncio.CancelledError:
                self._fail()
                raise
            except Exception:
                self._fail()
            finally:
                await super().aclose()
                self._closed_once = True
