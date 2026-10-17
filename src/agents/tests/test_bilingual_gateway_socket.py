"""Exercise the production gateway over real loopback WebSockets without paid APIs."""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from plugins.qwen.live_translate import TranslationConfig
from translation.assistant_gateway import AssistantTranslationConnection
from translation.bilingual_session import BilingualTranslationSession
from translation.capture_gateway import MAX_CONNECTIONS, CaptureTranslationGateway
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from tests.test_assistant_translation import grant
from tests.test_bilingual_audio import FakeVad
from tests.test_qwen_live_translate import FakeSocket, done, target


class GatewaySocketTests(unittest.IsolatedAsyncioTestCase):
    """Verify framing, completion, admission and cleanup across a real socket."""

    async def asyncSetUp(self):
        """Replace only remote admission, providers and speech inference."""
        self.providers = []
        self.vads = []
        self.leases = AsyncMock(return_value={"status": "active"})
        self.claim = AsyncMock(
            side_effect=lambda ticket: grant(session_id=ticket, fixed_source="zh")
        )

        def provider(config, consume):
            tail = [
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "source",
                    "language": "zh",
                    "transcript": "你好",
                },
                {
                    "type": "conversation.item.created",
                    "previous_item_id": "source",
                    "item": {"id": "i1", "role": "assistant", "content": []},
                },
                {
                    "type": "response.audio.delta",
                    "response_id": "r1",
                    "item_id": "i1",
                    "delta": "AQACAA==",
                },
                target(text="Hello"),
                done(),
                {"type": "session.finished"},
            ]
            socket = FakeSocket(tail=tail)
            self.providers.append(socket)
            return BilingualTranslationSession(
                config, consume, connector=AsyncMock(return_value=socket)
            )

        async def vad():
            stream = FakeVad()
            self.vads.append(stream)
            return stream

        def connection(socket):
            return AssistantTranslationConnection(
                socket,
                claim_ticket=self.claim,
                update_lease=self.leases,
                config_factory=lambda **kw: TranslationConfig(
                    "fixture", "workspace", **kw
                ),
                session_factory=provider,
                vad_factory=vad,
            )

        patched = patch(
            "translation.capture_gateway.AssistantTranslationConnection",
            side_effect=connection,
        )
        patched.start()
        self.addCleanup(patched.stop)
        self.gateway = CaptureTranslationGateway(origins=["https://fixture.invalid"])
        self.server = await serve(
            self.gateway.handle,
            "127.0.0.1",
            0,
            max_size=8192,
            max_queue=4,
            compression=None,
        )
        self.addAsyncCleanup(self.server.wait_closed)
        self.addCleanup(self.server.close)
        self.url = f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}/capture-translation"

    async def open_client(self, ticket="local-ticket"):
        """Authenticate only in the first frame, as the Android wire does."""
        socket = await connect(self.url, proxy=None, compression=None)
        self.addAsyncCleanup(socket.close)
        await socket.send(
            json.dumps({"type": "assistant_translation", "ticket": ticket})
        )
        self.assertEqual(json.loads(await socket.recv())["type"], "ready")
        return socket

    async def test_binary_audio_ack_and_final_sentence_survive_finish_and_socket_close(
        self,
    ):
        """The production normalizer and router deliver the tail before finished."""
        socket = await self.open_client()
        pcm = b"\1\0" * 1600
        await socket.send(pcm)
        self.assertEqual(json.loads(await socket.recv()), {"type": "ack"})
        self.vads[0].event("start_of_speech", pcm)
        await socket.send('{"type":"finish"}')
        output = []
        async with asyncio.timeout(5):
            async for frame in socket:
                output.append(json.loads(frame))
        self.assertEqual(
            [event["type"] for event in output],
            ["audio", "translation", "audio_end", "finished"],
        )
        self.assertEqual(output[1]["text"], "Hello")
        self.assertEqual(output[0]["id"], output[2]["id"])
        self.assertEqual(self.gateway.active, 0)
        self.assertTrue(self.vads[0].closed)
        self.assertEqual(self.providers[0].closes, 1)
        self.assertEqual(self.leases.call_args.args, ("local-ticket", "close"))
        usage = self.leases.call_args.kwargs["usage"]
        self.assertTrue(usage["complete"])
        self.assertEqual(usage["input_bytes"], len(pcm))
        self.assertEqual(usage["translations"], 1)
        self.assertEqual(usage["providers"], 1)
        # Count the successfully delivered wire frames, including the ready and ACK.
        expected_bytes = sum(len(json.dumps(event)) for event in output)
        self.assertGreater(usage["output_bytes"], expected_bytes)
        self.assertNotIn("Hello", json.dumps(usage))

    async def test_concurrent_admission_limit_rejects_before_claim_and_releases_all(
        self,
    ):
        """A 65th connection cannot allocate providers or bypass the 64-slot cap."""
        async with asyncio.timeout(15):
            clients = await asyncio.gather(
                *(
                    self.open_client(f"ticket-{index}")
                    for index in range(MAX_CONNECTIONS)
                )
            )
            self.assertEqual(self.gateway.active, MAX_CONNECTIONS)
            async with connect(self.url, proxy=None) as rejected:
                with self.assertRaises(ConnectionClosed):
                    await rejected.recv()
            self.assertEqual(self.claim.await_count, MAX_CONNECTIONS)
            self.assertEqual(len(self.providers), MAX_CONNECTIONS)
            await asyncio.gather(*(client.close() for client in clients))
            while self.gateway.active:
                await asyncio.sleep(0.01)
        self.assertTrue(all(provider.closes == 1 for provider in self.providers))
        self.assertTrue(all(vad.closed for vad in self.vads))
