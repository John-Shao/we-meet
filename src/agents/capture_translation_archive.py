"""Bounded durable final-text delivery using real capture provenance."""

import asyncio
import json
import uuid

from translation_archive_delivery import (
    MAX_PENDING,
    MAX_PENDING_BYTES,
    MAX_SEGMENTS,
    ArchiveDelivery,
)


class CaptureArchiveDelivery(ArchiveDelivery):
    """Reuse ordered final-only retry without inventing meeting participants."""

    def __init__(self, reporter):
        """Freeze one worker, capture and language pair from the backend grant."""
        self.reporter = reporter
        self.targets = {"forward": reporter.configuration["target_language"]}
        if reporter.configuration["mode"] == "push_to_talk":
            self.targets["reverse"] = reporter.configuration["source_language"]
        self.queue = asyncio.Queue(maxsize=MAX_PENDING)
        self.queued_bytes = self.segment_count = 0
        self.failed = self.closing = False
        self.task = None
        self.archive_id = None

    def enqueue(self, event, *, direction="forward"):
        """Accept only completed provider items into the bounded text queue."""
        if self.failed or self.closing or event.get("type") != "target_final":
            return False
        if direction not in self.targets or self.segment_count >= MAX_SEGMENTS:
            self.failed = True
            return False
        payload = {
            "source_capture_id": self.reporter.auth["capture_id"],
            "direction": direction,
            "response_id": event["response_id"],
            "item_id": event["item_id"],
            "text": event["text"],
        }
        size = len(json.dumps(payload).encode())
        if self.queue.full() or self.queued_bytes + size > MAX_PENDING_BYTES:
            self.failed = True
            return False
        self.queue.put_nowait((payload, size))
        self.segment_count += 1
        self.queued_bytes += size
        return True

    def _send(self, payload, digest):
        data = {
            key: value for key, value in payload.items() if key != "source_capture_id"
        }
        result = self.reporter._send(
            f"{self.reporter.auth['run_id']}/segments/",
            {
                **data,
                "capture_id": self.reporter.auth["capture_id"],
                "generation": self.reporter.auth["generation"],
                "worker_id": self.reporter.worker_id,
            },
        )
        if not isinstance(result, dict):
            return False
        uuid.UUID(result["id"])
        archive_id = str(uuid.UUID(result["archive_id"]))
        if self.archive_id and self.archive_id != archive_id:
            return False
        valid = (
            result.get("run_id") == self.reporter.auth["run_id"]
            and result.get("capture_id") == self.reporter.auth["capture_id"]
            and type(result.get("generation")) is int
            and result["generation"] == self.reporter.auth["generation"]
            and result.get("payload_hash") == digest
            and type(result.get("sequence")) is int
            and 0 < result["sequence"] <= MAX_SEGMENTS
            and type(result.get("replayed")) is bool
        )
        if valid:
            self.archive_id = archive_id
        return valid

    async def deliver(self, payload):
        """Bound the entire HTTP retry window, including any slow response reads."""
        try:
            return await asyncio.wait_for(super().deliver(payload), 8)
        except TimeoutError:
            return False
