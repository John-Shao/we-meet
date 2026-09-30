"""Exercise Omni SDK request serialization without provider connections."""

import asyncio
import base64
import json
import unittest
from unittest import mock

from dashscope.audio.qwen_omni import OmniRealtimeConversation

from assistant.runtime import _build_qwen_bridge
from plugins.qwen.omni import QwenOmniClient


class OmniClientTests(unittest.IsolatedAsyncioTestCase):
    """Verify workspace routing, audio configuration and legacy compatibility."""

    async def test_v38_uses_workspace_endpoint_and_serializes_audio_session(self):
        """Real SDK serialization matches the new model while media keeps flowing."""
        for region in ("cn-beijing", "ap-southeast-1"):
            with self.subTest(region=region):
                socket = mock.Mock()

                def connect(conversation, socket=socket):
                    conversation.ws = socket

                with (
                    mock.patch.dict(
                        "os.environ",
                        {
                            "DASHSCOPE_API_KEY": "test-only",
                            "DASHSCOPE_WORKSPACE_ID": "test-workspace",
                            "DASHSCOPE_REGION": region,
                        },
                        clear=True,
                    ),
                    mock.patch.object(OmniRealtimeConversation, "connect", connect),
                    mock.patch.object(OmniRealtimeConversation, "close"),
                ):
                    client = _build_qwen_bridge({}, None, "Test instructions")
                    await client.connect()
                    self.assertEqual(
                        client._conversation.url,
                        f"wss://test-workspace.{region}.maas.aliyuncs.com"
                        "/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime",
                    )
                    self.assertEqual(client._conversation.apikey, "test-only")
                    event = json.loads(socket.send.call_args.args[0])
                    self.assertEqual(event["type"], "session.update")
                    session = event["session"]
                    self.assertEqual(set(session["modalities"]), {"audio", "text"})
                    self.assertEqual(session["voice"], "Tina")
                    self.assertEqual(session["instructions"], "Test instructions")
                    self.assertEqual(session["turn_detection"]["type"], "server_vad")
                    self.assertEqual(
                        session["audio"]["input"]["format"],
                        {"type": "pcm", "sample_rate": 16000},
                    )
                    self.assertEqual(
                        session["audio"]["output"]["format"],
                        {"type": "pcm", "sample_rate": 24000},
                    )
                    self.assertNotIn("input_audio_format", session)
                    self.assertNotIn("output_audio_format", session)
                    pcm = b"\x01\x00\x02\x00"
                    client._conversation.callback.on_event(
                        {"type": "response.audio.delta", "delta": base64.b64encode(pcm)}
                    )
                    async with asyncio.timeout(1):
                        output = await client.audio_output_queue.get()
                    self.assertEqual(output.tobytes(), pcm)
                    await client.close()

    async def test_invalid_workspace_or_region_fails_before_connecting(self):
        """Reject missing or malformed endpoint settings before any provider IO."""
        for workspace, region in [
            ("", "cn-beijing"),
            ("bad/workspace", "cn-beijing"),
            ("bad.example", "cn-beijing"),
            ("test", "unsupported"),
        ]:
            with (
                self.subTest(workspace=workspace, region=region),
                mock.patch.dict(
                    "os.environ",
                    {"DASHSCOPE_WORKSPACE_ID": workspace, "DASHSCOPE_REGION": region},
                    clear=True,
                ),
                mock.patch.object(OmniRealtimeConversation, "connect") as connect,
            ):
                with self.assertRaises(ValueError):
                    await QwenOmniClient(api_key="test-only").connect()
                connect.assert_not_called()

    async def test_explicit_legacy_model_keeps_its_endpoint_and_default_voice(self):
        """Existing catalog selections remain usable during a staged rollout."""
        socket = mock.Mock()

        def connect(conversation):
            conversation.ws = socket

        with (
            mock.patch.dict(
                "os.environ", {"DASHSCOPE_API_KEY": "test-only"}, clear=True
            ),
            mock.patch.object(OmniRealtimeConversation, "connect", connect),
            mock.patch.object(OmniRealtimeConversation, "close"),
        ):
            client = _build_qwen_bridge(
                {"code": "aliyun/qwen3-omni-flash-realtime"}, None, None
            )
            await client.connect()
            self.assertEqual(
                client._conversation.url,
                "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
                "?model=qwen3-omni-flash-realtime",
            )
            session = json.loads(socket.send.call_args.args[0])["session"]
            self.assertEqual(session["voice"], "Cherry")
            self.assertEqual(session["input_audio_format"], "pcm16")
            await client.close()

    def test_bridge_preserves_explicit_voice_and_model_snapshot(self):
        """Use the catalog's selected voice and model rather than replacing them."""
        with mock.patch.dict("os.environ", {"DASHSCOPE_API_KEY": "test-only"}):
            client = _build_qwen_bridge(
                {"code": "aliyun/qwen3.8-omni-flash-realtime-test"}, "Cindy", None
            )
        self.assertEqual(client._voice, "Cindy")
        self.assertEqual(client._model, "qwen3.8-omni-flash-realtime-test")
