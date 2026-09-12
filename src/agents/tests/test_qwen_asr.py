"""Deterministic protocol and real LiveKit STT lifecycle tests, without a provider."""

import asyncio
import json
import unittest
from unittest import mock

from livekit import rtc

from asr_observer import ASRObserver
from plugins.qwen_asr import (
    AudioTimeline,
    DirectConnect,
    QwenASRConfig,
    QwenASRError,
    QwenASRSession,
    QwenSTT,
)


class FakeSocket:
    """Reply only after the matching client action; tail text arrives at finish."""

    def __init__(self):
        """Keep protocol observations separate from audio or external credentials."""
        self.incoming = asyncio.Queue()
        self.sent = []
        self.task_id = None
        self.mode = "normal"
        self.closed = False

    def event(self, kind, payload=None, *, task_id=None):
        """Build an actual DashScope server envelope."""
        return json.dumps(
            {
                "header": {"event": kind, "task_id": task_id or self.task_id},
                "payload": payload or {},
            }
        )

    def sentence(self, **overrides):
        """Use provider offsets, including a final that arrives during shutdown."""
        return {
            "output": {
                "sentence": {
                    "sentence_id": 1,
                    "sentence_end": True,
                    "begin_time": 10,
                    "end_time": 80,
                    "text": "保留最后一句。",
                    **overrides,
                }
            },
            "usage": {"duration": 1},
        }

    async def send(self, data):
        """Acknowledge run, then emit final events when the client sends finish."""
        self.sent.append(data)
        if isinstance(data, bytes):
            if self.mode == "early_finish":
                self.incoming.put_nowait(self.event("task-finished"))
            return
        command = json.loads(data)
        self.task_id = command["header"]["task_id"]
        if command["header"]["action"] == "run-task":
            self.incoming.put_nowait(
                self.event(
                    "task-started",
                    task_id="wrong" if self.mode == "wrong_task" else None,
                )
            )
        else:
            self.incoming.put_nowait(
                self.event(
                    "result-generated",
                    self.sentence(sentence_end=False, text="partial"),
                )
            )
            self.incoming.put_nowait(
                self.event("result-generated", self.sentence(heartbeat=True))
            )
            self.incoming.put_nowait(self.event("result-generated", self.sentence()))
            self.incoming.put_nowait(self.event("result-generated", self.sentence()))
            if self.mode == "conflict":
                self.incoming.put_nowait(
                    self.event("result-generated", self.sentence(text="changed"))
                )
            elif self.mode == "error":
                self.incoming.put_nowait(
                    self.event("task-failed", {"sensitive": "do-not-log-this"})
                )
            elif self.mode == "invalid_time":
                self.incoming.put_nowait(
                    self.event(
                        "result-generated", self.sentence(sentence_id=2, end_time=-1)
                    )
                )
            elif self.mode != "no_finish":
                self.incoming.put_nowait(self.event("task-finished"))

    async def recv(self):
        """Wait for protocol progress rather than returning invented completion."""
        return await self.incoming.get()

    async def __aenter__(self):
        """Open a fake transport using the production client interface."""
        return self

    async def __aexit__(self, *args):
        """Observe cleanup on every success/failure path."""
        self.closed = True


async def pcm():
    """Two chunks at 16 kHz mono signed 16-bit, totaling 200 ms."""
    for _ in range(2):
        yield b"\x00" * 3200
        await asyncio.sleep(0)


class QwenProtocolTests(unittest.IsolatedAsyncioTestCase):
    """Finish, deduplication, source identity, credentials and malformed events."""

    def setUp(self):
        """Use a non-production secret and no network connector."""
        self.config = QwenASRConfig(
            api_key="test-only", workspace="workspace", finish_timeout=0.1
        )
        self.socket = FakeSocket()
        self.connector = mock.Mock(return_value=self.socket)
        self.session = QwenASRSession(self.config, connector=self.connector)

    async def test_tail_final_deduplicates_and_finish_is_acknowledged(self):
        """Interim/heartbeat are ignored, exact final repeats produce one original."""
        finals = []
        await self.session.run(pcm(), finals.append)
        self.assertEqual(len(finals), 1)
        self.assertEqual(finals[0].text, "保留最后一句。")
        self.assertEqual((finals[0].start_ms, finals[0].end_ms), (10, 80))
        self.assertTrue(self.session.provider_finished)
        self.assertEqual(self.session.input_samples, 3200)
        self.assertEqual(self.session.billed_seconds, 1)
        self.assertTrue(self.session.billing_observed)
        self.assertTrue(self.socket.closed)
        headers = self.connector.call_args.kwargs["additional_headers"]
        self.assertEqual(headers, {"Authorization": "Bearer test-only"})
        self.assertNotIn("test-only", repr(self.config))
        self.assertEqual(
            json.loads(self.socket.sent[-1])["header"]["action"], "finish-task"
        )

    def test_unknown_zero_and_fractional_billing_are_distinct(self):
        """Only a finite, actually observed duration may become a usage receipt."""
        self.assertFalse(self.session.billing_observed)
        self.session._usage({"usage": {"duration": float("nan")}})
        self.assertFalse(self.session.billing_observed)
        self.session._usage({"usage": {"duration": 0}})
        self.assertTrue(self.session.billing_observed)
        self.session._usage({"usage": {"duration": 0.75}})
        self.assertEqual(self.session.billed_seconds, 0.75)

    async def test_errors_are_sanitized_and_never_report_finished(self):
        """Wrong tasks, premature close, conflicting final and timeout all fail."""
        for mode in (
            "wrong_task",
            "early_finish",
            "conflict",
            "error",
            "invalid_time",
            "no_finish",
        ):
            with self.subTest(mode=mode):
                socket = FakeSocket()
                socket.mode = mode
                session = QwenASRSession(
                    self.config, connector=mock.Mock(return_value=socket)
                )
                with self.assertRaisesRegex(QwenASRError, "^asr_stream_failed$"):
                    await session.run(pcm(), mock.Mock())
                self.assertFalse(session.provider_finished)
                self.assertTrue(socket.closed)

    async def test_new_task_has_distinct_ingest_identity(self):
        """Provider sentence number 1 in another task must not reuse an old UUID."""
        first, second = [], []
        await self.session.run(pcm(), first.append)
        another = QwenASRSession(
            self.config, connector=mock.Mock(return_value=FakeSocket())
        )
        await another.run(pcm(), second.append)
        self.assertNotEqual(first[0].ingest_id, second[0].ingest_id)

    async def test_cancel_closes_socket_without_success(self):
        """Cancellation preserves failure even when no audio has been sent."""
        blocked = asyncio.Event()

        async def audio():
            await blocked.wait()
            yield b"\x00\x00"

        task = asyncio.create_task(self.session.run(audio(), mock.Mock()))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.connector.assert_not_called()
        self.assertFalse(self.session.provider_finished)

    def test_endpoint_validation_and_redirect_refusal(self):
        """Credentials stay on a validated workspace endpoint, including redirects."""
        with self.assertRaises(ValueError):
            QwenASRConfig(api_key="test", workspace="bad/path")
        with self.assertRaises(ValueError):
            QwenASRConfig(api_key="test", workspace="ok", region="other")
        exc = RuntimeError("redirect")
        self.assertIs(DirectConnect.process_redirect(None, exc), exc)

    def test_observed_pause_is_preserved_in_source_timeline(self):
        """A ten-second input gap never becomes adjacent transcript timestamps."""
        timeline = AudioTimeline()
        with mock.patch(
            "plugins.qwen_asr.time.monotonic", side_effect=[100.0, 100.1, 110.2]
        ):
            timeline.append(100)
            timeline.append(100)
            timeline.append(100)
        self.assertAlmostEqual(
            (timeline.at(200) - timeline.origin).total_seconds(), 10.2
        )
        self.assertAlmostEqual(
            (timeline.at(200, end=True) - timeline.origin).total_seconds(), 0.2
        )
        self.assertAlmostEqual(
            (timeline.at(250) - timeline.origin).total_seconds(), 10.25
        )


class QwenLiveKitTests(unittest.IsolatedAsyncioTestCase):
    """Use the installed SDK, including real resampling and stream shutdown."""

    async def test_sdk_close_drains_tail_and_concurrent_close_waits(self):
        """SDK aclose must finish the task before it cancels the provider reader."""
        config = QwenASRConfig(api_key="test-only", workspace="workspace")
        socket = FakeSocket()
        protocol = QwenASRSession(config, connector=mock.Mock(return_value=socket))
        callback, failure = mock.Mock(), mock.Mock()
        observer = ASRObserver()
        with mock.patch("plugins.qwen_asr.QwenASRSession", return_value=protocol):
            stream = QwenSTT(
                config,
                on_final=callback,
                on_failure=failure,
                on_observation=observer.observe,
            ).stream()
        self.assertEqual(stream._conn_options.max_retry, 0)
        stream.push_frame(rtc.AudioFrame(b"\x00" * 9600, 48000, 1, 4800))
        await asyncio.gather(stream.aclose(), stream.aclose())
        self.assertTrue(protocol.provider_finished)
        callback.assert_called_once()
        failure.assert_not_called()
        self.assertEqual(protocol.input_samples, 1600)
        self.assertEqual(observer.manifest()["tasks_finished"], 1)
        self.assertEqual(observer.manifest()["streams_finished"], 1)
        self.assertEqual(observer.manifest()["input_samples"], 1600)
        self.assertEqual(observer.manifest()["errors"], [])
        sentence, start, end = callback.call_args.args
        self.assertAlmostEqual(
            (end - start).total_seconds(), (sentence.end_ms - sentence.start_ms) / 1000
        )

    async def test_sdk_finish_timeout_marks_delivery_incomplete(self):
        """A tail timeout cannot be mistaken for a successful AgentSession close."""
        config = QwenASRConfig(
            api_key="test-only", workspace="workspace", finish_timeout=0.01
        )
        socket = FakeSocket()
        socket.mode = "no_finish"
        protocol = QwenASRSession(config, connector=mock.Mock(return_value=socket))
        failure = mock.Mock()
        with mock.patch("plugins.qwen_asr.QwenASRSession", return_value=protocol):
            stream = QwenSTT(config, on_failure=failure).stream()
        stream.push_frame(rtc.AudioFrame(b"\x00" * 3200, 16000, 1, 1600))
        await stream.aclose()
        failure.assert_called()
        self.assertFalse(protocol.provider_finished)
        self.assertTrue(socket.closed)

    async def test_idle_input_seals_task_and_resumes_with_new_source_id(self):
        """A muted microphone does not leave an ASR task open indefinitely."""
        config = QwenASRConfig(api_key="test-only", workspace="workspace")
        protocols = []
        callback = mock.Mock()

        def new_protocol(config):
            protocol = QwenASRSession(
                config, connector=mock.Mock(return_value=FakeSocket())
            )
            protocols.append(protocol)
            return protocol

        with (
            mock.patch("plugins.qwen_asr.QwenASRSession", side_effect=new_protocol),
            mock.patch("plugins.qwen_asr.INPUT_IDLE_SECONDS", 0.02),
        ):
            stream = QwenSTT(config, on_final=callback).stream()
            frame = rtc.AudioFrame(b"\x00" * 3200, 16000, 1, 1600)
            stream.push_frame(frame)
            async with asyncio.timeout(1):
                while not protocols[0].provider_finished:
                    await asyncio.sleep(0.005)
            stream.push_frame(frame)
            await stream.aclose()
        self.assertEqual(callback.call_count, 2)
        first, second = [call.args for call in callback.call_args_list]
        self.assertNotEqual(first[0].ingest_id, second[0].ingest_id)
        self.assertGreater(second[1], first[1])
        self.assertTrue(all(p.provider_finished for p in protocols if p.input_samples))


if __name__ == "__main__":
    unittest.main()
