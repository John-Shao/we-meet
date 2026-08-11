"""P8 变更推送:日程 改时间/增删参会人/取消 → 向来源 IM 会话推 event-card。

协议 v1(与 Web `eventCard.ts` / Android `MessageContent.EventCard` 一致):
``{v, kind, event_id, title, start, end, all_day, attendee_count,
organizer_name, old_start?, old_end?, added_count?, removed_count?}``,
content_type 固定 ``event-card``。

P8-UX:卡片以**组织者身份**注入(sender_uid = 组织者 IM uid,优先
``User.im_uid`` 缓存,缺则 issue_token 惰性注册并回填)——双端据 sender
渲染成组织者的正常消息气泡;uid 解析失败退 SYSTEM(客户端渲染居中通知,
降级可接受)。

契约:**best-effort** —— 推送失败只记 warning,绝不影响日程操作本身
(镜像 im.py `_post_system_message`);创建卡由客户端发,这里只发变更/取消。
触发点收敛在 CalendarEventViewSet.perform_update / perform_destroy,经
``transaction.on_commit`` 调用(事务回滚不推、不拖长 DB 事务)。
"""

import json
import logging

from django.conf import settings

from core.services import im_bots, im_cards
from core.services.jusi_im import (
    JusiImAdminClient,
    JusiImConversationAccessDeniedError,
    JusiImSenderNotMemberError,
    JusiImServiceError,
    JusiImUnreachableError,
)

logger = logging.getLogger(__name__)

# Re-exported for the existing callers; the definition now lives in im_cards
# alongside the other two card protocols (P10 M1-g).
CONTENT_TYPE = im_cards.EVENT_CARD


class SourceConversationAccessDenied(Exception):
    """The calendar creator cannot bind the requested conversation."""


class SourceConversationVerificationUnavailable(Exception):
    """IM could not provide a trustworthy membership answer."""


def _make_client() -> JusiImAdminClient | None:
    """Settings → admin client;未配置返回 None(推送直接跳过)。"""
    cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
    if not cfg or not cfg.get("api_url") or not cfg.get("admin_hmac_secret"):
        logger.warning("calendar_im_notify: JUSI_IM_CONFIGURATION missing, skip push")
        return None
    return JusiImAdminClient(
        api_url=str(cfg["api_url"]),
        admin_hmac_secret=str(cfg["admin_hmac_secret"]),
        timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
    )


def _organizer_name(event) -> str:
    user = getattr(event, "organizer", None)
    if user is None:
        return ""
    return (
        getattr(user, "full_name", None)
        or getattr(user, "short_name", None)
        or getattr(user, "email", None)
        or ""
    )


def build_event_card(  # noqa: PLR0913 - mirrors the stable card protocol
    event,
    kind: str,
    *,
    old_start=None,
    old_end=None,
    added_count: int = 0,
    removed_count: int = 0,
) -> dict:
    """组协议 v1 卡片 dict。perform_destroy 在删除前调用留快照。

    模型 → 协议的映射留在这里,协议本身归 ``im_cards.build_event_card``(单一
    定义点 + 金标准 fixture 契约测试守着)。
    """
    return im_cards.build_event_card(
        event_id=str(event.id),
        title=event.title,
        start=event.start_at.isoformat(),
        end=event.end_at.isoformat(),
        kind=kind,
        all_day=bool(event.all_day),
        attendee_count=event.attendees.count(),
        organizer_name=_organizer_name(event),
        old_start=old_start.isoformat() if old_start is not None else None,
        old_end=old_end.isoformat() if old_end is not None else None,
        added_count=added_count,
        removed_count=removed_count,
    )


def _organizer_sender_uid(client: JusiImAdminClient, organizer) -> str | None:
    """组织者的 IM uid:优先 ``User.im_uid`` 缓存,缺则 issue_token 惰性注册
    并回填缓存(镜像 im.py `_resolve_uid`/`_cache_im_uid`)。失败返回 None →
    调用方退 SYSTEM 身份(客户端渲染居中通知)。"""
    if organizer is None:
        return None
    cached = getattr(organizer, "im_uid", None)
    if cached:
        return cached
    external_id = str(getattr(organizer, "sub", None) or organizer.pk)
    try:
        resolved = client.issue_token(external_id=external_id, ttl_seconds=60)
    except JusiImUnreachableError:
        # A network/5xx failure is not evidence that the organizer cannot send.
        # Let reminder delivery remain retryable; best-effort event cards catch
        # the same exception at their outer boundary.
        raise
    except JusiImServiceError:
        logger.warning(
            "calendar_im_notify: organizer uid resolve failed for user %s",
            organizer.pk,
            exc_info=True,
        )
        return None
    uid = getattr(resolved, "uid", None)
    if uid:
        try:
            organizer.im_uid = uid
            organizer.save(update_fields=["im_uid"])
        except Exception:  # noqa: BLE001 — 缓存回填失败不致命
            logger.warning(
                "calendar_im_notify: im_uid backfill failed for user %s",
                organizer.pk,
                exc_info=True,
            )
    return uid


def verify_source_membership(user, cid: str) -> None:
    """Prove that ``user`` belongs to ``cid`` before storing the source cid."""
    client = _make_client()
    if client is None:
        raise SourceConversationVerificationUnavailable("IM is not configured")

    external_id = str(getattr(user, "sub", None) or user.pk)
    try:
        resolved = client.issue_token(external_id=external_id, ttl_seconds=60)
        roster = client.get_members(cid, resolved.token)
    except JusiImConversationAccessDeniedError as exc:
        raise SourceConversationAccessDenied(
            "not a member of this conversation"
        ) from exc
    except JusiImServiceError as exc:
        raise SourceConversationVerificationUnavailable(str(exc)) from exc

    # A successful roster response should contain the authenticated user. If
    # jusi violates that contract, fail closed as unavailable instead of making
    # an authorization guess.
    if not any(member.get("uid") == resolved.uid for member in roster):
        raise SourceConversationVerificationUnavailable(
            "IM roster did not contain the authenticated user"
        )

    if getattr(user, "im_uid", None) != resolved.uid:
        try:
            user.im_uid = resolved.uid
            user.save(update_fields=["im_uid"])
        except Exception:  # noqa: BLE001 - cache backfill must not reject creation
            logger.warning(
                "calendar_im_notify: im_uid backfill failed for user %s",
                user.pk,
                exc_info=True,
            )


def post_with_organizer_fallback(
    client: JusiImAdminClient,
    cid: str,
    body: str,
    *,
    organizer=None,
    content_type: str = "text",
) -> str:
    """Post as organizer, assistant after departure, then SYSTEM.

    Only ``sender_not_member`` proves that the organizer left. Other service
    errors propagate so reminder jobs can retry transient failures and mark
    permanently invalid source conversations accurately.
    """
    sender_uid = _organizer_sender_uid(client, organizer)
    if sender_uid:
        try:
            client.post_message(
                cid=cid,
                body=body,
                sender_uid=sender_uid,
                content_type=content_type,
                require_sender_membership=True,
            )
            return "organizer"
        except JusiImSenderNotMemberError:
            logger.info(
                "calendar_im_notify: organizer left cid=%s; using calendar assistant",
                cid,
            )
            posted = im_bots.post_as_builtin(
                im_bots.BOT_CALENDAR_ASSISTANT,
                cid,
                body,
                content_type=content_type,
            )
            if posted is not None:
                return "assistant"
            logger.warning(
                "calendar_im_notify: calendar assistant failed; using SYSTEM cid=%s",
                cid,
            )

    client.post_message(
        cid=cid,
        body=body,
        sender_uid=None,
        content_type=content_type,
    )
    return "system"


def push_card(cid: str, card: dict, *, organizer=None) -> None:
    """Best-effort event-card delivery using the shared sender policy."""
    if not cid:
        return
    client = _make_client()
    if client is None:
        return
    try:
        post_with_organizer_fallback(
            client,
            cid,
            json.dumps(card, ensure_ascii=False),
            organizer=organizer,
            content_type=CONTENT_TYPE,
        )
    except JusiImServiceError:
        logger.warning(
            "calendar_im_notify: push %s failed for cid=%s event=%s",
            card.get("kind"),
            cid,
            card.get("event_id"),
            exc_info=True,
        )


def notify_event_change(  # noqa: PLR0913 - explicit event-card change fields
    event_id,
    kind: str,
    *,
    old_start=None,
    old_end=None,
    added_count: int = 0,
    removed_count: int = 0,
) -> None:
    """on_commit 后重取 event(闭包持旧对象会读到过期值)并推送。

    行已不在 / 无来源会话 → 静默返回。
    """
    from core import models  # noqa: PLC0415 - delayed to avoid model/service cycle

    event = (
        models.CalendarEvent.objects.select_related("organizer")
        .filter(id=event_id)
        .first()
    )
    if event is None or not event.source_conversation_id:
        return
    push_card(
        event.source_conversation_id,
        build_event_card(
            event,
            kind,
            old_start=old_start,
            old_end=old_end,
            added_count=added_count,
            removed_count=removed_count,
        ),
        organizer=event.organizer,
    )
