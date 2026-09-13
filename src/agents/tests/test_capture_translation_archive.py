"""Final-only capture archive delivery, exact receipts and gateway completion."""

import asyncio
import hashlib
import json
import unittest
import uuid
from unittest.mock import Mock

from capture_translation_archive import CaptureArchiveDelivery
from capture_translation_gateway import CaptureTranslationConnection
from tests.test_capture_translation_gateway import (
    Provider,
    Reporter,
    Socket,
    auth,
    config,
    control,
    frame,
    provider_config,
)


class ArchiveReporter(Reporter):
    """Record synthetic item delivery with a stable, source-bound backend receipt."""

    def __init__(self):
        """Use independent random IDs and retain no real user data."""
        super().__init__(auth(), config(save_translations=True))
        self.worker_id = str(uuid.uuid4())
        self.archive_id = str(uuid.uuid4())
        self.segment_id = str(uuid.uuid4())
        self.deliveries = []

    def _send(self, path, data):
        self.deliveries.append((path, data))
        payload = {
            name: data[name] for name in ("direction", "response_id", "item_id", "text")
        }
        payload.update(
            source_capture_id=data["capture_id"],
            target=self.configuration["source_language"]
            if data["direction"] == "reverse"
            else self.configuration["target_language"],
        )
        digest = hashlib.sha256(
            json.dumps(
                payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode()
        ).hexdigest()
        return {
            "id": self.segment_id,
            "archive_id": self.archive_id,
            "run_id": self.auth["run_id"],
            "capture_id": self.auth["capture_id"],
            "generation": self.auth["generation"],
            "sequence": 1,
            "payload_hash": digest,
            "replayed": False,
        }


def final():
    """Return a completed synthetic provider item, never an ASR source row."""
    return {
        "type": "target_final",
        "response_id": "response",
        "item_id": "item",
        "text": "你好",
    }


class CaptureArchiveTests(unittest.IsolatedAsyncioTestCase):
    """Durable text failure cannot be reported as successful translation completion."""

    async def test_final_only_capture_identity_and_tail_drain(self):
        """Save a final with capture provenance and no participant/room identifiers."""
        reporter = ArchiveReporter()
        delivery = CaptureArchiveDelivery(reporter)
        self.assertFalse(delivery.enqueue({**final(), "type": "target_candidate"}))
        delivery.start()
        self.assertTrue(delivery.enqueue(final()))
        self.assertTrue(await delivery.finish(1))
        path, data = reporter.deliveries[0]
        self.assertEqual(path, f"{reporter.auth['run_id']}/segments/")
        self.assertEqual(data["capture_id"], reporter.auth["capture_id"])
        self.assertNotIn("source_participation_id", data)
        self.assertNotIn("audio", data)
        self.assertEqual(delivery.segment_count, 1)
        self.assertEqual(delivery.queued_bytes, 0)

    async def test_ambiguous_item_retry_keeps_identical_payload(self):
        """Only confirmed text can retry after a lost delivery acknowledgement."""
        reporter = ArchiveReporter()
        send = reporter._send
        calls = []

        def ambiguous(path, data):
            calls.append((path, data))
            if len(calls) == 1:
                raise OSError("isolated timeout")
            return send(path, data)

        reporter._send = ambiguous
        delivery = CaptureArchiveDelivery(reporter)
        delivery.start()
        delivery.enqueue(final())
        self.assertTrue(await delivery.finish(2))
        self.assertEqual(calls[0], calls[1])

    async def test_wrong_source_receipt_and_overflow_cannot_claim_success(self):
        """Validate each backend receipt and bound retained final text."""
        reporter = ArchiveReporter()
        send = reporter._send
        reporter._send = lambda path, data: {
            **send(path, data),
            "capture_id": str(uuid.uuid4()),
        }
        delivery = CaptureArchiveDelivery(reporter)
        delivery.start()
        delivery.enqueue(final())
        self.assertFalse(await delivery.finish(2))
        self.assertEqual(delivery.queued_bytes, 0)
        delivery = CaptureArchiveDelivery(ArchiveReporter())
        for sequence in range(64):
            self.assertTrue(delivery.enqueue({**final(), "item_id": str(sequence)}))
        self.assertFalse(delivery.enqueue(final()))
        self.assertFalse(await delivery.finish(0))
        self.assertEqual(delivery.queued_bytes, 0)

    async def test_gateway_waits_for_durable_final_before_success(self):
        """Provider finish alone is insufficient; the final count must be delivered."""
        reporter = ArchiveReporter()
        socket = Socket([frame(1), control("finish", 2)])
        connection = CaptureTranslationConnection(
            socket, reporter, config_factory=provider_config, session_factory=Provider
        )
        await asyncio.wait_for(connection.run(), 2)
        self.assertTrue(socket.sent[-1]["complete"])
        self.assertEqual(reporter.calls[-1][1]["segment_count"], 1)
        self.assertEqual(len(reporter.deliveries), 1)
        self.assertEqual(connection.archive.queued_bytes, 0)

    async def test_gateway_archive_failure_is_incomplete_and_clears_queue(self):
        """A failed text sink leaves no retrying provider or growing memory queue."""
        reporter = ArchiveReporter()
        reporter._send = Mock(side_effect=OSError("isolated failure"))
        socket = Socket([frame(1), control("finish", 2)])
        connection = CaptureTranslationConnection(
            socket, reporter, config_factory=provider_config, session_factory=Provider
        )
        await asyncio.wait_for(connection.run(), 3)
        self.assertFalse(socket.sent[-1]["complete"])
        self.assertEqual(connection.archive.queued_bytes, 0)
        self.assertTrue(connection.sessions["forward"].closed)
