"""Doubao streaming speech-to-text plugin for LiveKit agents.

Implements the Volcengine ASR binary WebSocket protocol to provide
real-time speech recognition using the doubao-bigmodel ASR service.
"""

import asyncio
import json
import logging
import struct
import uuid

import websockets
from livekit import rtc
from livekit.agents import stt, utils

logger = logging.getLogger("doubao-stt")

# Binary protocol constants (matching Volcengine ASR spec)
PROTOCOL_VERSION = 0b0001
HEADER_SIZE = 0b0001

# Message types
CLIENT_FULL_REQUEST = 0b0001
CLIENT_AUDIO_ONLY_REQUEST = 0b0010
SERVER_FULL_RESPONSE = 0b1001
SERVER_ACK = 0b1011
SERVER_ERROR_RESPONSE = 0b1111

# Flags
POS_SEQUENCE = 0b0001  # header followed by positive sequence number
NEG_WITH_SEQUENCE = 0b0011  # last packet, header followed by negative sequence

# Serialization
NO_SERIALIZATION = 0b0000
JSON_SERIALIZATION = 0b0001
NO_COMPRESSION = 0b0000


# ---------------------------------------------------------------------------
# API Configurations
# ---------------------------------------------------------------------------
ASR_WSS_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
DOUBAO_ASR_RESOURCE_ID = "volc.seedasr.sauc.duration"
TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1

# ---------------------------------------------------------------------------
# ASR functions
# ---------------------------------------------------------------------------
def _build_header(msg_type: int, flags: int, serialization: int, compression: int) -> bytes:
    """Build 4-byte binary header for Volcengine ASR protocol."""
    return bytes([
        (PROTOCOL_VERSION << 4) | HEADER_SIZE,
        (msg_type << 4) | flags,
        (serialization << 4) | compression,
        0x00,  # reserved
    ])


def _build_full_request_frame(seq: int, payload: bytes) -> bytes:
    """Build a CLIENT_FULL_REQUEST frame with sequence number."""
    header = _build_header(
        CLIENT_FULL_REQUEST, POS_SEQUENCE, JSON_SERIALIZATION, NO_COMPRESSION
    )
    return header + struct.pack(">i", seq) + struct.pack(">I", len(payload)) + payload


def _build_audio_frame(seq: int, pcm: bytes, is_last: bool) -> bytes:
    """Build a CLIENT_AUDIO_ONLY_REQUEST frame with sequence number.

    For the final packet, set ``is_last=True`` and the sequence is sent as
    its negative value with the NEG_WITH_SEQUENCE flag, signalling end-of-stream.
    """
    flags = NEG_WITH_SEQUENCE if is_last else POS_SEQUENCE
    seq_value = -seq if is_last else seq
    header = _build_header(
        CLIENT_AUDIO_ONLY_REQUEST, flags, NO_SERIALIZATION, NO_COMPRESSION
    )
    return header + struct.pack(">i", seq_value) + struct.pack(">I", len(pcm)) + pcm


def _parse_response(data: bytes) -> dict:
    """Parse binary response frame from Volcengine ASR.

    Returns the JSON payload as a dict with an added 'isError' field.
    """
    if len(data) < 4:
        return {"isError": True, "error": "Response too short"}

    header_size = data[0] & 0x0F
    msg_type = (data[1] >> 4) & 0x0F
    msg_flags = data[1] & 0x0F
    is_error = msg_type == SERVER_ERROR_RESPONSE

    # Calculate payload offset
    # For error responses, description length field is 8 bytes; otherwise 4 bytes
    desc_len = 8 if is_error else 4
    sequence_len = 4 if (msg_flags & 1) else 0
    payload_offset = header_size * 4 + sequence_len + desc_len

    if payload_offset >= len(data):
        return {"isError": is_error, "error": "No payload in response"}

    payload_bytes = data[payload_offset:]
    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
        payload["isError"] = is_error
        return payload
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return {"isError": True, "error": str(e)}


def _resample_audio(
    pcm_data: bytes,
    src_rate: int,
    dst_rate: int,
    num_channels: int,
) -> bytes:
    """Resample PCM audio data from src_rate to dst_rate.

    Uses linear interpolation for simplicity. Input/output is 16-bit signed PCM.
    """
    if src_rate == dst_rate and num_channels == TARGET_CHANNELS:
        return pcm_data

    import array

    samples = array.array("h")
    samples.frombytes(pcm_data)

    # Mix to mono if stereo
    if num_channels > 1:
        mono = []
        for i in range(0, len(samples), num_channels):
            mono.append(
                sum(samples[i : i + num_channels]) // num_channels
            )
        samples = array.array("h", mono)

    if src_rate == dst_rate:
        return samples.tobytes()

    # Linear interpolation resampling
    ratio = src_rate / dst_rate
    out_len = int(len(samples) / ratio)
    resampled = array.array("h")
    for i in range(out_len):
        src_pos = i * ratio
        idx = int(src_pos)
        frac = src_pos - idx
        if idx + 1 < len(samples):
            val = int(samples[idx] * (1 - frac) + samples[idx + 1] * frac)
        else:
            val = samples[min(idx, len(samples) - 1)]
        resampled.append(max(-32768, min(32767, val)))

    return resampled.tobytes()


# ---------------------------------------------------------------------------
# Main ASR classes
# ---------------------------------------------------------------------------
class DoubaoSTT(stt.STT):
    """Doubao streaming speech-to-text using Volcengine ASR."""

    def __init__(
        self,
        *,
        app_id: str,
        access_token: str,
        model_name: str = "bigmodel",
        sample_rate: int = TARGET_SAMPLE_RATE,
    ) -> None:
        super().__init__(
            capabilities=stt.STTCapabilities(
                streaming=True,
                interim_results=True,
            ),
        )
        self._app_id = app_id
        self._access_token = access_token
        self._model_name = model_name
        self._sample_rate = sample_rate

    async def _recognize_impl(
        self,
        buffer,
        *,
        language: str | None = None,
    ) -> "stt.SpeechEvent":
        raise NotImplementedError("DoubaoSTT only supports streaming recognition")

    def stream(
        self,
        *,
        language: str | None = None,
        conn_options=None,
        **kwargs,
    ) -> "DoubaoSTTStream":
        logger.info("DoubaoSTT.stream() called - creating STT stream")
        return DoubaoSTTStream(
            stt=self,
            conn_options=conn_options,
            app_id=self._app_id,
            access_token=self._access_token,
            model_name=self._model_name,
            sample_rate=self._sample_rate,
        )


class DoubaoSTTStream(stt.SpeechStream):
    """Streaming STT using Volcengine ASR WebSocket binary protocol."""

    def __init__(
        self,
        *,
        stt: DoubaoSTT,
        conn_options,
        app_id: str,
        access_token: str,
        model_name: str,
        sample_rate: int,
    ) -> None:
        super().__init__(stt=stt, conn_options=conn_options)
        self._app_id = app_id
        self._access_token = access_token
        self._model_name = model_name
        self._sample_rate = sample_rate
        self._request_id = str(uuid.uuid4())
        self._seq = 1  # protocol sequence number, monotonic per connection

    def _build_full_client_request(self) -> bytes:
        """Build the initial CLIENT_FULL_REQUEST message."""
        config = {
            "user": {"uid": f"livekit-agent-{self._request_id[:8]}"},
            "audio": {
                "format": "pcm",
                "rate": self._sample_rate,
                "bits": 16,
                "channel": 1,
            },
            "request": {
                "model_name": self._model_name,
                "result_type": "single",
                "show_utterances": True,
                "end_window_size": 600,
                "force_to_speech_time": 1500,
            },
        }
        payload = json.dumps(config).encode("utf-8")
        return _build_full_request_frame(self._seq, payload)

    async def _run(self) -> None:
        """Main processing loop: bridge LiveKit audio frames to ASR WebSocket."""
        # Shared state: latest accumulated text from ASR (updated by _recv_results,
        # read by _send_audio on FlushSentinel to emit FINAL_TRANSCRIPT)
        self._latest_text: str = ""
        logger.info("DoubaoSTTStream._run() started - connecting to ASR WebSocket")
        
        headers = {
            "X-Api-App-Key": self._app_id,
            "X-Api-Access-Key": self._access_token,
            "X-Api-Resource-Id": DOUBAO_ASR_RESOURCE_ID,
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }
        logger.info("ASR WebSocket URL: %s", ASR_WSS_URL)

        try:
            logger.info("Attempting WebSocket connect to ASR...")
            async with websockets.connect(ASR_WSS_URL, additional_headers=headers, open_timeout=15) as ws:
                logger.info("WebSocket connected to ASR service successfully")

                # Send initial configuration (seq=1)
                init_msg = self._build_full_client_request()
                await ws.send(init_msg)
                self._seq += 1
                logger.info("ASR init message sent (%d bytes)", len(init_msg))

                # Wait for ACK with timeout
                logger.info("Waiting for ASR ACK...")
                try:
                    ack = await asyncio.wait_for(ws.recv(), timeout=10.0)
                except asyncio.TimeoutError:
                    logger.error("ASR init ACK timeout (10s) - server did not respond")
                    return

                ack_data = _parse_response(ack)
                logger.info("ASR ACK received: %s", ack_data)
                if ack_data.get("isError"):
                    logger.error("ASR init failed: %s", ack_data)
                    return

                logger.info("ASR session initialized, starting audio pipeline")
                # Start concurrent send/receive tasks
                send_task = asyncio.create_task(self._send_audio(ws))
                recv_task = asyncio.create_task(self._recv_results(ws))

                await asyncio.gather(send_task, recv_task)

        except websockets.exceptions.ConnectionClosed as e:
            logger.warning("ASR WebSocket connection closed: %s", e)
        except asyncio.CancelledError:
            logger.info("ASR stream cancelled (session ended)")
            raise
        except websockets.exceptions.InvalidStatus as e:
            body = getattr(e.response, 'body', None) or getattr(e, 'body', None)
            headers = getattr(e.response, 'headers', None)
            logger.error(
                "ASR WebSocket rejected: HTTP %s, body=%s, headers=%s",
                e.response.status_code if hasattr(e.response, 'status_code') else e,
                body, headers,
            )
        except Exception:
            logger.exception("ASR stream error")

    async def _send_audio(self, ws: websockets.WebSocketClientProtocol) -> None:
        """Read audio frames from input channel and send to ASR WebSocket."""
        frame_count = 0
        async for data in self._input_ch:
            if isinstance(data, self._FlushSentinel):
                # VAD detected end-of-speech — emit current accumulated text as FINAL
                text = self._latest_text
                if text:
                    self._latest_text = ""
                    logger.info("VAD FlushSentinel: emitting FINAL_TRANSCRIPT: %r", text)
                    event = stt.SpeechEvent(
                        type=stt.SpeechEventType.FINAL_TRANSCRIPT,
                        alternatives=[
                            stt.SpeechData(
                                language="zh",
                                text=text,
                                confidence=1.0,
                            )
                        ],
                    )
                    self._event_ch.send_nowait(event)
                else:
                    logger.debug("VAD FlushSentinel received but no accumulated text")
                continue

            frame: rtc.AudioFrame = data
            frame_count += 1
            if frame_count == 1:
                logger.info(
                    "First audio frame received: rate=%d Hz, channels=%d, samples=%d",
                    frame.sample_rate,
                    frame.num_channels,
                    len(frame.data) // 2,
                )
            elif frame_count % 200 == 0:
                logger.debug("Audio pipeline active: sent %d frames to ASR", frame_count)

            # Resample to 16kHz mono PCM
            pcm = _resample_audio(
                bytes(frame.data),
                frame.sample_rate,
                TARGET_SAMPLE_RATE,
                frame.num_channels,
            )

            # Build audio-only request with monotonic sequence number
            await ws.send(_build_audio_frame(self._seq, pcm, is_last=False))
            self._seq += 1

        logger.info("Audio input channel closed, sent total %d frames", frame_count)
        # Final empty frame with NEG_WITH_SEQUENCE flag to signal end of stream
        await ws.send(_build_audio_frame(self._seq, b"", is_last=True))

    async def _recv_results(self, ws: websockets.WebSocketClientProtocol) -> None:
        """Receive ASR results from WebSocket and emit SpeechEvents."""
        msg_count = 0
        try:
            async for msg in ws:
                msg_count += 1
                if isinstance(msg, str):
                    data = json.loads(msg)
                else:
                    data = _parse_response(msg)

                logger.debug("ASR msg #%d raw: %s", msg_count, data)

                if data.get("isError"):
                    logger.error("ASR error response: %s", data)
                    continue

                result = data.get("result", {})
                text = result.get("text", "")
                utterances = result.get("utterances", [])
                # Also check top-level definite flag (some ASR versions)
                is_definite_top = result.get("definite", False)

                if not text and not utterances:
                    logger.debug("ASR empty result #%d, skipping", msg_count)
                    continue

                # Check if final: either top-level definite or any utterance definite
                is_final = is_definite_top or any(
                    u.get("definite", False) for u in utterances
                )

                if is_final:
                    # ASR itself says this utterance is final — emit immediately
                    final_text = text
                    for u in utterances:
                        if u.get("definite"):
                            final_text = u.get("text", text)
                            break
                    self._latest_text = ""  # clear so FlushSentinel doesn't double-emit
                    logger.info("ASR FINAL (definite) transcript: %r", final_text)
                    event = stt.SpeechEvent(
                        type=stt.SpeechEventType.FINAL_TRANSCRIPT,
                        alternatives=[
                            stt.SpeechData(
                                language="zh",
                                text=final_text,
                                confidence=1.0,
                            )
                        ],
                    )
                    self._event_ch.send_nowait(event)
                elif text:
                    # Accumulate text; FlushSentinel in _send_audio will emit FINAL
                    self._latest_text = text
                    logger.debug("ASR INTERIM transcript: %r", text)

        except websockets.exceptions.ConnectionClosed:
            logger.info("ASR receive loop ended (connection closed), total msgs: %d", msg_count)
        except Exception:
            logger.exception("ASR receive error after %d msgs", msg_count)
