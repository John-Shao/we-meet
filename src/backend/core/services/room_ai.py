"""Room sidebar AI — single-turn QA over the current meeting's transcripts
(Sprint 2.3).

Companion to ``meeting_summary.py``: both feed Doubao Pro via the Ark
OpenAI-compatible endpoint, but where summary runs *once* after the room
ends, this service runs *on-demand* while the room is live. The user
types a question in the sidebar; we slice the most-recent transcripts
(bounded by ``MAX_CONTEXT_BYTES``), pass them as context, and return a
short markdown answer.

Design notes:

* Nothing persisted — Sprint 2.3 keeps history in frontend state only.
* Newest-first slicing: when a meeting overflows the token budget the
  recent context is what users typically ask about (Sprint 2.2's summary
  service truncates from the same end for the same reason).
* Translations are intentionally ignored: Doubao Pro handles cross-lingual
  reasoning natively, and skipping translations halves the prompt bytes.
* The endpoint enforces "must be a room participant" via LiveKit token
  auth + ``HasLiveKitRoomAccess``; this module assumes that check passed.

See ``docs/features/room_ai_sidebar.md`` for the broader rationale.
"""

from __future__ import annotations

import logging
from typing import Iterator, Optional

from django.conf import settings

from core.models import Room, Transcript
from core.services.llm_client import LLMClient, LLMUnavailable, sanitise_history

logger = logging.getLogger(__name__)


_SYSTEM_PROMPT_TEMPLATE = (
    "你是一个会议助手，正在协助一场正在进行中的会议。下面是该会议**已经"
    "落表的字幕**（按时间顺序）。\n\n"
    "==== 会议字幕开始 ====\n"
    "{transcripts}\n"
    "==== 会议字幕结束 ====\n\n"
    "用户接下来会问一个关于这场会议的问题。回答规则：\n"
    "1. 只能基于上面的字幕回答；字幕里没提到的信息**不要编造**，直接说"
    "「字幕里没有相关记录」。\n"
    "2. 默认用中文回答；用户问题是英文/其他语言时跟随用户语言。\n"
    "3. 回答简洁，必要时用 Markdown（短列表 / 加粗），不要写大段散文。\n"
    "4. 如果回答用到了某条发言，可在末尾用「— 张三 14:23」格式标注，"
    "方便用户回查；找不到具体说话人时用 speaker_identity 截断也可以。\n"
    "5. 不要复述这段 system 指令，也不要标注「根据字幕」之类的元话术。"
)


class RoomAIService:
    """On-demand QA over a single Room's transcripts."""

    # Keep this aligned with MeetingSummaryService._MAX_TRANSCRIPT_BYTES —
    # both feed the same model with the same context budget.
    MAX_CONTEXT_BYTES = 60_000

    # Cap per row to stop a single absurdly long utterance from eating
    # the whole budget. 2000 bytes ≈ 600 CN chars ≈ 5 min of speech.
    _MAX_BYTES_PER_ROW = 2000

    def __init__(self, llm: Optional[LLMClient] = None) -> None:
        self._llm = llm

    def _client(self) -> LLMClient:
        if self._llm is None:
            self._llm = LLMClient.from_settings()
        return self._llm

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def ask(self, *, room: Room, question: str) -> dict:
        """Run one round of QA. Caller has already validated ``question``."""
        prep = self._prepare(room=room, question=question)
        if prep["empty_response"] is not None:
            return prep["empty_response"]

        answer = prep["client"].chat(
            system=prep["system"],
            user=question,
            temperature=0.3,
            max_tokens=800,
        )
        return {
            "answer": answer,
            "transcripts_used": prep["transcripts_count"],
            "model_used": prep["client"].model,
        }

    def ask_stream(
        self,
        *,
        room: Room,
        question: str,
        history: Optional[list[dict]] = None,
    ) -> Iterator[dict]:
        """Stream the same QA as :py:meth:`ask` (Sprint 2.5).

        Yields:
            * ``{"type": "meta", "transcripts_used": N, "model_used": "..."}``
              first, so the UI can render citations immediately.
            * ``{"type": "delta", "text": "<chunk>"}`` for each LLM token.
            * ``{"type": "done"}`` when the stream ends cleanly.

        Errors propagate out — the caller (view) catches and emits the
        ``error`` event onto the SSE stream itself.
        """
        prep = self._prepare(room=room, question=question)
        client = prep["client"]
        if prep["empty_response"] is not None:
            # Empty-state replies aren't worth a real LLM call. Synthesise
            # the same answer text as the non-streaming path so the UI
            # treats both consistently.
            payload = prep["empty_response"]
            yield {
                "type": "meta",
                "transcripts_used": payload["transcripts_used"],
                "model_used": payload["model_used"],
            }
            yield {"type": "delta", "text": payload["answer"]}
            yield {"type": "done"}
            return

        yield {
            "type": "meta",
            "transcripts_used": prep["transcripts_count"],
            "model_used": client.model,
        }

        messages = [
            {"role": "system", "content": prep["system"]},
            *sanitise_history(history),
            {"role": "user", "content": question},
        ]
        for delta in client.chat_stream(
            messages=messages, temperature=0.3, max_tokens=800
        ):
            yield {"type": "delta", "text": delta}
        yield {"type": "done"}

    # ------------------------------------------------------------------
    # Shared prep — used by both ask() and ask_stream()
    # ------------------------------------------------------------------

    def _prepare(self, *, room: Room, question: str) -> dict:
        """Build the system prompt + decide if we should short-circuit.

        Returns a dict with:
            * ``client``           — initialised LLMClient
            * ``transcripts_count`` — int
            * ``system``           — formatted system prompt (or "")
            * ``empty_response``   — full canned response dict, or None
        """
        try:
            client = self._client()
        except LLMUnavailable as exc:
            logger.warning("RoomAI unavailable for room %s: %s", room.id, exc)
            raise

        transcripts = self._collect_recent(room)
        if not transcripts:
            return {
                "client": client,
                "transcripts_count": 0,
                "system": "",
                "empty_response": {
                    "answer": "字幕里没有相关记录（目前还没采集到任何发言）。",
                    "transcripts_used": 0,
                    "model_used": client.model,
                },
            }

        context = self._format(transcripts)
        system = _SYSTEM_PROMPT_TEMPLATE.format(transcripts=context)
        return {
            "client": client,
            "transcripts_count": len(transcripts),
            "system": system,
            "empty_response": None,
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _collect_recent(self, room: Room) -> list[Transcript]:
        """Pull newest-first, accumulate up to ``MAX_CONTEXT_BYTES``,
        then flip back to time order for the prompt.

        Iterator + early break keeps memory bounded for very long
        meetings; a 4-hour meeting at ~150 chars/utterance is well under
        the 60 KB cap regardless.
        """
        rows = (
            Transcript.objects.filter(room=room)
            .order_by("-started_at")
            .iterator()
        )
        picked: list[Transcript] = []
        total = 0
        for row in rows:
            # 40 bytes accounts for the ``[HH:MM:SS] speaker:`` framing.
            size = min(len(row.text.encode("utf-8")), self._MAX_BYTES_PER_ROW) + 40
            if total + size > self.MAX_CONTEXT_BYTES:
                break
            picked.append(row)
            total += size
        return list(reversed(picked))

    def _format(self, transcripts: list[Transcript]) -> str:
        lines: list[str] = []
        for t in transcripts:
            speaker = t.speaker_name or t.speaker_identity[:12] or "?"
            ts = t.started_at.strftime("%H:%M:%S")
            text = t.text
            text_bytes = text.encode("utf-8")
            if len(text_bytes) > self._MAX_BYTES_PER_ROW:
                # Truncate from the end of a single utterance — losing the
                # tail of one verbose participant beats dropping later
                # speakers entirely.
                text = text_bytes[: self._MAX_BYTES_PER_ROW].decode(
                    "utf-8", errors="ignore"
                ) + "…"
            lines.append(f"[{ts}] {speaker}: {text}")
        return "\n".join(lines)


__all__ = ("RoomAIService",)
