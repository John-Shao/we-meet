"""Standalone sealed-WAV transcription, without a LiveKit room or audio replay."""

import asyncio
import hashlib
import io
import json
import logging
import os
import signal
import urllib.error
import urllib.request
import uuid
import wave
from http import HTTPStatus
from urllib.parse import urlsplit

from plugins.qwen_asr import QwenASRConfig, QwenASRSession
from transcript_writer import _open

MAX_AUDIO_BYTES = 320044
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_CHUNKS = 4320
MAX_RUNS = 50
MAX_DURATION_MS = 43200000
MAX_CHUNK_MS = 10000
MAX_SENTENCE_CHARS = 10000
WAV_HEADER_BYTES = 44
SHA256_HEX_LENGTH = 64
MAX_FINALS = 20000
MAX_TEXT_BYTES = 4000000
FRAME_BYTES = 3200  # 100 ms of mono PCM16/16k
logger = logging.getLogger("capture-transcriber")


class CaptureError(RuntimeError):
    """Only fixed non-content diagnostics may leave this worker."""


class CaptureBackend:
    """Bounded backend calls; only idempotent receipts retry after lost responses."""

    def __init__(self, base_url, token):
        """Use one operator-owned origin and one identity for this process lifetime."""
        parsed = urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or not token:
            raise CaptureError("backend_configuration_required")
        if parsed.query or parsed.fragment or parsed.username or parsed.password:
            raise CaptureError("invalid_backend_origin")
        self.url = base_url.rstrip("/") + "/api/agent/capture-transcriptions/"
        self.token = token
        self.worker_id = str(uuid.uuid4())

    def _send(self, path, payload, binary):
        request = urllib.request.Request(  # noqa: S310 -- operator-controlled origin
            self.url + path,
            data=json.dumps({"worker_id": self.worker_id, **payload}).encode()
            if payload is not None
            else None,
            headers={
                "X-Agent-Token": self.token,
                "X-Worker-ID": self.worker_id,
                "Content-Type": "application/json",
            },
            method="GET" if payload is None else "POST",
        )
        limit = MAX_AUDIO_BYTES if binary else MAX_MANIFEST_BYTES
        with _open(request, timeout=3) as response:
            body = response.read(limit + 1)
            if len(body) > limit:
                raise CaptureError("backend_response_too_large")
            return body if binary else json.loads(body)

    async def request(self, path, payload=None, *, binary=False, attempts=3):
        """Never retry a begin gate; HTTP errors contain no reportable body content."""
        for attempt in range(attempts):
            try:
                return await asyncio.to_thread(self._send, path, payload, binary)
            except urllib.error.HTTPError as exc:
                if (
                    exc.code < HTTPStatus.INTERNAL_SERVER_ERROR
                    and exc.code != HTTPStatus.TOO_MANY_REQUESTS
                ):
                    raise CaptureError("backend_execution_rejected") from None
            except (OSError, ValueError):
                pass
            if attempt + 1 < attempts:
                await asyncio.sleep(0.2 * (attempt + 1))
        raise CaptureError("backend_receipt_unknown")


def audio_runs(job, config):
    """Validate bounded manifest identities before spending on a provider task."""
    uuid.UUID(job["id"])
    if job["configuration"] != {"model": config.model, "region": config.region}:
        raise CaptureError("incompatible_provider_configuration")
    chunks = job["inputs"]["chunks"]
    if not isinstance(chunks, list) or not 1 <= len(chunks) <= MAX_CHUNKS:
        raise CaptureError("invalid_input_manifest")
    runs, previous = [], None
    for index, chunk in enumerate(chunks, 1):
        uuid.UUID(chunk["id"])
        sequence, start, duration, size = (
            chunk[name] for name in ("sequence", "start_ms", "duration_ms", "byte_size")
        )
        checksum = chunk["checksum"]
        if (
            any(type(value) is not int for value in (sequence, start, duration, size))
            or not 1 <= sequence <= MAX_CHUNKS
            or not 0 <= start < MAX_DURATION_MS
            or not 1 <= duration <= MAX_CHUNK_MS
            or start + duration > MAX_DURATION_MS
            or not WAV_HEADER_BYTES < size <= MAX_AUDIO_BYTES
            or chunk.get("stored") is not True
            or not isinstance(checksum, str)
            or len(checksum) != SHA256_HEX_LENGTH
            or any(char not in "0123456789abcdef" for char in checksum)
        ):
            raise CaptureError("invalid_input_chunk")
        if previous and (
            sequence <= previous["sequence"]
            or start < previous["start_ms"] + previous["duration_ms"]
        ):
            raise CaptureError("unordered_input_manifest")
        contiguous = (
            previous
            and sequence == previous["sequence"] + 1
            and (start == previous["start_ms"] + previous["duration_ms"])
        )
        if not contiguous:
            runs.append([])
        runs[-1].append((index, chunk))
        previous = chunk
    if len(runs) > MAX_RUNS or job["inputs"]["runs"] != len(runs):
        raise CaptureError("invalid_input_runs")
    return runs


def verified_pcm(data, source):
    """Check private bytes against the pinned identity before decoding a short WAV."""
    if (
        len(data) != source["byte_size"]
        or hashlib.sha256(data).hexdigest() != source["checksum"]
    ):
        raise CaptureError("audio_checksum_mismatch")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if (
                wav.getnchannels(),
                wav.getsampwidth(),
                wav.getframerate(),
                wav.getcomptype(),
            ) != (1, 2, 16000, "NONE"):
                raise CaptureError("invalid_audio_format")
            if wav.getnframes() != source["duration_ms"] * 16:
                raise CaptureError("invalid_audio_duration")
            pcm = wav.readframes(wav.getnframes())
            if len(pcm) != source["duration_ms"] * 32:
                raise CaptureError("truncated_audio")
            return pcm
    except (EOFError, wave.Error):
        raise CaptureError("invalid_audio_container") from None


class CaptureAttempt:
    """Own exactly one execution; cancellation cannot publish partial delivery."""

    def __init__(self, backend, config, job, *, session_factory=QwenASRSession):
        """Keep audio bounded to one short chunk and text to one bounded FIFO."""
        self.backend, self.config, self.job = backend, config, job
        self.path = str(uuid.UUID(job["id"])) + "/"
        self.session_factory = session_factory
        self.queue = asyncio.Queue(maxsize=64)
        self.sessions = []
        self.sequence = self.delivered = self.text_bytes = 0
        self.done = asyncio.Event()
        self.receipt = None

    async def control(self, operation, **payload):
        """Begin is deliberately non-replayable, even when its response is lost."""
        result = await self.backend.request(
            self.path + "control/",
            {"operation": operation, **payload},
            attempts=1 if operation in {"begin", "heartbeat"} else 3,
        )
        if result.get("id") != self.job["id"] or result.get("status") != "running":
            raise CaptureError("execution_no_longer_running")

    async def download(self, index, source):
        """Fetch only a source index from this job, never a supplied external URL."""
        data = await self.backend.request(self.path + f"audio/{index}/", binary=True)
        return verified_pcm(data, source)

    def final(self, sentence, start, end):
        """Map task offsets to source time, preserving missing audio."""
        size = len(sentence.text.encode("utf-8"))
        if (
            len(sentence.text) > MAX_SENTENCE_CHARS
            or not sentence.text.strip()
            or self.sequence >= MAX_FINALS
            or self.text_bytes + size > MAX_TEXT_BYTES
            or not 0 <= sentence.start_ms < end - start
            or (
                sentence.end_ms is not None
                and not sentence.start_ms <= sentence.end_ms <= end - start
            )
        ):
            raise CaptureError("invalid_final_source")
        self.sequence += 1
        self.text_bytes += size
        try:
            self.queue.put_nowait(
                {
                    "ingest_id": sentence.ingest_id,
                    "sequence": self.sequence,
                    "start_ms": start + sentence.start_ms,
                    "end_ms": start + sentence.end_ms
                    if sentence.end_ms is not None
                    else None,
                    "text": sentence.text,
                    "language": sentence.language,
                }
            )
        except asyncio.QueueFull:
            raise CaptureError("final_delivery_overflow") from None

    async def deliver(self):
        """Retain provider UUIDs and sequence numbers across receipt retries."""
        while (payload := await self.queue.get()) is not None:
            result = await self.backend.request(self.path + "originals/", payload)
            uuid.UUID(result["id"])
            self.delivered = payload["sequence"]
        self.done.set()

    async def heartbeat(self):
        """Permission loss cancels input, provider and pending text."""
        while not self.done.is_set():
            await self.control("heartbeat")
            try:
                await asyncio.wait_for(self.done.wait(), timeout=2)
            except TimeoutError:
                pass

    async def produce(self, runs, first):
        """Each disconnected source interval owns a separate provider task."""
        for run in runs:
            start = run[0][1]["start_ms"]
            end = run[-1][1]["start_ms"] + run[-1][1]["duration_ms"]

            async def audio(current=run):
                for index, source in current:
                    pcm = first if index == 1 else await self.download(index, source)
                    for offset in range(0, len(pcm), FRAME_BYTES):
                        frame = pcm[offset : offset + FRAME_BYTES]
                        yield frame
                        await asyncio.sleep(len(frame) / 32000)
                    await self.control(
                        "ack_input", index=index, checksum=source["checksum"]
                    )

            session = self.session_factory(self.config)
            self.sessions.append(session)
            await session.run(
                audio(), lambda sentence, a=start, b=end: self.final(sentence, a, b)
            )
            if not session.provider_finished:
                raise CaptureError("provider_finish_missing")
        await self.queue.put(None)

    async def execute(self):
        """Record one frozen terminal receipt even when cancellation interrupts work."""
        success = False
        try:
            runs = audio_runs(self.job, self.config)
            if self.job.get("started") is not False:
                raise CaptureError("provider_execution_already_started")
            first = await self.download(*runs[0][0])
            await self.control("begin")
            duration = sum(item[1]["duration_ms"] for run in runs for item in run)
            async with asyncio.timeout(duration / 500 + 240):
                async with asyncio.TaskGroup() as group:
                    group.create_task(self.produce(runs, first))
                    group.create_task(self.deliver())
                    group.create_task(self.heartbeat())
            success = True
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning(
                "Standalone transcription incomplete: job=%s", self.job["id"]
            )
        finally:
            self.receipt = {
                "provider_finished": success,
                "final_sequence": self.delivered,
                "tasks": [
                    {
                        "task_id": session.task_id,
                        "finished": session.provider_finished,
                        "input_samples": session.input_samples,
                        "billed_seconds": session.billed_seconds
                        if session.billing_observed
                        else None,
                    }
                    for session in self.sessions
                ],
            }
            # If finish remains unknown, fail the process rather than claim more work.
            try:
                result = await self.backend.request(self.path + "finish/", self.receipt)
                if result.get("id") != self.job["id"] or result.get("status") not in {
                    "succeeded",
                    "incomplete",
                    "canceled",
                }:
                    raise CaptureError("terminal_receipt_unknown")
            finally:
                while not self.queue.empty():
                    self.queue.get_nowait()


async def serve():
    """A separate process polls explicitly authorized jobs; it creates none itself."""
    config = QwenASRConfig.from_env()
    backend = CaptureBackend(
        os.getenv("AGENT_BACKEND_API_URL", ""),
        os.getenv("AGENT_INTERNAL_API_TOKEN", ""),
    )
    current = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, current.cancel)
        except NotImplementedError:
            pass  # Linux container uses handlers; Windows Runner handles Ctrl-C.
    while True:
        response = await backend.request(
            "claim/", {"model": config.model, "region": config.region}
        )
        job = response["job"]
        if job:
            await CaptureAttempt(backend, config, job).execute()
        else:
            await asyncio.sleep(5)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(serve())
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    except Exception:
        logger.error(
            "Standalone transcription worker stopped; inspect backend job status."
        )
        raise SystemExit(1) from None
