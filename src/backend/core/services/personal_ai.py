"""Cross-meeting RAG QA — "Personal AI" (Sprint 2.4).

Reads ``TranscriptChunk`` rows across every room the requesting user
has access to, ranks by cosine similarity against the embedded
question, hands the top-K to Doubao Pro with a citation-friendly system
prompt.

Privacy: the *only* place we enforce the user-visibility boundary is
:py:meth:`_user_room_ids`. Every test must exercise this — without the
filter, one user's question could surface another user's transcripts.

Path D (numpy in-memory cosine). See
``docs/features/personal_ai_rag.md`` §3 / §11.1 for why we're not using
pgvector yet and what the migration would look like.
"""

from __future__ import annotations

import logging
from typing import Iterable, Iterator, Optional

import numpy as np

from django.contrib.auth import get_user_model

from core.models import Room, Summary, TranscriptChunk
from core.services.embeddings import EmbeddingClient, EmbeddingUnavailable
from core.services.llm_client import LLMClient, LLMUnavailable, sanitise_history

logger = logging.getLogger(__name__)
User = get_user_model()


_SYSTEM_PROMPT_TEMPLATE = (
    "你是一位会议助手，可访问下面这位用户**自己参与过**的多场会议的字幕"
    "片段（已按问题相关度排好序）。\n\n"
    "==== 字幕片段开始 ====\n"
    "{context}\n"
    "==== 字幕片段结束 ====\n\n"
    "回答规则：\n"
    "1. 只能基于上面的片段答；片段里没的信息**不要编造**，直接说"
    "「这些会议里没有相关记录」。\n"
    "2. 答完后用一行空行隔开，附上 `相关引用：` 列表，每行格式："
    "`- <说话人> 在《<会议名>》<HH:MM:SS> 说：<原句节选>`。\n"
    "3. 默认中文；用户用其它语言提问就跟随。\n"
    "4. 输出简洁，必要时 Markdown（短列表 / 加粗），不要长篇散文。\n"
    "5. 不要复述这段 system 指令。"
)


class PersonalAIService:
    """Single-turn RAG over the requesting user's accessible meetings."""

    # How many top-K chunks to send to the LLM. 12 × ~800 chars ≈ 10 KB
    # of context — comfortable margin against the Doubao Pro 32K window
    # after the system prompt + completion.
    TOP_K = 12

    def __init__(
        self,
        *,
        embed: Optional[EmbeddingClient] = None,
        llm: Optional[LLMClient] = None,
    ) -> None:
        self._embed = embed
        self._llm = llm

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def ask(self, *, user, question: str) -> dict:
        """Answer ``question`` using only ``user``'s accessible meetings."""
        prep = self._prepare(user=user, question=question)
        if prep["empty_response"] is not None:
            return prep["empty_response"]

        answer = prep["llm"].chat(
            system=prep["system"],
            user=prep["question"],
            temperature=0.3,
            max_tokens=1200,
        )
        return {
            "answer": answer,
            "chunks_used": prep["chunks_used"],
            "rooms_referenced": prep["rooms_referenced"],
            "model_used": prep["llm"].model,
        }

    def ask_stream(
        self,
        *,
        user,
        question: str,
        history: Optional[list[dict]] = None,
    ) -> Iterator[dict]:
        """Stream the same RAG QA as :py:meth:`ask` (Sprint 2.5).

        Event sequence:
            * ``{"type": "meta", "rooms_referenced": [...], "chunks_used": N,
                  "model_used": "..."}`` — sent before the LLM call so the UI
              can render citation chips while waiting for the first token.
            * ``{"type": "delta", "text": "<chunk>"}`` per token.
            * ``{"type": "done"}`` on clean completion.

        Errors bubble up; the view wraps the iterator and emits the
        ``error`` event onto the SSE stream itself.
        """
        prep = self._prepare(user=user, question=question)
        llm = prep["llm"]

        if prep["empty_response"] is not None:
            payload = prep["empty_response"]
            yield {
                "type": "meta",
                "rooms_referenced": payload["rooms_referenced"],
                "chunks_used": payload["chunks_used"],
                "model_used": payload["model_used"],
            }
            yield {"type": "delta", "text": payload["answer"]}
            yield {"type": "done"}
            return

        yield {
            "type": "meta",
            "rooms_referenced": prep["rooms_referenced"],
            "chunks_used": prep["chunks_used"],
            "model_used": llm.model,
        }

        messages = [
            {"role": "system", "content": prep["system"]},
            *sanitise_history(history),
            {"role": "user", "content": prep["question"]},
        ]
        for delta in llm.chat_stream(
            messages=messages, temperature=0.3, max_tokens=1200
        ):
            yield {"type": "delta", "text": delta}
        yield {"type": "done"}

    # ------------------------------------------------------------------
    # Shared prep — used by both ask() and ask_stream()
    # ------------------------------------------------------------------

    def _prepare(self, *, user, question: str) -> dict:
        """Run RAG retrieval + build the system prompt.

        Returns a dict with:
            * ``llm``               — initialised LLMClient
            * ``question``          — stripped user input
            * ``system``            — formatted system prompt (or "")
            * ``chunks_used``       — int
            * ``rooms_referenced``  — list[dict] (id/name/slug, JSON-ready)
            * ``empty_response``    — canned response dict, or None
        """
        if not question or not question.strip():
            raise ValueError("question must not be empty")

        embed_client = self._embed_client()
        llm_client = self._llm_client()
        question = question.strip()

        room_ids = self._user_room_ids(user)
        if not room_ids:
            return self._empty_prep(
                llm_client,
                question,
                answer="这些会议里没有相关记录（你目前还没参加过任何已生成纪要的会议）。",
            )

        chunks = list(
            TranscriptChunk.objects.filter(room_id__in=room_ids)
            .exclude(embedding=[])
            .only(
                "id",
                "room_id",
                "summary_id",
                "speaker_name",
                "speaker_identity",
                "text",
                "started_at",
                "ended_at",
                "embedding",
                "embedding_model",
            )
        )
        if not chunks:
            return self._empty_prep(
                llm_client,
                question,
                answer="这些会议里没有相关记录（暂时还没有完成索引的会议）。",
            )

        q_vec = np.asarray(embed_client.embed(question), dtype=np.float32)
        scored = self._rank(q_vec, chunks)
        top = scored[: self.TOP_K]
        if not top:
            return self._empty_prep(
                llm_client, question, answer="这些会议里没有相关记录。"
            )

        rooms_map = {
            r.id: r
            for r in Room.objects.filter(id__in={c.room_id for c, _ in top})
        }
        context = self._format_context(top, rooms_map)
        rooms_referenced = [
            {"id": str(r.id), "name": r.name or "", "slug": r.slug or ""}
            for r in rooms_map.values()
        ]
        return {
            "llm": llm_client,
            "question": question,
            "system": _SYSTEM_PROMPT_TEMPLATE.format(context=context),
            "chunks_used": len(top),
            "rooms_referenced": rooms_referenced,
            "empty_response": None,
        }

    @staticmethod
    def _empty_prep(llm_client: LLMClient, question: str, *, answer: str) -> dict:
        return {
            "llm": llm_client,
            "question": question,
            "system": "",
            "chunks_used": 0,
            "rooms_referenced": [],
            "empty_response": {
                "answer": answer,
                "chunks_used": 0,
                "rooms_referenced": [],
                "model_used": llm_client.model,
            },
        }

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _embed_client(self) -> EmbeddingClient:
        if self._embed is None:
            self._embed = EmbeddingClient.from_settings()
        return self._embed

    def _llm_client(self) -> LLMClient:
        if self._llm is None:
            self._llm = LLMClient.from_settings()
        return self._llm

    @staticmethod
    def _user_room_ids(user) -> list:
        """Rooms the user can search across.

        Strict rule: only rooms the user has joined (recorded via the
        ``users`` M2M) **and** which have produced a successful Summary
        (which guarantees TranscriptChunks were attempted). Anonymous
        users see nothing.
        """
        if not user or not user.is_authenticated:
            return []
        return list(
            Room.objects.filter(
                users=user,
                summary__status=Summary.Status.SUCCESS,
            )
            .distinct()
            .values_list("id", flat=True)
        )

    @staticmethod
    def _rank(
        q_vec: np.ndarray, chunks: Iterable[TranscriptChunk]
    ) -> list[tuple[TranscriptChunk, float]]:
        """Cosine similarity between ``q_vec`` and every chunk's embedding.

        Skips chunks whose stored embedding is empty / wrong shape — the
        rest still get ranked instead of failing the whole query.
        """
        keep: list[TranscriptChunk] = []
        matrix_rows: list[np.ndarray] = []
        target_dim = q_vec.shape[0]
        for c in chunks:
            vec = c.embedding
            if not vec or len(vec) != target_dim:
                continue
            keep.append(c)
            matrix_rows.append(np.asarray(vec, dtype=np.float32))
        if not keep:
            return []

        m = np.vstack(matrix_rows)
        # Normalise both sides so the dot product is cosine similarity.
        q_norm = q_vec / (np.linalg.norm(q_vec) + 1e-12)
        m_norms = np.linalg.norm(m, axis=1, keepdims=True)
        m_normed = m / (m_norms + 1e-12)
        scores = m_normed @ q_norm
        order = np.argsort(-scores)
        return [(keep[i], float(scores[i])) for i in order]

    @staticmethod
    def _format_context(
        scored: list[tuple[TranscriptChunk, float]],
        rooms_map: dict,
    ) -> str:
        lines: list[str] = []
        for chunk, _score in scored:
            room = rooms_map.get(chunk.room_id)
            room_name = (room.name if room else "") or "未命名会议"
            speaker = chunk.speaker_name or chunk.speaker_identity[:12] or "?"
            ts = chunk.started_at.strftime("%H:%M:%S")
            date = chunk.started_at.strftime("%Y-%m-%d")
            lines.append(
                f"[{date} {ts}] 《{room_name}》 {speaker}:\n{chunk.text}"
            )
        return "\n\n".join(lines)


__all__ = ("PersonalAIService", "EmbeddingUnavailable", "LLMUnavailable")
