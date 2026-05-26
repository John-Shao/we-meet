"""Doubao text-to-speech plugin for LiveKit agents.

Uses V3 WebSocket bidirectional streaming: ``stream()`` receives LLM tokens
via ``push_text()``, sends them to Volcengine in real-time, and yields audio
chunks as they arrive.
"""

import asyncio
import json
import logging
import os
import uuid

import websockets
from livekit.agents import tts

from plugins.doubao_pipeline.tts_protocols import (
    EventType,
    MsgType,
    finish_connection,
    finish_session,
    receive_message,
    start_connection,
    start_session,
    task_request,
)

logger = logging.getLogger("doubao-tts")

# ---------------------------------------------------------------------------
# API Configurations
# ---------------------------------------------------------------------------
TTS_WSS_URL = "wss://openspeech.bytedance.com/api/v3/tts/bidirection"
DOUBAO_TTS_RESOURCE_ID = "seed-tts-2.0"
OUTPUT_SAMPLE_RATE = 24000
OUTPUT_CHANNELS = 1

# ---------------------------------------------------------------------------
# Main TTS class
# ---------------------------------------------------------------------------


class DoubaoTTS(tts.TTS):
    """Doubao TTS with V3 WebSocket bidirectional streaming."""

    def __init__(
        self,
        *,
        app_id: str,
        access_token: str,
        speaker: str
    ) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(
                streaming=True,
            ),
            sample_rate=OUTPUT_SAMPLE_RATE,
            num_channels=OUTPUT_CHANNELS,
        )
        self._app_id = app_id
        self._access_token = access_token
        self._speaker = speaker
        self._sample_rate = OUTPUT_SAMPLE_RATE
        self._resource_id = DOUBAO_TTS_RESOURCE_ID

    def synthesize(self, text, *, conn_options=None, **kwargs):
        raise NotImplementedError("DoubaoTTS only supports streaming mode")

    def stream(
        self,
        *,
        conn_options=None,
    ) -> "DoubaoTTSSynthesizeStream":
        return DoubaoTTSSynthesizeStream(
            tts=self,
            conn_options=conn_options,
            app_id=self._app_id,
            access_token=self._access_token,
            speaker=self._speaker,
            sample_rate=self._sample_rate,
            resource_id=self._resource_id,
        )



# ---------------------------------------------------------------------------
# V3 WebSocket bidirectional streaming
# ---------------------------------------------------------------------------


class DoubaoTTSSynthesizeStream(tts.SynthesizeStream):
    """V3 bidirectional streaming TTS.

    Receives LLM tokens via ``push_text()`` and forwards them to the
    Volcengine V3 TTS WebSocket as ``TaskRequest`` events.  Audio chunks
    arrive as ``TTSResponse`` events and are pushed to the LiveKit audio
    pipeline immediately.
    """

    def __init__(
        self,
        *,
        tts: DoubaoTTS,
        conn_options,
        app_id: str,
        access_token: str,
        speaker: str,
        sample_rate: int,
        resource_id: str,
    ) -> None:
        super().__init__(tts=tts, conn_options=conn_options)
        self._app_id = app_id
        self._access_token = access_token
        self._speaker = speaker
        self._sample_rate = sample_rate
        self._resource_id = resource_id

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        """Main loop: bridge livekit-agents text input to Volcengine V3 TTS."""
        request_id = str(uuid.uuid4())
        session_id = str(uuid.uuid4())

        headers = {
            "X-Api-App-Key": self._app_id,
            "X-Api-Access-Key": self._access_token,
            "X-Api-Resource-Id": self._resource_id,
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }

        ws = None
        try:
            ws = await websockets.connect(
                TTS_WSS_URL,
                additional_headers=headers,
                max_size=10 * 1024 * 1024,
                open_timeout=10,
            )
            logger.info("TTS WebSocket connected")

            # --- Connection handshake ---
            await start_connection(ws)
            await self._wait_event(ws, EventType.ConnectionStarted)

            # --- Session handshake ---
            session_payload = json.dumps({
                "event": EventType.StartSession,
                "namespace": "BidirectionalTTS",
                "req_params": {
                    "speaker": self._speaker,
                    "audio_params": {
                        "format": "pcm",
                        "sample_rate": self._sample_rate,
                    },
                },
            }).encode()
            await start_session(ws, session_payload, session_id)
            await self._wait_event(ws, EventType.SessionStarted)
            logger.info("TTS session started: %s", session_id)

            # --- Initialize audio output ---
            output_emitter.initialize(
                request_id=request_id,
                sample_rate=self._sample_rate,
                num_channels=OUTPUT_CHANNELS,
                mime_type="audio/pcm",
            )

            # --- Run send/receive concurrently ---
            session_done = asyncio.Event()

            send_task = asyncio.create_task(
                self._send_text_loop(ws, session_id),
                name="tts-ws-send",
            )
            recv_task = asyncio.create_task(
                self._recv_audio_loop(ws, output_emitter, session_done),
                name="tts-ws-recv",
            )

            # Wait for both: send finishes first (all text sent + FinishSession),
            # then recv finishes when SessionFinished arrives.
            await send_task
            logger.info("TTS send loop done, waiting for session_done (timeout=30s)")
            try:
                await asyncio.wait_for(session_done.wait(), timeout=30.0)
            except asyncio.TimeoutError:
                logger.error(
                    "TTS session_done TIMEOUT (30s) — audio likely cut off mid-sentence"
                )
                recv_task.cancel()
                output_emitter.flush()
                return
            recv_task.cancel()

            output_emitter.flush()
            logger.info("TTS session finished: %s", session_id)

        except asyncio.CancelledError:
            logger.info("TTS stream cancelled")
            raise
        except Exception:
            logger.exception("TTS WebSocket streaming failed")
        finally:
            if ws and ws.close_code is None:
                try:
                    await finish_connection(ws)
                    await ws.close()
                except Exception:
                    pass

    async def _send_text_loop(
        self,
        ws: websockets.WebSocketClientProtocol,
        session_id: str,
    ) -> None:
        """Read text tokens from input channel and send as TaskRequest."""
        base_request = {
            "namespace": "BidirectionalTTS",
            "event": EventType.TaskRequest,
            "req_params": {},
        }

        token_count = 0
        full_text = ""
        async for data in self._input_ch:
            if isinstance(data, self._FlushSentinel):
                logger.info(
                    "TTS send: FlushSentinel received after %d tokens, text=%r",
                    token_count, full_text[:200],
                )
                break

            # data is a text token (str)
            token_count += 1
            full_text += data
            payload = base_request.copy()
            payload["req_params"] = {"text": data}
            await task_request(
                ws, json.dumps(payload).encode(), session_id,
            )

        # Signal end of text
        logger.info("TTS send: finishing session, total tokens=%d, text_len=%d", token_count, len(full_text))
        await finish_session(ws, session_id)

    async def _recv_audio_loop(
        self,
        ws: websockets.WebSocketClientProtocol,
        output_emitter: tts.AudioEmitter,
        session_done: asyncio.Event,
    ) -> None:
        """Receive audio chunks and events from WebSocket."""
        audio_chunk_count = 0
        audio_total_bytes = 0
        try:
            while True:
                msg = await receive_message(ws)

                if msg.type == MsgType.AudioOnlyServer:
                    if msg.event == EventType.TTSResponse and msg.payload:
                        audio_chunk_count += 1
                        audio_total_bytes += len(msg.payload)
                        output_emitter.push(msg.payload)

                elif msg.type == MsgType.FullServerResponse:
                    if msg.event == EventType.SessionFinished:
                        logger.info(
                            "TTS recv: SessionFinished, audio_chunks=%d, total_bytes=%d",
                            audio_chunk_count, audio_total_bytes,
                        )
                        session_done.set()
                        return
                    if msg.event == EventType.SessionFailed:
                        logger.error(
                            "TTS recv: SessionFailed after %d audio chunks: %s",
                            audio_chunk_count,
                            msg.payload.decode("utf-8", "ignore"),
                        )
                        session_done.set()
                        return
                    # TTSSentenceStart, TTSSentenceEnd — informational, skip

                elif msg.type == MsgType.Error:
                    logger.error(
                        "TTS recv: error (code=%d) after %d audio chunks: %s",
                        msg.error_code,
                        audio_chunk_count,
                        msg.payload.decode("utf-8", "ignore"),
                    )
                    session_done.set()
                    return

        except asyncio.CancelledError:
            logger.info(
                "TTS recv: cancelled after %d audio chunks, %d bytes",
                audio_chunk_count, audio_total_bytes,
            )
            return
        except websockets.exceptions.ConnectionClosed as e:
            logger.warning(
                "TTS recv: WebSocket closed after %d audio chunks: %s",
                audio_chunk_count, e,
            )
            session_done.set()

    async def _wait_event(
        self,
        ws: websockets.WebSocketClientProtocol,
        expected: EventType,
        timeout: float = 10.0,
    ) -> None:
        """Wait for a specific server event, raise on unexpected messages."""
        msg = await asyncio.wait_for(receive_message(ws), timeout=timeout)
        if msg.event != expected:
            raise RuntimeError(
                f"Expected {expected}, got {msg.event}: "
                f"{msg.payload.decode('utf-8', 'ignore')}"
            )
