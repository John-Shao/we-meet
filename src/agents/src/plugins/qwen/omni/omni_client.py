"""DashScope Qwen-Omni-Realtime WebSocket client for LiveKit integration.

Wraps ``dashscope.audio.qwen_omni.OmniRealtimeConversation`` and bridges
its background-thread callbacks into an asyncio event loop via
``call_soon_threadsafe``.

Adapted from jusi_meet_suite — kept intentionally close to the reference
implementation so future bug fixes can be back-ported either way.
"""

import asyncio
import base64
import logging
import os
import re

import numpy as np
from dashscope.audio.qwen_omni import (
    AudioFormatConfig,
    MultiModality,
    OmniRealtimeCallback,
    OmniRealtimeConversation,
)

logger = logging.getLogger("qwen-omni-client")

DEFAULT_MODEL = "qwen3.8-omni-flash-realtime"
DEFAULT_VOICE = "Tina"
DEFAULT_INSTRUCTIONS = """##人设
你是一个名叫【AI 助手】的全能智能体，具备强大的知识储备、情感理解能力和解决问题的能力。
你的目标是高效、专业、友好地帮助用户完成各类任务，包括但不限于日常生活、工作安排、信息检索、
学习辅导、创意写作、语言翻译和技术支持等。

##技能
- 用户会将视频中的某些视频帧截为图片送给你，如果用户询问与视频和图片有关的问题，请结合
  【图片】信息和【用户问题】进行回答；如果用户询问与视频和图片无关的问题，无需描述【图片】内容，
  直接回答【用户问题】。
- 如果用户给你看的是学科题目，不需要把图片里的文字内容一个一个字读出来，
  只需要总结一下【图片】里的文字内容，然后直接回答【用户问题】，可以补充一些解题思路。

##约束
- 始终主动、礼貌、有条理；
- 回答准确但不冗长，必要时可提供简洁总结+详细解释；
- 不清楚的任务会主动澄清，不假设、不误导；
- 回答中不要出现「图片」「图中」等字眼，直接根据你看到的内容回答用户问题。

##特殊技能
会有不同的人和你说话，你可以识别并区分不同的用户。如果你觉得需要明确下这句话是对谁说的，
你可以在回复中加上用户的名字，比如「好的，xxx」「xxx，我知道了」。
"""

LEGACY_API_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
OUTPUT_SAMPLE_RATE = 24000


class _QwenCallback(OmniRealtimeCallback):
    """Bridge DashScope SDK callbacks (background thread) into asyncio."""

    def __init__(self, client: "QwenOmniClient") -> None:
        self._client = client

    def on_open(self) -> None:
        logger.info("Connected to Qwen-Omni-Realtime")

    def on_event(self, message) -> None:
        response: dict = message
        event_type = response.get("type", "")
        loop = self._client._event_loop
        if loop is None:
            return

        if event_type == "response.audio.delta":
            pcm_bytes = base64.b64decode(response["delta"])
            audio_array = np.frombuffer(pcm_bytes, dtype=np.int16).copy()
            loop.call_soon_threadsafe(
                self._client.audio_output_queue.put_nowait,
                audio_array,
            )

        elif event_type == "input_audio_buffer.speech_started":
            logger.debug("Speech started — clearing audio output queue")
            loop.call_soon_threadsafe(self._client._clear_audio_queue)

        elif event_type == "input_audio_buffer.speech_stopped":
            logger.debug("Speech stopped")

        elif event_type == "conversation.item.input_audio_transcription.completed":
            transcript = response.get("transcript", "")
            if transcript:
                logger.info("User said: %s", transcript)

        elif event_type == "response.audio_transcript.done":
            transcript = response.get("transcript", "")
            if transcript:
                logger.info("Qwen said: %s", transcript)

        elif event_type == "response.done":
            usage = response.get("usage", {})
            if usage:
                logger.info(
                    "Response done — input_tokens=%s, output_tokens=%s",
                    usage.get("input_tokens", "?"),
                    usage.get("output_tokens", "?"),
                )

    def on_close(self, close_status_code: int, close_msg: str) -> None:
        logger.info(
            "Qwen connection closed (code=%s, msg=%s)",
            close_status_code,
            close_msg,
        )


class QwenOmniClient:
    """Async-friendly wrapper around DashScope OmniRealtimeConversation."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str = DEFAULT_MODEL,
        voice: str | None = None,
        instructions: str = DEFAULT_INSTRUCTIONS,
    ) -> None:
        """Keep explicit model selections while defaulting new sessions to 3.8."""
        self._api_key = api_key
        self._model = model
        self._is_v38 = model.startswith("qwen3.8-omni-")
        self._voice = voice or (DEFAULT_VOICE if self._is_v38 else "Cherry")
        self._instructions = instructions

        self._conversation: OmniRealtimeConversation | None = None
        self._event_loop: asyncio.AbstractEventLoop | None = None
        self._audio_sent = False
        self.audio_output_queue: asyncio.Queue[np.ndarray] = asyncio.Queue()

    async def connect(self) -> None:
        """Open the WebSocket connection and configure the session."""
        url = LEGACY_API_URL
        if self._is_v38:
            workspace = os.getenv("DASHSCOPE_WORKSPACE_ID", "")
            region = os.getenv("DASHSCOPE_REGION", "cn-beijing")
            if not re.fullmatch(r"[A-Za-z0-9-]+", workspace):
                raise ValueError("A valid DASHSCOPE_WORKSPACE_ID is required")
            if region not in {"cn-beijing", "ap-southeast-1"}:
                raise ValueError("Unsupported DASHSCOPE_REGION for Qwen Omni")
            url = f"wss://{workspace}.{region}.maas.aliyuncs.com/api-ws/v1/realtime"

        self._event_loop = asyncio.get_running_loop()
        callback = _QwenCallback(self)

        self._conversation = OmniRealtimeConversation(
            model=self._model,
            callback=callback,
            url=url,
            api_key=self._api_key,
        )

        await self._event_loop.run_in_executor(None, self._conversation.connect)
        logger.info("Qwen session connected, configuring...")

        audio_config = {}
        if self._is_v38:
            audio_config = {
                "input_audio_config": AudioFormatConfig(sample_rate=16000),
                "output_audio_config": AudioFormatConfig(
                    sample_rate=OUTPUT_SAMPLE_RATE
                ),
            }
        self._conversation.update_session(
            output_modalities=[MultiModality.AUDIO, MultiModality.TEXT],
            voice=self._voice,
            instructions=self._instructions,
            **audio_config,
        )
        logger.info(
            "Qwen session configured (model=%s, voice=%s)",
            self._model,
            self._voice,
        )

    def send_audio(self, pcm_b64: str) -> None:
        """Send base64-encoded 16kHz mono PCM audio (called in executor)."""
        if self._conversation:
            self._conversation.append_audio(pcm_b64)
            self._audio_sent = True

    def send_video(self, jpeg_b64: str) -> None:
        """Send base64-encoded JPEG frame.

        Per API docs, at least one audio chunk must be sent before images.
        """
        if self._conversation and self._audio_sent:
            self._conversation.append_video(jpeg_b64)

    def _clear_audio_queue(self) -> None:
        while not self.audio_output_queue.empty():
            try:
                self.audio_output_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    async def close(self) -> None:
        """Close the provider connection without blocking the event loop."""
        if self._conversation:
            conv = self._conversation
            self._conversation = None
            await asyncio.get_running_loop().run_in_executor(None, conv.close)
            logger.info("Qwen session closed")
