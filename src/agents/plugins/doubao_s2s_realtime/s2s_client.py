"""Volcengine Doubao S2S Realtime WebSocket client for LiveKit integration.

Connects to the 豆包端到端实时语音大模型 API via a custom binary WebSocket
protocol, bridging audio I/O through an asyncio queue — the same shape as
the Qwen omni-client so the worker can route by provider uniformly.
"""

import asyncio
import gzip
import json
import logging
import uuid

import numpy as np
import websockets

from plugins.doubao_s2s_realtime import protocol

logger = logging.getLogger("doubao-s2s-client")

WS_URL = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue"
RESOURCE_ID = "volc.speech.dialog"
APP_KEY = "PlgvMymc7f3tQnJ6"

OUTPUT_SAMPLE_RATE = 24000
INPUT_SAMPLE_RATE = 16000

DEFAULT_VOICE = "zh_female_vv_jupiter_bigtts"
DEFAULT_MODEL = "1.2.1.1"
DEFAULT_BOT_NAME = "AI 助手"
DEFAULT_SYSTEM_ROLE = "你使用活泼灵动的女声，性格开朗，热爱生活。"
DEFAULT_SPEAKING_STYLE = "你的说话风格简洁明了，语速适中，语调自然。"


class DoubaoS2SClient:
    """Async WebSocket client for the Volcengine S2S Realtime API."""

    def __init__(
        self,
        *,
        app_id: str,
        access_key: str,
        model: str = DEFAULT_MODEL,
        voice: str = DEFAULT_VOICE,
        bot_name: str = DEFAULT_BOT_NAME,
        system_role: str = DEFAULT_SYSTEM_ROLE,
        speaking_style: str = DEFAULT_SPEAKING_STYLE,
    ) -> None:
        self._app_id = app_id
        self._access_key = access_key
        self._model = model
        self._voice = voice
        self._bot_name = bot_name
        self._system_role = system_role
        self._speaking_style = speaking_style

        self._ws: websockets.WebSocketClientProtocol | None = None
        self._session_id: str = ""
        self._receive_task: asyncio.Task | None = None
        self._is_connected: bool = False
        self.audio_output_queue: asyncio.Queue[np.ndarray] = asyncio.Queue()

    async def connect(self) -> None:
        """Open WebSocket, send StartConnection then StartSession."""
        self._session_id = str(uuid.uuid4())

        headers = {
            "X-Api-App-ID": self._app_id,
            "X-Api-Access-Key": self._access_key,
            "X-Api-Resource-Id": RESOURCE_ID,
            "X-Api-App-Key": APP_KEY,
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }

        self._ws = await websockets.connect(
            WS_URL,
            additional_headers=headers,
            ping_interval=None,
        )
        logid = self._ws.response.headers.get("X-Tt-Logid", "")
        logger.info("WebSocket connected (logid=%s)", logid)

        await self._send_event(event_id=1, payload={}, include_session=False)
        resp = protocol.parse_response(await self._ws.recv())
        logger.info("StartConnection response: %s", resp)

        session_config = {
            "asr": {"extra": {"end_smooth_window_ms": 1500}},
            "tts": {
                "speaker": self._voice,
                "audio_config": {
                    "channel": 1,
                    "format": "pcm_s16le",
                    "sample_rate": OUTPUT_SAMPLE_RATE,
                },
            },
            "dialog": {
                "bot_name": self._bot_name,
                "system_role": self._system_role,
                "speaking_style": self._speaking_style,
                "extra": {
                    "strict_audit": False,
                    "input_mod": "keep_alive",
                    "model": self._model,
                },
            },
        }
        await self._send_event(event_id=100, payload=session_config)
        resp = protocol.parse_response(await self._ws.recv())
        logger.info("StartSession response: %s", resp)

        self._is_connected = True
        self._receive_task = asyncio.create_task(
            self._receive_loop(), name="s2s-receive"
        )
        logger.info(
            "S2S session started (model=%s, voice=%s, session=%s)",
            self._model,
            self._voice,
            self._session_id,
        )

    async def close(self) -> None:
        if not self._ws:
            return

        self._is_connected = False

        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass

        try:
            await self._send_event(event_id=102, payload={})
            try:
                async with asyncio.timeout(5):
                    while True:
                        raw = await self._ws.recv()
                        resp = protocol.parse_response(raw)
                        if resp.get("event") in (152, 153):
                            break
            except (TimeoutError, Exception):
                pass

            await self._send_event(event_id=2, payload={}, include_session=False)
        except Exception:
            logger.debug("Error during graceful shutdown", exc_info=True)

        try:
            await self._ws.close()
        except Exception:
            pass
        self._ws = None
        logger.info("S2S session closed")

    async def send_audio(self, pcm_bytes: bytes) -> None:
        """Send raw 16kHz mono PCM audio (event 200)."""
        if not self._ws or not self._is_connected:
            return
        frame = bytearray(
            protocol.generate_header(
                message_type=protocol.CLIENT_AUDIO_ONLY_REQUEST,
                serial_method=protocol.NO_SERIALIZATION,
            )
        )
        frame.extend((200).to_bytes(4, "big"))
        frame.extend(len(self._session_id).to_bytes(4, "big"))
        frame.extend(self._session_id.encode())
        compressed = gzip.compress(pcm_bytes)
        frame.extend(len(compressed).to_bytes(4, "big"))
        frame.extend(compressed)
        await self._ws.send(frame)

    async def say_hello(self, content: str = "你好，我是 AI 助手，有什么可以帮您？") -> None:
        await self._send_event(event_id=300, payload={"content": content})

    async def _receive_loop(self) -> None:
        try:
            while self._is_connected:
                raw = await self._ws.recv()
                resp = protocol.parse_response(raw)
                if not resp:
                    continue
                self._handle_response(resp)
        except asyncio.CancelledError:
            logger.debug("Receive loop cancelled")
        except websockets.ConnectionClosed as e:
            logger.warning("WebSocket connection closed: %s", e)
        except Exception:
            logger.exception("Unexpected error in receive loop")
        finally:
            self._is_connected = False

    def _handle_response(self, resp: dict) -> None:
        msg_type = resp.get("message_type")
        event = resp.get("event")

        if msg_type == "SERVER_ACK" and isinstance(resp.get("payload_msg"), bytes):
            audio_array = np.frombuffer(resp["payload_msg"], dtype=np.int16).copy()
            self.audio_output_queue.put_nowait(audio_array)

        elif msg_type == "SERVER_FULL_RESPONSE":
            payload = resp.get("payload_msg", {})

            if event == 450:
                logger.debug("ASRInfo: user speaking, clearing audio queue")
                self._clear_audio_queue()

            elif event == 451:
                results = payload.get("results", []) if isinstance(payload, dict) else []
                for r in results:
                    text = r.get("text", "")
                    is_interim = r.get("is_interim", True)
                    if text and not is_interim:
                        logger.info("User said: %s", text)

            elif event == 550:
                if isinstance(payload, dict):
                    content = payload.get("content", "")
                    if content:
                        logger.info("Bot said: %s", content)

            elif event in (152, 153):
                logger.info("Session ended (event=%s)", event)
                self._is_connected = False

        elif msg_type == "SERVER_ERROR":
            code = resp.get("code", 0)
            error_msg = resp.get("payload_msg", {})
            logger.error("Server error: code=%s, msg=%s", code, error_msg)

    def _clear_audio_queue(self) -> None:
        while not self.audio_output_queue.empty():
            try:
                self.audio_output_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    async def _send_event(
        self,
        event_id: int,
        payload: dict,
        include_session: bool = True,
    ) -> None:
        frame = bytearray(protocol.generate_header())
        frame.extend(event_id.to_bytes(4, "big"))
        if include_session:
            frame.extend(len(self._session_id).to_bytes(4, "big"))
            frame.extend(self._session_id.encode())
        payload_bytes = gzip.compress(json.dumps(payload).encode())
        frame.extend(len(payload_bytes).to_bytes(4, "big"))
        frame.extend(payload_bytes)
        await self._ws.send(frame)
