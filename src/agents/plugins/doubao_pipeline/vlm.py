"""Doubao VLM+LLM dual-branch reasoning handler.

Uses the official Volcengine Ark Python SDK (``volcenginesdkarkruntime``)
to call doubao-vision-pro (VLM) and doubao-pro (LLM) models with a racing
strategy for optimal latency.
"""

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from volcenginesdkarkruntime import AsyncArk
from volcenginesdkarkruntime._exceptions import ArkRateLimitError

from plugins.doubao_pipeline.prompts import (
    FRAME_DESCRIPTION_PREFIX,
    LAST_HISTORY_MESSAGES,
    LLM_PROMPT,
    VLM_CHAT_PROMPT,
    VLM_PROMPT,
)

logger = logging.getLogger("doubao-vlm")


@dataclass
class ConversationContext:
    """Per-session conversation state."""

    history: list[dict] = field(default_factory=list)
    latest_frame_b64: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def append_message(self, role: str, content: str) -> None:
        async with self.lock:
            self.history.append({"role": role, "content": content})

    async def get_history_snapshot(self) -> list[dict]:
        async with self.lock:
            return list(self.history[-LAST_HISTORY_MESSAGES:])

    async def update_frame(self, frame_b64: str) -> None:
        async with self.lock:
            self.latest_frame_b64 = frame_b64

    async def get_latest_frame(self) -> str | None:
        async with self.lock:
            return self.latest_frame_b64


class DoubaoVLM:
    """Dual-branch VLM+LLM reasoning with Volcengine Ark API."""

    # Circuit breaker: stop VLM calls for this many seconds after rate limit
    _VLM_BACKOFF_SECS = 120.0

    def __init__(
        self,
        *,
        api_key: str,
        vlm_endpoint: str,
        llm_endpoint: str,
        base_url: str = "https://ark.cn-beijing.volces.com/api/v3",
        custom_llm_prompt: str = "",
    ) -> None:
        self._client = AsyncArk(api_key=api_key, base_url=base_url)
        self._vlm_endpoint = vlm_endpoint
        self._llm_endpoint = llm_endpoint
        self._vlm_blocked_until: float = 0.0  # epoch seconds
        self._llm_prompt = custom_llm_prompt or LLM_PROMPT

    def _vlm_is_blocked(self) -> bool:
        return time.monotonic() < self._vlm_blocked_until

    def _block_vlm(self) -> None:
        self._vlm_blocked_until = time.monotonic() + self._VLM_BACKOFF_SECS
        logger.warning("VLM circuit-breaker: pausing VLM calls for %.0fs", self._VLM_BACKOFF_SECS)

    async def summarize_frame(self, frame_b64: str) -> str:
        """Summarize a video frame using VLM, returns description text."""
        if self._vlm_is_blocked():
            return ""
        try:
            resp = await self._client.chat.completions.create(
                model=self._vlm_endpoint,
                messages=[
                    {"role": "system", "content": VLM_PROMPT},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "描述这个画面"},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{frame_b64}"
                                },
                            },
                        ],
                    },
                ],
            )
            return resp.choices[0].message.content or ""
        except ArkRateLimitError:
            self._block_vlm()
            return ""
        except Exception:
            logger.exception("Failed to summarize frame")
            return ""

    async def _chat_with_vlm(
        self, user_text: str, frame_b64: str
    ) -> tuple[bool, str]:
        """Try answering with VLM using current frame only.

        Returns (can_answer, full_response_text).
        If VLM starts with "不知道", returns (False, "").
        """
        if self._vlm_is_blocked():
            return False, ""
        try:
            stream = await self._client.chat.completions.create(
                model=self._vlm_endpoint,
                messages=[
                    {"role": "system", "content": VLM_CHAT_PROMPT},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": user_text},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{frame_b64}"
                                },
                            },
                        ],
                    },
                ],
                stream=True,
            )

            collected = ""
            checked = False
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content or ""
                collected += delta

                if not checked and len(collected) >= 3:
                    checked = True
                    if collected.startswith("不知道"):
                        await stream.close()
                        return False, ""

            return True, collected

        except ArkRateLimitError:
            self._block_vlm()
            return False, ""
        except Exception:
            logger.exception("VLM chat failed")
            return False, ""

    async def _chat_with_llm(
        self, user_text: str, history: list[dict]
    ) -> str:
        """Answer using LLM with full conversation history and frame summaries."""
        try:
            messages = [{"role": "system", "content": self._llm_prompt}]
            messages.extend(history)
            messages.append({"role": "user", "content": user_text})

            stream = await self._client.chat.completions.create(
                model=self._llm_endpoint,
                messages=messages,
                stream=True,
            )

            collected = ""
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content or ""
                collected += delta

            return collected

        except Exception:
            logger.exception("LLM chat failed")
            return "抱歉，我暂时无法回答这个问题。"

    async def dual_race(
        self,
        user_text: str,
        frame_b64: str | None,
        history: list[dict],
    ) -> str:
        """Launch VLM and LLM concurrently, return the winning response.

        Strategy:
        - If frame available: race VLM (current frame) vs LLM (history)
        - VLM checked first; if it says "不知道", fall back to LLM
        - If no frame: use LLM directly
        """
        if not frame_b64:
            logger.info("No frame available, using LLM only")
            return await self._chat_with_llm(user_text, history)

        vlm_task = asyncio.create_task(
            self._chat_with_vlm(user_text, frame_b64)
        )
        llm_task = asyncio.create_task(
            self._chat_with_llm(user_text, history)
        )

        can_answer, vlm_result = await vlm_task
        if can_answer:
            logger.info("VLM responded, using VLM answer")
            llm_task.cancel()
            return vlm_result

        logger.info("VLM cannot answer, waiting for LLM")
        llm_result = await llm_task
        return llm_result

    # ------------------------------------------------------------------
    # Streaming variants — yield tokens as they arrive from the API
    # ------------------------------------------------------------------

    def _build_vlm_messages(self, user_text: str, frame_b64: str) -> list[dict]:
        return [
            {"role": "system", "content": VLM_CHAT_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{frame_b64}"
                        },
                    },
                ],
            },
        ]

    def _build_llm_messages(self, user_text: str, history: list[dict]) -> list[dict]:
        messages = [{"role": "system", "content": self._llm_prompt}]
        messages.extend(history)
        messages.append({"role": "user", "content": user_text})
        return messages

    async def _stream_llm(
        self, user_text: str, history: list[dict]
    ) -> AsyncIterator[str]:
        """Yield LLM tokens as they stream from the API."""
        try:
            messages = self._build_llm_messages(user_text, history)
            stream = await self._client.chat.completions.create(
                model=self._llm_endpoint,
                messages=messages,
                stream=True,
            )
            token_count = 0
            t0 = time.monotonic()
            finish_reason = None
            async for chunk in stream:
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta.content or ""
                if choice.finish_reason:
                    finish_reason = choice.finish_reason
                if delta:
                    token_count += 1
                    yield delta
            elapsed = time.monotonic() - t0
            logger.info(
                "LLM stream done: tokens=%d, finish_reason=%s, elapsed=%.2fs",
                token_count, finish_reason, elapsed,
            )
            if finish_reason and finish_reason != "stop":
                logger.warning(
                    "LLM non-normal finish: reason=%s (response may be truncated)",
                    finish_reason,
                )
        except Exception:
            logger.exception("LLM streaming failed")
            yield "抱歉，我暂时无法回答这个问题。"

    async def dual_race_stream(
        self,
        user_text: str,
        frame_b64: str | None,
        history: list[dict],
    ) -> AsyncIterator[str]:
        """Stream tokens from VLM or LLM with race logic.

        Strategy:
        1. If no frame or VLM blocked → stream LLM directly.
        2. Otherwise start VLM streaming, buffer first 3 chars to check
           for "不知道".  Meanwhile start LLM in background so it's
           already running if VLM cannot answer.
        3. If VLM can answer → yield VLM tokens (cancel LLM).
        4. If VLM says "不知道" → yield LLM tokens.
        """
        if not frame_b64 or self._vlm_is_blocked():
            logger.info("dual_race_stream: no frame / VLM blocked, streaming LLM")
            async for token in self._stream_llm(user_text, history):
                yield token
            return

        # Start LLM in background, buffering tokens into a queue
        llm_queue: asyncio.Queue[str | None] = asyncio.Queue()

        async def _run_llm_bg():
            try:
                async for token in self._stream_llm(user_text, history):
                    await llm_queue.put(token)
            except asyncio.CancelledError:
                pass
            finally:
                await llm_queue.put(None)  # sentinel

        llm_task = asyncio.create_task(_run_llm_bg())

        # Try VLM streaming — check first 3 chars for "不知道"
        use_vlm = False
        vlm_buffer: list[str] = []
        vlm_stream = None
        vlm_token_count = 0
        vlm_t0 = time.monotonic()
        vlm_finish_reason = None

        try:
            vlm_stream = await self._client.chat.completions.create(
                model=self._vlm_endpoint,
                messages=self._build_vlm_messages(user_text, frame_b64),
                stream=True,
            )

            collected = ""
            checked = False
            async for chunk in vlm_stream:
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta.content or ""
                if choice.finish_reason:
                    vlm_finish_reason = choice.finish_reason
                if not delta:
                    continue
                collected += delta
                vlm_buffer.append(delta)
                vlm_token_count += 1

                if not checked and len(collected) >= 3:
                    checked = True
                    if collected.startswith("不知道"):
                        await vlm_stream.close()
                        vlm_stream = None
                        break
                    else:
                        # VLM can answer — cancel LLM, yield buffered + rest
                        use_vlm = True
                        llm_task.cancel()
                        logger.info("dual_race_stream: VLM can answer, streaming VLM")
                        for t in vlm_buffer:
                            yield t
                        vlm_buffer = []
                elif checked:
                    # Already decided to use VLM, yield directly
                    yield delta

            # If stream ended before 3 chars and we never checked
            if not checked and vlm_buffer:
                joined = "".join(vlm_buffer)
                if not joined.startswith("不知道"):
                    use_vlm = True
                    llm_task.cancel()
                    for t in vlm_buffer:
                        yield t

            vlm_elapsed = time.monotonic() - vlm_t0
            logger.info(
                "VLM stream done: tokens=%d, finish_reason=%s, use_vlm=%s, elapsed=%.2fs",
                vlm_token_count, vlm_finish_reason, use_vlm, vlm_elapsed,
            )
            if vlm_finish_reason and vlm_finish_reason != "stop":
                logger.warning(
                    "VLM non-normal finish: reason=%s (response may be truncated)",
                    vlm_finish_reason,
                )

            if use_vlm:
                return

        except ArkRateLimitError:
            self._block_vlm()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("VLM streaming failed in dual_race_stream")

        # Fallback: stream from LLM background queue
        logger.info("dual_race_stream: VLM cannot answer, streaming LLM")
        while True:
            token = await llm_queue.get()
            if token is None:
                break
            yield token

    async def summarize_and_store(
        self, ctx: ConversationContext, frame_b64: str
    ) -> None:
        """Summarize a frame and store the description in conversation history."""
        summary = await self.summarize_frame(frame_b64)
        if summary:
            description = f"{FRAME_DESCRIPTION_PREFIX}{summary}"
            await ctx.append_message("assistant", description)
