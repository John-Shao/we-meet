"""Bounded final-text delivery independent of microphone and interpretation output."""

import asyncio
import hashlib
import json
import urllib.error
import urllib.request
from http import HTTPStatus

from interpretation_control import _uuid
from transcript_writer import _open

MAX_PENDING = 64
MAX_PENDING_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 4096
MAX_SEGMENTS = 20000
ATTEMPTS = 3


class ArchiveDelivery:
    """Only stable confirmed items may retry; microphone audio is never replayed."""

    def __init__(self, reporter, record_id, target):
        """Freeze the validated backend, record, channel and worker identity."""
        self.reporter = reporter
        self.record_id = _uuid(record_id)
        if target not in {"zh", "en"}:
            raise ValueError("Invalid archive target")
        self.target = target
        self.endpoint = reporter.endpoint.removesuffix("control/") + "segments/"
        self.queue = asyncio.Queue(maxsize=MAX_PENDING)
        self.queued_bytes = 0
        self.failed = self.closing = False
        self.task = None

    def start(self):
        """Start one ordered sink, independent of each provider's receive task."""
        if self.task is None:
            self.task = asyncio.create_task(self.run())

    def enqueue(self, source, event):
        """Never block translated audio on a slow archive service."""
        if self.failed or self.closing:
            return False
        if event.get("type") != "target_final":
            return False
        payload = {
            "source_participation_id": source["participation_id"],
            "source_participant_sid": source["participant_sid"],
            "direction": "forward",
            "response_id": event["response_id"],
            "item_id": event["item_id"],
            "text": event["text"],
        }
        size = len(json.dumps(payload).encode())
        if self.queue.full() or self.queued_bytes + size > MAX_PENDING_BYTES:
            self.failed = True
            return False
        self.queue.put_nowait((payload, size))
        self.queued_bytes += size
        return True

    def _send(self, payload, digest):
        request = urllib.request.Request(  # noqa: S310 -- validated operator origin
            self.endpoint,
            data=json.dumps({**self.reporter.identity, **payload}).encode(),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Agent-Token": self.reporter.token,
            },
        )
        with _open(request, timeout=2) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if response.status != HTTPStatus.OK or len(body) > MAX_RESPONSE_BYTES:
                return False
            result = json.loads(body)
        if not isinstance(result, dict):
            return False
        _uuid(result.get("id"))
        return (
            result.get("channel_id") == self.reporter.identity["channel_id"]
            and type(result.get("generation")) is int
            and result["generation"] == self.reporter.identity["generation"]
            and result.get("record_id") == self.record_id
            and result.get("payload_hash") == digest
            and type(result.get("sequence")) is int
            and 0 < result["sequence"] <= MAX_SEGMENTS
            and type(result.get("replayed")) is bool
        )

    async def deliver(self, payload):
        """Reconcile the same hash/identity after ambiguous HTTP failure only."""
        digest = hashlib.sha256(
            json.dumps(
                {**payload, "target": self.target},
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        for attempt in range(ATTEMPTS):
            try:
                if await asyncio.to_thread(self._send, payload, digest):
                    return True
            except urllib.error.HTTPError as exc:
                if (
                    exc.code < HTTPStatus.INTERNAL_SERVER_ERROR
                    and exc.code != HTTPStatus.TOO_MANY_REQUESTS
                ):
                    return False
            except (OSError, ValueError, TypeError, KeyError):
                pass
            if attempt + 1 < ATTEMPTS:
                await asyncio.sleep(0.2 * (attempt + 1))
        return False

    async def run(self):
        """Keep only one HTTP delivery in flight across all meeting speakers."""
        while not self.failed:
            payload, size = await self.queue.get()
            try:
                if not await self.deliver(payload):
                    self.failed = True
            except Exception:
                self.failed = True
            finally:
                self.queued_bytes -= size
                self.queue.task_done()
        self.discard()

    def discard(self):
        """Release pending text while retaining an incomplete finish receipt."""
        while not self.queue.empty():
            _, size = self.queue.get_nowait()
            self.queued_bytes -= size
            self.queue.task_done()

    async def finish(self, timeout):
        """Drain only within the channel's remaining stop budget."""
        self.closing = True
        try:
            if not self.queue.empty() or self.queued_bytes:
                await asyncio.wait_for(self.queue.join(), max(0, timeout))
        except TimeoutError:
            self.failed = True
        finally:
            if self.task:
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)
            self.discard()
        return not self.failed
