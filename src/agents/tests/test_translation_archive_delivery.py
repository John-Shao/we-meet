"""No network: bound retained text and verify exact backend delivery receipts."""

import asyncio
import hashlib
import json
import unittest
import urllib.error
import uuid
from types import SimpleNamespace
from unittest import mock

from tests.test_interpretation_control import grant, metadata
from tests.test_interpretation_runtime import runtime, source_for
from translation_archive_delivery import ArchiveDelivery


def sink():
    """Use a fixed validated identity with an isolated transport address."""
    reporter = SimpleNamespace(
        endpoint="http://backend/api/agent/interpretation/control/",
        token=str(uuid.uuid4()),
        identity={
            **metadata(),
            "room_id": str(uuid.uuid4()),
            "worker_id": str(uuid.uuid4()),
        },
    )
    return ArchiveDelivery(reporter, str(uuid.uuid4()), "en")


def event():
    """Only provider-confirmed text carries the stable response/item pair."""
    return {
        "type": "target_final",
        "response_id": "response",
        "item_id": "item",
        "text": "Confirmed words",
    }


class ArchiveTests(unittest.IsolatedAsyncioTestCase):
    """Archival failure cannot block audio or masquerade as complete storage."""

    async def test_candidate_text_is_never_enqueued(self):
        """Preview/stash updates never become retained meeting content."""
        value = sink()
        self.assertFalse(
            value.enqueue(grant()["sources"][0], {"type": "target_candidate"})
        )
        self.assertTrue(await value.finish(0))

    async def test_ambiguous_delivery_retries_identical_payload_and_hash(self):
        """Retries only reconcile one item and never request a new model response."""
        value = sink()
        value.enqueue(grant()["sources"][0], event())
        payload, _ = value.queue.get_nowait()
        with mock.patch.object(value, "_send", side_effect=[OSError(), True]) as send:
            self.assertTrue(await value.deliver(payload))
            self.assertEqual(send.call_args_list[0], send.call_args_list[1])
            expected = hashlib.sha256(
                json.dumps(
                    {**payload, "target": "en"},
                    sort_keys=True,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest()
            self.assertEqual(send.call_args.args[1], expected)

    async def test_definite_permission_failure_does_not_retry(self):
        """A permission denial ends archival delivery without repeated writes."""
        value = sink()
        with mock.patch.object(
            value,
            "_send",
            side_effect=urllib.error.HTTPError(value.endpoint, 403, "denied", {}, None),
        ) as send:
            self.assertFalse(await value.deliver({"text": "retained"}))
            send.assert_called_once()

    async def test_queue_overflow_is_bounded_and_incomplete(self):
        """A slow archive backend cannot create an unbounded text buffer."""
        value = sink()
        source = grant()["sources"][0]
        for index in range(65):
            value.enqueue(source, {**event(), "item_id": str(index)})
        self.assertTrue(value.failed)
        self.assertLessEqual(value.queue.qsize(), 64)
        self.assertFalse(await value.finish(0))
        self.assertEqual(value.queued_bytes, 0)

    async def test_stop_drains_one_serial_writer_before_acknowledging_storage(self):
        """The queue's last confirmation is required before archive_finished."""
        value = sink()
        source = grant()["sources"][0]
        for index in range(3):
            value.enqueue(source, {**event(), "item_id": str(index)})
        with mock.patch.object(
            value, "deliver", mock.AsyncMock(return_value=True)
        ) as deliver:
            value.start()
            self.assertTrue(await value.finish(1))
            self.assertEqual(
                [call.args[0]["item_id"] for call in deliver.call_args_list],
                ["0", "1", "2"],
            )
        self.assertEqual(value.queued_bytes, 0)

    async def test_stalled_delivery_respects_the_stop_budget(self):
        """Pending final text is reported incomplete after bounded cleanup."""
        value = sink()
        value.enqueue(grant()["sources"][0], event())

        async def stalled(_payload):
            await asyncio.Event().wait()

        with mock.patch.object(value, "deliver", stalled):
            value.start()
            self.assertFalse(await value.finish(0.01))
        self.assertTrue(value.task.done())
        self.assertEqual(value.queued_bytes, 0)

    async def test_archive_failure_is_separate_from_live_translation_success(self):
        """No recording, transcript or audio success flag is changed by the sink."""
        value = runtime()
        value.archive = SimpleNamespace(
            enqueue=mock.Mock(return_value=False),
            finish=mock.AsyncMock(return_value=False),
        )
        await source_for(value).consume(event())
        value.archive.enqueue.assert_called_once()
        self.assertFalse(value.failed)
        await value.close()
        receipt = value.reporter.command.call_args.kwargs["receipt"]
        self.assertFalse(receipt["archive_finished"])
        self.assertTrue(receipt["consumer_finished"])

    def test_receipt_checks_record_channel_generation_digest_and_bounds(self):
        """A proxy or another record's response is never accepted as confirmation."""
        value = sink()
        valid = {
            "id": str(uuid.uuid4()),
            "record_id": value.record_id,
            "channel_id": value.reporter.identity["channel_id"],
            "generation": 1,
            "payload_hash": "a" * 64,
            "sequence": 1,
            "replayed": False,
        }
        for changed in [
            {},
            {"record_id": str(uuid.uuid4())},
            {"generation": True},
            {"payload_hash": "b" * 64},
            {"sequence": True},
            {"replayed": 1},
        ]:
            response = mock.MagicMock(status=200)
            response.__enter__.return_value = response
            response.read.return_value = json.dumps({**valid, **changed}).encode()
            with mock.patch(
                "translation_archive_delivery._open", return_value=response
            ) as opened:
                self.assertEqual(value._send({}, "a" * 64), not changed)
                self.assertEqual(
                    opened.call_args.args[0].full_url,
                    "http://backend/api/agent/interpretation/segments/",
                )
