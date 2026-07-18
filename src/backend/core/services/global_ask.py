"""全局搜索 AI 问答 — GlobalAskService(P1-4 M1,docs/features/global_search_ai_qa.md)。

多源权限内召回(M1:会议字幕/日历/纪要;M2 加 IM)→ 统一编号 citations →
分节 prompt → 单次 LLM 流式作答。设计要点:

* 隐私:每源独立执行自己的可见性边界(§D1/§D5)——字幕沿用
  ``PersonalAIService._user_room_ids``,日历=本人组织∩organizer/attendee,
  纪要=房间成员∩Summary SUCCESS。送 LLM 的只有调用者可见的命中片段。
* 引用契约(§D2):citations 在调 LLM **之前**生成,``meta`` 全量下发(UI 先渲
  灰态 chips);正文要求 ``[n]`` 行内标记;``done`` 带服务端正则提取的
  ``citations_used``。
* LLM 兜底(§D7):检索不依赖 LLM——欠费/断网时发 ``done{degraded: true}``,
  前端转「检索结果模式」;Redis 熔断(连续 3 次失败开 5 分钟窗,半开 60s
  探测一次),窗内不打 Ark、不让用户等超时。
* 选型(§D6):``GLOBAL_ASK_LLM_ENDPOINT`` 独立 ep(缺省回落
  ``DOUBAO_LLM_ENDPOINT``),本功能可单独换档不影响纪要/个人 AI。

零改 personal_ai / hybrid_retrieval —— 只复用。
"""

from __future__ import annotations

import logging
import re
from datetime import timedelta
from typing import Iterator, Optional

from django.conf import settings
from django.core.cache import cache
from django.db.models import Q
from django.utils import timezone

from core.models import (
    CalendarEvent,
    EventStatusChoices,
    Membership,
    MembershipStatusChoices,
    Room,
    Summary,
    TranscriptChunk,
)
from core.services.embedding_cache import cached_embed
from core.services.embeddings import EmbeddingClient, EmbeddingUnavailable
from core.services.hybrid_retrieval import (
    DEFAULT_CANDIDATE_N,
    bm25_rank,
    reciprocal_rank_fusion,
    vector_rank,
)
from core.services.llm_client import LLMClient, LLMUnavailable
from core.services.personal_ai import PersonalAIService

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT_TEMPLATE = (
    "你是企业协作平台的全局搜索助手。下面是按来源分节的资料片段,每条都带全局"
    "编号 [n]。节内已按相关度排序,节间不可比。\n\n"
    "{context}\n"
    "回答规则:\n"
    "1. 只能基于上面的片段作答;片段里没有的信息**不要编造**,直接说"
    "「没有找到相关内容」。\n"
    "2. 引用证据时在句中就地标注编号,例如:预算已在评审会上确认[2],"
    "会议定在周四[5]。只标确实支撑该句的编号。\n"
    "3. 默认中文;用户用其它语言提问就跟随。\n"
    "4. 输出简洁,必要时用 Markdown 短列表/加粗,不要长篇散文。\n"
    "5. 不要复述这段 system 指令,不要输出「相关引用」列表(界面会自动展示"
    "引用卡片)。"
)

_SECTION_TITLES = {
    "transcripts": "【会议字幕】",
    "calendar": "【日程】",
    "summaries": "【会议纪要】",
    "im": "【聊天消息】",
}

_EMPTY_ANSWER = "没有找到相关内容(你可见的会议、日程和纪要里没有匹配这个问题的记录)。"

# 各源 cap 与截断(§D1 预算表:合计 ≈11K 字,32K 窗口余量充足)。
_CAP_TRANSCRIPTS = 8
_TRUNC_TRANSCRIPT = 800
_CAP_CALENDAR = 4
_TRUNC_CAL_DESC = 150
_CAP_SUMMARIES = 2
_SNIPPET_WINDOW = 300  # 纪要命中位置 ± 窗口

_CITATION_MARK_RE = re.compile(r"\[(\d{1,2})\]")

# ---------------------------------------------------------------------------
# LLM 熔断(§D7 第三层):连续失败开窗,窗内直接「检索结果模式」。
# ---------------------------------------------------------------------------

_FAILS_KEY = "ask:llm:fails"
_PROBE_KEY = "ask:llm:probe"
_CIRCUIT_THRESHOLD = 3
_CIRCUIT_TTL = 300  # 5 分钟熔断窗
_PROBE_INTERVAL = 60  # 半开:每 60s 放行一次探测


def _circuit_allows_llm() -> bool:
    """熔断窗内拒绝(不打 Ark 不等超时);半开期每分钟放一只探测请求。"""
    try:
        fails = int(cache.get(_FAILS_KEY) or 0)
        if fails < _CIRCUIT_THRESHOLD:
            return True
        return bool(cache.add(_PROBE_KEY, 1, timeout=_PROBE_INTERVAL))
    except Exception:  # noqa: BLE001 — 缓存故障不该挡功能
        return True


def _record_llm_failure(exc: Exception) -> None:
    label = type(exc).__name__
    text = str(exc)
    # quota/auth 类单独标注,运维一眼定位「欠费」。
    if any(marker in text for marker in ("429", "quota", "Insufficient", "401")):
        label += "(quota/auth)"
    logger.warning("global-ask LLM failed [%s]: %s", label, text[:300])
    try:
        if not cache.add(_FAILS_KEY, 1, timeout=_CIRCUIT_TTL):
            cache.incr(_FAILS_KEY)
    except Exception:  # noqa: BLE001
        pass


def _record_llm_success() -> None:
    try:
        cache.delete(_FAILS_KEY)
        cache.delete(_PROBE_KEY)
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class GlobalAskService:
    """Single-turn multi-source QA over the requesting user's visible data."""

    def __init__(
        self,
        *,
        embed: Optional[EmbeddingClient] = None,
        llm: Optional[LLMClient] = None,
    ) -> None:
        self._embed = embed
        self._llm = llm

    # ---------------------------------------------------------------- public

    def ask(self, *, user, question: str) -> dict:
        prep = self._prepare(user=user, question=question)
        base = {
            "citations": prep["citations"],
            "sources": prep["sources"],
            "model_used": prep["model_used"],
        }
        if prep["canned"]:
            return {**base, "answer": _EMPTY_ANSWER, "citations_used": [], "degraded": False}
        if not prep["llm_allowed"]:
            return {**base, "answer": "", "citations_used": [], "degraded": True}
        try:
            answer = prep["llm"].chat(
                system=prep["system"],
                user=prep["question"],
                temperature=0.2,
                max_tokens=1200,
            )
        except Exception as exc:  # noqa: BLE001 — §D7:检索结果模式,不裸抛
            _record_llm_failure(exc)
            return {**base, "answer": "", "citations_used": [], "degraded": True}
        _record_llm_success()
        return {
            **base,
            "answer": answer,
            "citations_used": self._extract_used(answer, len(prep["citations"])),
            "degraded": False,
        }

    def ask_stream(self, *, user, question: str) -> Iterator[dict]:
        """事件序列(§D2):meta{citations,sources,model_used} → delta×N →
        done{citations_used, degraded}。LLM 失败不抛——降级由 done 承载。"""
        prep = self._prepare(user=user, question=question)
        yield {
            "type": "meta",
            "citations": prep["citations"],
            "sources": prep["sources"],
            "model_used": prep["model_used"],
        }
        if prep["canned"]:
            yield {"type": "delta", "text": _EMPTY_ANSWER}
            yield {"type": "done", "citations_used": [], "degraded": False}
            return
        if not prep["llm_allowed"]:
            yield {"type": "done", "citations_used": [], "degraded": True}
            return

        collected: list[str] = []
        try:
            for delta in prep["llm"].chat_stream(
                messages=[
                    {"role": "system", "content": prep["system"]},
                    {"role": "user", "content": prep["question"]},
                ],
                temperature=0.2,
                max_tokens=1200,
            ):
                collected.append(delta)
                yield {"type": "delta", "text": delta}
        except Exception as exc:  # noqa: BLE001 — 中途失败同样走降级
            _record_llm_failure(exc)
            yield {"type": "done", "citations_used": [], "degraded": True}
            return
        _record_llm_success()
        yield {
            "type": "done",
            "citations_used": self._extract_used(
                "".join(collected), len(prep["citations"])
            ),
            "degraded": False,
        }

    # ------------------------------------------------------------- 共享准备

    def _prepare(self, *, user, question: str) -> dict:
        if not question or not question.strip():
            raise ValueError("question must not be empty")
        question = question.strip()

        keywords = self._keywords(question)
        sources: dict[str, str] = {}
        citations: list[dict] = []
        section_entries: dict[str, list[str]] = {}

        # 源A 会议字幕 —— hybrid 复用;embedding 挂→BM25 单腿(§D1)。
        try:
            entries = self._recall_transcripts(user, question, citations)
            section_entries["transcripts"] = entries
            sources["transcripts"] = "ok" if entries else "empty"
        except Exception:  # noqa: BLE001
            logger.exception("global-ask transcripts source failed")
            sources["transcripts"] = "skipped"

        # 源C 日历。
        try:
            entries = self._recall_calendar(user, keywords, citations)
            section_entries["calendar"] = entries
            sources["calendar"] = "ok" if entries else "empty"
        except Exception:  # noqa: BLE001
            logger.exception("global-ask calendar source failed")
            sources["calendar"] = "skipped"

        # 源D 纪要。
        try:
            entries = self._recall_summaries(user, keywords, citations)
            section_entries["summaries"] = entries
            sources["summaries"] = "ok" if entries else "empty"
        except Exception:  # noqa: BLE001
            logger.exception("global-ask summaries source failed")
            sources["summaries"] = "skipped"

        # 源B IM = M2(设计 §7);占位标注,前端可提前渲染来源图例。
        sources["im"] = "skipped"

        canned = not citations
        llm_allowed = _circuit_allows_llm()
        if not llm_allowed:
            sources["llm"] = "degraded"

        llm_client: Optional[LLMClient] = None
        model_used = ""
        if not canned:
            try:
                llm_client = self._llm_client()
                model_used = llm_client.model
            except LLMUnavailable as exc:
                # 未配置/配置残缺:等价于熔断态——检索结果模式。
                logger.warning("global-ask LLM unavailable: %s", exc)
                llm_allowed = False
                sources["llm"] = "degraded"

        system = ""
        if not canned and llm_allowed and llm_client is not None:
            context_parts: list[str] = []
            for key in ("transcripts", "im", "calendar", "summaries"):
                entries = section_entries.get(key) or []
                if not entries:
                    continue  # 空节整节省略(§D1)
                context_parts.append(
                    _SECTION_TITLES[key] + "\n" + "\n\n".join(entries)
                )
            system = _SYSTEM_PROMPT_TEMPLATE.format(
                context="\n\n".join(context_parts) + "\n"
            )

        return {
            "question": question,
            "citations": citations,
            "sources": sources,
            "canned": canned,
            "llm_allowed": llm_allowed and llm_client is not None,
            "llm": llm_client,
            "system": system,
            "model_used": model_used,
        }

    # ------------------------------------------------------------ 关键词抽取

    _QUOTED_RE = re.compile(r"[\"“「『']([^\"”」』']{2,20})[\"”」』']")
    _ASCII_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-.]+")

    @classmethod
    def _keywords(cls, question: str) -> list[str]:
        """B/C/D 共享的字面检索词:引号短语 > 英数 token > jieba TF-IDF。

        icontains/trgm 需要**字面**出现的词,故否决 LLM 抽词(同义词发散是
        负收益,§D1)。词长≥2,最多 3 个。
        """
        ordered: list[str] = []
        for match in cls._QUOTED_RE.finditer(question):
            ordered.append(match.group(1).strip())
        ordered.extend(
            token for token in cls._ASCII_RE.findall(question) if len(token) >= 2
        )
        try:
            import jieba.analyse  # 惰性:jieba 已因 bm25_rank 在进程内热

            ordered.extend(
                tag
                for tag in jieba.analyse.extract_tags(question, topK=5)
                if len(tag) >= 2
            )
        except Exception:  # noqa: BLE001 — 抽词失败退化为引号/英数
            logger.warning("global-ask jieba extract_tags failed", exc_info=True)
        deduped = list(dict.fromkeys(kw for kw in ordered if kw))
        return deduped[:3]

    # ----------------------------------------------------------------- 源A

    def _recall_transcripts(
        self, user, question: str, citations: list[dict]
    ) -> list[str]:
        room_ids = PersonalAIService._user_room_ids(user)  # noqa: SLF001 — 复用唯一权限边界
        if not room_ids:
            return []
        chunks = list(
            TranscriptChunk.objects.filter(room_id__in=room_ids)
            .exclude(embedding=[])
            .only(
                "id",
                "room_id",
                "speaker_name",
                "speaker_identity",
                "text",
                "started_at",
                "embedding",
            )
        )
        if not chunks:
            return []

        candidate_n = getattr(settings, "RAG_CANDIDATE_N", DEFAULT_CANDIDATE_N)
        vec_ranked = None
        try:
            q_vec = cached_embed(self._embed_client(), question)
            vec_ranked = vector_rank(q_vec, chunks, top_n=candidate_n)
        except Exception:  # noqa: BLE001 — §D1:embedding 挂 → BM25 单腿
            logger.warning(
                "global-ask embedding unavailable — BM25-only leg", exc_info=True
            )
        bm25_ranked = bm25_rank(question, chunks, top_n=candidate_n)
        if vec_ranked is None:
            top = bm25_ranked[:_CAP_TRANSCRIPTS]
        elif not getattr(settings, "RAG_HYBRID_ENABLED", True):
            top = vec_ranked[:_CAP_TRANSCRIPTS]
        else:
            top = reciprocal_rank_fusion(
                vec_ranked, bm25_ranked, top_k=_CAP_TRANSCRIPTS
            )
        if not top:
            return []

        rooms_map = {
            r.id: r
            for r in Room.objects.filter(id__in={c.room_id for c, _ in top})
        }
        entries: list[str] = []
        for chunk, _score in top:
            room = rooms_map.get(chunk.room_id)
            room_name = (room.name if room else "") or "未命名会议"
            speaker = chunk.speaker_name or chunk.speaker_identity[:12] or "?"
            when = chunk.started_at.strftime("%Y-%m-%d %H:%M")
            text = chunk.text[:_TRUNC_TRANSCRIPT]
            n = len(citations) + 1
            citations.append(
                {
                    "n": n,
                    "kind": "meeting",
                    "title": room_name,
                    "snippet": f"{speaker}: {text[:80]}",
                    "room_id": str(chunk.room_id),
                    "date": chunk.started_at.date().isoformat(),
                }
            )
            entries.append(f"[{n}] ({when})《{room_name}》{speaker}: {text}")
        return entries

    # ----------------------------------------------------------------- 源C

    @staticmethod
    def _caller_organization(user):
        """组织归属:复刻 core/api/directory.py:get_caller_organization ——
        services 层不反向 import api 层(防脆弱 import 链,§D1)。"""
        if not user or not user.is_authenticated:
            return None
        membership = (
            Membership.objects.filter(
                user=user, status=MembershipStatusChoices.ACTIVE
            )
            .select_related("organization")
            .order_by("-is_primary", "created_at")
            .first()
        )
        return membership.organization if membership else None

    def _recall_calendar(
        self, user, keywords: list[str], citations: list[dict]
    ) -> list[str]:
        if not keywords:
            return []
        organization = self._caller_organization(user)
        if organization is None:
            return []
        now = timezone.now()
        text_q = Q()
        for kw in keywords:
            text_q |= Q(title__icontains=kw) | Q(description__icontains=kw)
        events = list(
            CalendarEvent.objects.filter(
                text_q,
                organization=organization,
                status=EventStatusChoices.CONFIRMED,
                start_at__gte=now - timedelta(days=180),
                start_at__lte=now + timedelta(days=180),
            )
            .filter(Q(organizer=user) | Q(attendees__user=user))
            .distinct()
            .select_related("organizer")
            .order_by("start_at")[:50]
        )
        if not events:
            return []

        # 重复系列去重:同一 series(主事件+物化子行)只保留距今最近的一场,
        # 防「周会」把 cap 全占满(§D1)。
        by_series: dict = {}
        for event in events:
            series_key = event.recurrence_parent_id or event.id
            current = by_series.get(series_key)
            if current is None or abs(event.start_at - now) < abs(
                current.start_at - now
            ):
                by_series[series_key] = event
        picked = sorted(by_series.values(), key=lambda e: abs(e.start_at - now))[
            :_CAP_CALENDAR
        ]

        entries: list[str] = []
        for event in picked:
            local = timezone.localtime(event.start_at, event.timezone)
            desc = (event.description or "")[:_TRUNC_CAL_DESC]
            organizer = (
                event.organizer.full_name if event.organizer_id else ""
            ) or ""
            n = len(citations) + 1
            citations.append(
                {
                    "n": n,
                    "kind": "calendar",
                    "title": event.title,
                    "snippet": f"{local:%Y-%m-%d %H:%M}"
                    + (f" · {organizer}" if organizer else ""),
                    "date": local.date().isoformat(),
                }
            )
            line = (
                f"[{n}] {local:%Y-%m-%d %H:%M} 日程《{event.title}》"
                + (f",组织者 {organizer}" if organizer else "")
            )
            if desc:
                line += f"。描述:{desc}"
            entries.append(line)
        return entries

    # ----------------------------------------------------------------- 源D

    def _recall_summaries(
        self, user, keywords: list[str], citations: list[dict]
    ) -> list[str]:
        if not keywords:
            return []
        # effective_content 是 Python property,不能 ORM 查——双谓词:编辑稿
        # 命中,或(未编辑时)AI 原文命中;不误中已被编辑稿取代的原文(§D1)。
        text_q = Q()
        for kw in keywords:
            text_q |= Q(edited_content__icontains=kw) | (
                Q(edited_content="") & Q(content__icontains=kw)
            )
        matches = list(
            Summary.objects.filter(
                text_q,
                room__users=user,  # 房间成员边界,与 _user_room_ids 同构(非组织)
                status=Summary.Status.SUCCESS,
            )
            .distinct()
            .select_related("room")
            .order_by("-updated_at")[:_CAP_SUMMARIES]
        )
        entries: list[str] = []
        for summary in matches:
            body = summary.effective_content or ""
            snippet = self._hit_window(body, keywords)
            room_name = (summary.room.name if summary.room_id else "") or "未命名会议"
            n = len(citations) + 1
            citations.append(
                {
                    "n": n,
                    "kind": "meeting",
                    "title": f"{room_name}(纪要)",
                    "snippet": snippet[:80],
                    "room_id": str(summary.room_id),
                    "date": summary.updated_at.date().isoformat(),
                }
            )
            entries.append(f"[{n}] 《{room_name}》会议纪要节选:{snippet}")
        return entries

    @staticmethod
    def _hit_window(body: str, keywords: list[str]) -> str:
        """取第一个命中关键词位置 ± _SNIPPET_WINDOW 的窗口(纪要可能数千字)。"""
        low = body.lower()
        pos = -1
        for kw in keywords:
            pos = low.find(kw.lower())
            if pos >= 0:
                break
        if pos < 0:
            return body[: _SNIPPET_WINDOW * 2]
        start = max(0, pos - _SNIPPET_WINDOW)
        end = min(len(body), pos + _SNIPPET_WINDOW)
        prefix = "…" if start > 0 else ""
        suffix = "…" if end < len(body) else ""
        return prefix + body[start:end] + suffix

    # ------------------------------------------------------------- internals

    @staticmethod
    def _extract_used(answer: str, citation_count: int) -> list[int]:
        used = set()
        for match in _CITATION_MARK_RE.finditer(answer or ""):
            n = int(match.group(1))
            if 1 <= n <= citation_count:
                used.add(n)
        return sorted(used)

    def _embed_client(self) -> EmbeddingClient:
        if self._embed is None:
            self._embed = EmbeddingClient.from_settings()
        return self._embed

    def _llm_client(self) -> LLMClient:
        """§D6:独立 ep(GLOBAL_ASK_LLM_ENDPOINT)优先,缺省回落现网 ep。"""
        if self._llm is None:
            endpoint = getattr(settings, "GLOBAL_ASK_LLM_ENDPOINT", None) or ""
            if endpoint:
                api_key = getattr(settings, "ARK_API_KEY", None) or ""
                if not api_key:
                    raise LLMUnavailable("ARK_API_KEY not configured.")
                base_url = getattr(settings, "ARK_BASE_URL", None) or None
                kwargs = {"api_key": api_key, "model": str(endpoint)}
                if base_url:
                    kwargs["base_url"] = base_url
                self._llm = LLMClient(**kwargs)
            else:
                self._llm = LLMClient.from_settings()
        return self._llm


__all__ = ("GlobalAskService", "EmbeddingUnavailable", "LLMUnavailable")
