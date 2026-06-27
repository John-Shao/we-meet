"""Meeting summary + action-item extraction (Sprint 2.2.a).

Reads the Transcript rows for a Room, asks Doubao Pro (via the Ark
OpenAI-compatible endpoint) to (a) produce a narrative summary and
(b) extract a JSON-typed list of action items, persists both. Idempotent:
re-running on the same room rewrites the Summary row and replaces its
ActionItem rows in a single transaction.

Vector embeddings are intentionally out of scope here; see
``ai_strategy.md`` §3.2 — pgvector enablement is a separate step.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from core.models import (
    ActionItem,
    MeetingConversation,
    MeetingDoc,
    RoleChoices,
    Room,
    Summary,
    Transcript,
)
from core.services.llm_client import LLMClient, LLMUnavailable

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_SUMMARY_SYSTEM = (
    "你是会议纪要助手。读取下面的会议字幕，输出一份**简洁、结构化**的会议"
    "纪要。要求：\n"
    "1. 用 Markdown，标题用 ## / ###，重点用列表。\n"
    "2. 至少包含三个部分：『会议主题』『主要讨论』『结论 / 共识』。\n"
    "3. 忠实于字幕原文，不要凭空补充信息。\n"
    "4. 字幕语言以中文为主时，纪要输出中文；以英文为主时，输出英文；混合时，"
    "默认中文。"
)

_ACTION_ITEMS_SYSTEM = (
    "你是会议行动项提取助手。从下面的会议字幕中抽取明确的『谁要做什么、"
    "什么时候完成』。输出**严格 JSON**，schema：\n"
    "{\n"
    '  "items": [\n'
    '    {"content": "<要做的事>", "owner": "<负责人>", "due": "<deadline,可空>"}\n'
    "  ]\n"
    "}\n"
    "规则：\n"
    "1. 必须返回合法 JSON，不要任何额外文字 / 解释 / Markdown 代码块。\n"
    "2. 只有当字幕中明确提到某人某事时才提取；不要凭空推断。\n"
    '3. 没有可提取的行动项时返回 ``{"items": []}``。\n'
    "4. owner / due 字段如不明确，用空字符串。"
)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class SummaryGenerationError(RuntimeError):
    """Raised when the summary pipeline fails irrecoverably."""


class MeetingSummaryService:
    """Generate / refresh the Summary + ActionItems for a single Room."""

    # Hard cap: prompt token budget vs Doubao Pro 32K context.
    # ~3 chars/token CN, ~4 chars/token EN — keep transcript bytes ≤ 60k to
    # leave room for system prompt + completion.
    _MAX_TRANSCRIPT_BYTES = 60_000

    def __init__(self, llm: Optional[LLMClient] = None) -> None:
        self._llm = llm

    def _client(self) -> LLMClient:
        if self._llm is None:
            self._llm = LLMClient.from_settings()
        return self._llm

    def generate(self, room: Room) -> Summary:
        """Run the full pipeline. Always returns a Summary row (status may
        be ``failed`` if the LLM call blew up)."""
        try:
            client = self._client()
        except LLMUnavailable as exc:
            logger.warning("Skipping summary for room %s: %s", room.id, exc)
            return self._mark_failed(room, str(exc), model_used="")

        transcripts = list(
            Transcript.objects.filter(room=room).order_by("started_at")
        )
        if not transcripts:
            return self._mark_failed(
                room,
                "No transcripts for this room — nothing to summarise.",
                model_used=client.model,
            )

        formatted = self._format_transcripts(transcripts)

        try:
            summary_text = client.chat(
                system=_SUMMARY_SYSTEM, user=formatted, temperature=0.3
            )
        except Exception as exc:
            logger.exception("LLM summary call failed for room %s", room.id)
            return self._mark_failed(
                room, f"LLM summary call failed: {exc}", model_used=client.model
            )

        try:
            items_raw = client.chat_json(
                system=_ACTION_ITEMS_SYSTEM, user=formatted, temperature=0.2
            )
            items = self._parse_action_items(items_raw)
        except Exception as exc:
            logger.exception("LLM action-items call failed for room %s", room.id)
            items = []  # Soft failure: keep the summary, lose the items.

        summary = self._persist(
            room=room,
            summary_text=summary_text,
            items=items,
            transcripts=transcripts,
            model_used=client.model,
        )
        # P5: if this room has a jusi-light-im group conversation, push the summary
        # there as a system message. Best-effort, fenced from raising — failure here
        # MUST NOT roll back the summary itself.
        try:
            self._push_summary_to_im(room, summary)
        except Exception:  # noqa: BLE001
            logger.exception("P5 summary IM push failed for room %s", room.id)
        # P3: also land the summary as a La Suite Docs document (妙记). Same best-effort
        # fence — a doc / IM-link failure MUST NOT roll back the summary.
        try:
            self._push_summary_to_doc(room, summary)
        except Exception:  # noqa: BLE001
            logger.exception("P3 summary doc push failed for room %s", room.id)
        return summary

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _format_transcripts(self, transcripts: list[Transcript]) -> str:
        """Format transcripts as ``[HH:MM:SS] speaker: text`` lines."""
        lines: list[str] = []
        for t in transcripts:
            speaker = t.speaker_name or t.speaker_identity[:12]
            ts = t.started_at.strftime("%H:%M:%S")
            lines.append(f"[{ts}] {speaker}: {t.text}")
        text = "\n".join(lines)

        if len(text.encode("utf-8")) > self._MAX_TRANSCRIPT_BYTES:
            # Truncate from the front: most-recent context usually carries
            # the actionable decisions.
            text_bytes = text.encode("utf-8")[-self._MAX_TRANSCRIPT_BYTES:]
            text = text_bytes.decode("utf-8", errors="ignore")
            text = "[…前略…]\n" + text
        return text

    def _parse_action_items(self, raw: str) -> list[dict]:
        """Best-effort JSON parse. Strip Markdown fences if present."""
        if not raw:
            return []
        stripped = raw.strip()
        if stripped.startswith("```"):
            stripped = stripped.strip("`").lstrip("json").strip()
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError:
            logger.warning("Action-items JSON parse failed; raw=%r", raw[:200])
            return []
        items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            return []
        cleaned: list[dict] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            content = (item.get("content") or "").strip()
            if not content:
                continue
            cleaned.append(
                {
                    "content": content,
                    "owner": (item.get("owner") or "").strip(),
                    "due": (item.get("due") or "").strip(),
                }
            )
        return cleaned

    def _push_summary_to_im(self, room: Room, summary: Summary) -> None:
        """Post a `📋 会议纪要已生成: <url>` system message into the room's IM group.

        No-ops when:
          - the summary did NOT succeed (status != SUCCESS)
          - the room never had an IM conversation provisioned (no MeetingConversation row)
          - the summary was already pushed once (idempotent — summary_pushed_at != None)
          - JUSI_IM_CONFIGURATION is not configured

        Transport failures DO NOT raise: by design, the summary is the canonical
        artefact; the IM push is a courtesy nudge.
        """
        from core.services.jusi_im import (  # local import to avoid module-load coupling
            JusiImAdminClient,
            JusiImBadResponseError,
            JusiImUnreachableError,
        )

        if summary.status != Summary.Status.SUCCESS:
            return

        mc = MeetingConversation.objects.filter(room=room).first()
        if mc is None or mc.summary_pushed_at is not None:
            return

        cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
        if not cfg or not cfg.get("api_url") or not cfg.get("admin_hmac_secret"):
            logger.info("P5 summary push skipped: JUSI_IM_CONFIGURATION incomplete")
            return

        base = getattr(settings, "EMAIL_APP_BASE_URL", None) or ""
        if base and not base.endswith("/"):
            base += "/"
        link = f"{base}meetings/{room.id}" if base else str(room.id)
        body = f"📋 会议纪要已生成: {link}"

        client = JusiImAdminClient(
            api_url=str(cfg["api_url"]),
            admin_hmac_secret=str(cfg["admin_hmac_secret"]),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
        )
        try:
            client.post_message(cid=mc.cid, body=body)
        except (JusiImUnreachableError, JusiImBadResponseError) as exc:
            # P5 doesn't retry (see open-question #8). Log and move on; the next
            # successful summarisation for this room will retry naturally because
            # summary_pushed_at is still NULL.
            logger.warning(
                "P5 summary push to jusi-light-im failed for room %s: %s", room.id, exc
            )
            return

        mc.summary_pushed_at = timezone.now()
        mc.save(update_fields=["summary_pushed_at", "updated_at"])
        logger.info("P5 summary pushed to IM cid=%s for room %s", mc.cid, room.id)

    def _push_summary_to_doc(self, room: Room, summary: Summary) -> None:
        """Create a La Suite Docs document from the summary (P3 妙记落 Doc).

        No-ops when:
          - the summary did NOT succeed
          - a MeetingDoc already exists for this room (idempotent — row existence)
          - DOCS_CONFIGURATION is incomplete (Docs not wired up yet)
          - the room has no OWNER to attribute the document to

        Best-effort & fenced: a transport failure leaves NO MeetingDoc row, so the
        next successful summarisation retries. After the doc is created we also drop
        a link into the room's IM group (courtesy nudge, never fatal).
        """
        from core.services.docs_client import (  # local import to avoid load coupling
            DocsBadResponseError,
            DocsClient,
            DocsUnreachableError,
        )

        if summary.status != Summary.Status.SUCCESS:
            return
        if MeetingDoc.objects.filter(room=room).exists():
            return

        cfg = getattr(settings, "DOCS_CONFIGURATION", None)
        if not cfg or not cfg.get("api_url") or not cfg.get("server_to_server_token"):
            logger.info("P3 summary doc push skipped: DOCS_CONFIGURATION incomplete")
            return

        owner = (
            room.accesses.filter(role=RoleChoices.OWNER).select_related("user").first()
        )
        if owner is None or owner.user is None:
            logger.info("P3 summary doc push skipped: room %s has no owner", room.id)
            return
        owner_user = owner.user

        title = f"「{room.name}」会议纪要" if getattr(room, "name", "") else "会议纪要"
        client = DocsClient(
            api_url=str(cfg["api_url"]),
            server_to_server_token=str(cfg["server_to_server_token"]),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
        )
        try:
            created = client.create_for_owner(
                sub=str(owner_user.sub or ""),
                email=str(owner_user.email or ""),
                title=title,
                content=summary.content or "",
                subject=title,
            )
        except (DocsUnreachableError, DocsBadResponseError) as exc:
            logger.warning("P3 summary doc create failed for room %s: %s", room.id, exc)
            return

        base = str(cfg["api_url"]).rstrip("/")
        doc_url = f"{base}/docs/{created.id}/"
        MeetingDoc.objects.create(room=room, doc_id=created.id, doc_url=doc_url)
        logger.info("P3 summary doc created doc=%s for room %s", created.id, room.id)

        self._push_doc_link_to_im(room, doc_url)

    def _push_doc_link_to_im(self, room: Room, doc_url: str) -> None:
        """Courtesy: drop the new doc's link into the room's IM group. Never fatal."""
        from core.services.jusi_im import (
            JusiImAdminClient,
            JusiImBadResponseError,
            JusiImUnreachableError,
        )

        mc = MeetingConversation.objects.filter(room=room).first()
        if mc is None:
            return
        cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
        if not cfg or not cfg.get("api_url") or not cfg.get("admin_hmac_secret"):
            return
        client = JusiImAdminClient(
            api_url=str(cfg["api_url"]),
            admin_hmac_secret=str(cfg["admin_hmac_secret"]),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
        )
        try:
            client.post_message(cid=mc.cid, body=f"📄 会议纪要文档已生成: {doc_url}")
        except (JusiImUnreachableError, JusiImBadResponseError) as exc:
            logger.warning("P3 doc link IM push failed for room %s: %s", room.id, exc)

    @transaction.atomic
    def _persist(
        self,
        *,
        room: Room,
        summary_text: str,
        items: list[dict],
        transcripts: list[Transcript],
        model_used: str,
    ) -> Summary:
        summary, _ = Summary.objects.update_or_create(
            room=room,
            defaults={
                "content": summary_text,
                "model_used": model_used,
                "transcripts_count": len(transcripts),
                "status": Summary.Status.SUCCESS,
                "error_message": "",
            },
        )
        ActionItem.objects.filter(room=room).delete()
        for index, item in enumerate(items):
            ActionItem.objects.create(
                room=room,
                summary=summary,
                content=item["content"],
                owner_text=item["owner"],
                due_text=item["due"],
                sort_order=index,
            )
        logger.info(
            "Generated summary for room %s — %d action items, %d transcripts",
            room.id,
            len(items),
            len(transcripts),
        )
        return summary

    @transaction.atomic
    def _mark_failed(
        self, room: Room, message: str, *, model_used: str
    ) -> Summary:
        summary, _ = Summary.objects.update_or_create(
            room=room,
            defaults={
                "status": Summary.Status.FAILED,
                "error_message": message,
                "model_used": model_used,
            },
        )
        return summary
