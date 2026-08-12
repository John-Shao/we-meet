"""日历通知:来源会话卡片 + 日程助手个人通知组成完整生命周期。

协议 v1(与 Web `eventCard.ts` / Android `MessageContent.EventCard` 一致):
``{v, kind, event_id, title, start, end, all_day, attendee_count,
organizer_name, old_start?, old_end?, added_count?, removed_count?,
old_start_date?, old_end_date?, start_date?, end_date?, recurrence_scope?,
responder_name?, rsvp_status?, visibility?}``,
content_type 固定 ``event-card``。

``visibility=private`` 的来源会话卡片只携带时间窗和「私密日程」标记；
标题、组织者和参与人数置空。发给真实参与人的日程助手私聊仍保留完整详情。

P8-UX:先以**组织者身份**严格发送；仅 ``sender_not_member`` 允许日程助手
补位，助手失败再退 SYSTEM。网络/5xx 不冒充退群。双端从可选
``recurrence_scope`` 渲染 one/following/all 范围标签。

契约:**best-effort** —— 推送失败只记 warning,绝不影响日程操作本身。
来源会话的创建卡仍由客户端发；后端通过日程助手私聊发送个人邀请、
变更/移除/取消通知和 RSVP 回复，并继续向来源会话发送变更/取消卡。
触发点收敛在 CalendarEventViewSet 的用户操作路径,经
``transaction.on_commit`` 调用(事务回滚不推、不拖长 DB 事务)。
"""

import json
import logging
import uuid

from django.conf import settings

from core.services import im_bots, im_cards
from core.services.im_provisioning import resolve_uid
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
    old_start_date=None,
    old_end_date=None,
    added_count: int = 0,
    removed_count: int = 0,
    recurrence_scope: str = "",
    display_start=None,
    display_end=None,
    display_start_date=None,
    display_end_date=None,
    responder_name: str = "",
    rsvp_status: str = "",
) -> dict:
    """组协议 v1 卡片 dict。perform_destroy 在删除前调用留快照。

    模型 → 协议的映射留在这里,协议本身归 ``im_cards.build_event_card``(单一
    定义点 + 金标准 fixture 契约测试守着)。
    """
    return im_cards.build_event_card(
        event_id=str(event.id),
        title=event.title,
        start=(display_start or event.start_at).isoformat(),
        end=(display_end or event.end_at).isoformat(),
        kind=kind,
        all_day=bool(event.all_day),
        attendee_count=event.attendees.count(),
        organizer_name=_organizer_name(event),
        old_start=old_start.isoformat() if old_start is not None else None,
        old_end=old_end.isoformat() if old_end is not None else None,
        old_start_date=(
            old_start_date.isoformat() if old_start_date is not None else ""
        ),
        old_end_date=old_end_date.isoformat() if old_end_date is not None else "",
        added_count=added_count,
        removed_count=removed_count,
        recurrence_scope=recurrence_scope,
        responder_name=responder_name,
        rsvp_status=rsvp_status,
        visibility=event.visibility,
        start_date=(display_start_date or event.start_date).isoformat()
        if (display_start_date or event.start_date)
        else "",
        end_date=(display_end_date or event.end_date).isoformat()
        if (display_end_date or event.end_date)
        else "",
    )


def redact_private_source_card(card: dict) -> dict:
    """Hide private details in a conversation that may include outsiders."""
    if card.get("visibility") != "private":
        return card
    return {
        **card,
        "title": "",
        "attendee_count": 0,
        "organizer_name": "",
    }


def private_personal_card(card: dict) -> dict:
    """Keep attendee delivery complete; ``private`` marks redacted wire cards."""
    if card.get("visibility") != "private":
        return card
    return {key: value for key, value in card.items() if key != "visibility"}


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


def push_user_cards(deliveries) -> None:
    """Send personalized cards through one Calendar Assistant direct chat/user.

    ``deliveries`` is an iterable of ``(User, card)`` pairs. One broken recipient
    must not suppress the rest, and no failure may roll back the calendar action.
    The assistant conversation is deterministic, so invitations, replies and
    later changes stay in one thread instead of creating one chat per event.
    """
    try:
        deliveries = list(deliveries)
    except Exception:  # noqa: BLE001 - notification preparation is best-effort
        logger.warning(
            "calendar_im_notify: failed to prepare direct notifications",
            exc_info=True,
        )
        return
    if not deliveries:
        return
    client = _make_client()
    if client is None:
        return

    sender_uid = im_bots.SYSTEM_UID
    try:
        assistant = im_bots.get_builtin(im_bots.BOT_CALENDAR_ASSISTANT)
        if assistant is not None:
            sender_uid = (
                im_bots.resolve_bot_uid(client, assistant) or im_bots.SYSTEM_UID
            )
    except Exception:  # noqa: BLE001 - fall back to SYSTEM for any bot failure
        logger.warning(
            "calendar_im_notify: calendar assistant resolve failed; "
            "using SYSTEM for direct notifications",
            exc_info=True,
        )

    for user, card in deliveries:
        try:
            recipient_uid = resolve_uid(client, user)
            if not recipient_uid or recipient_uid == sender_uid:
                continue
            lo, hi = sorted([sender_uid, recipient_uid])
            cid = str(uuid.uuid5(uuid.NAMESPACE_OID, f"direct:{lo}:{hi}"))
            client.create_direct(
                cid=cid,
                owner_uid=sender_uid,
                peer_uid=recipient_uid,
            )
            client.post_message(
                cid=cid,
                body=json.dumps(card, ensure_ascii=False),
                sender_uid=(None if sender_uid == im_bots.SYSTEM_UID else sender_uid),
                content_type=CONTENT_TYPE,
            )
        except Exception:  # noqa: BLE001 - isolate each best-effort recipient
            logger.warning(
                "calendar_im_notify: direct push %s failed for user=%s event=%s",
                card.get("kind"),
                getattr(user, "pk", None),
                card.get("event_id"),
                exc_info=True,
            )


def notify_event_created(event_id) -> None:
    """Deliver a personal invitation to every non-organizer attendee."""
    from core import models  # noqa: PLC0415 - delayed to avoid model/service cycle

    event = (
        models.CalendarEvent.objects.select_related("organizer")
        .prefetch_related("attendees__user")
        .filter(id=event_id)
        .first()
    )
    if event is None:
        return
    card = private_personal_card(build_event_card(event, im_cards.EVENT_KIND_INVITED))
    push_user_cards(
        (attendance.user, card)
        for attendance in event.attendees.all()
        if attendance.user_id is not None and attendance.user_id != event.organizer_id
    )


def prepare_event_change(  # noqa: PLR0913 - explicit event-card change fields
    event,
    kind: str,
    *,
    old_start=None,
    old_end=None,
    old_start_date=None,
    old_end_date=None,
    added_count: int = 0,
    removed_count: int = 0,
    recurrence_scope: str = "",
    display_start=None,
    display_end=None,
    display_start_date=None,
    display_end_date=None,
    added_user_ids=(),
    removed_user_ids=(),
) -> tuple[str, dict, object, tuple]:
    """Freeze a change card and its recipients before ``on_commit``.

    A later request may delete the event before a captured commit callback is
    executed (tests do this deliberately, and queued callbacks can also lag).
    Building the delivery while the row still exists keeps the notification
    tied to the successful mutation instead of a subsequent database lookup.
    """
    from core import models  # noqa: PLC0415 - delayed to avoid model/service cycle

    # DRF may have prefetched attendees when it resolved the object. Explicit
    # attendee edits happen after that lookup, so discard the stale relation
    # cache before freezing the new count and recipient list.
    prefetch_cache = getattr(event, "_prefetched_objects_cache", None)
    if prefetch_cache is not None:
        prefetch_cache.pop("attendees", None)

    card = build_event_card(
        event,
        kind,
        old_start=old_start,
        old_end=old_end,
        old_start_date=old_start_date,
        old_end_date=old_end_date,
        added_count=added_count,
        removed_count=removed_count,
        recurrence_scope=recurrence_scope,
        display_start=display_start,
        display_end=display_end,
        display_start_date=display_start_date,
        display_end_date=display_end_date,
    )
    personal_card = private_personal_card(card)
    added_user_ids = set(added_user_ids)
    removed_user_ids = set(removed_user_ids)
    deliveries = []
    for attendance in event.attendees.select_related("user"):
        if attendance.user_id is None or attendance.user_id == event.organizer_id:
            continue
        attendee_card = (
            private_personal_card(build_event_card(event, im_cards.EVENT_KIND_INVITED))
            if attendance.user_id in added_user_ids
            else personal_card
        )
        deliveries.append((attendance.user, attendee_card))
    if removed_user_ids:
        removed_card = private_personal_card(
            build_event_card(event, im_cards.EVENT_KIND_REMOVED)
        )
        deliveries.extend(
            (user, removed_card)
            for user in models.User.objects.filter(id__in=removed_user_ids)
            if user.id != event.organizer_id
        )
    return (
        event.source_conversation_id,
        redact_private_source_card(card),
        event.organizer,
        tuple(deliveries),
    )


def deliver_event_change(delivery) -> None:
    """Send a previously frozen source/personal change notification."""
    cid, card, organizer, user_cards = delivery
    if cid:
        push_card(cid, card, organizer=organizer)
    push_user_cards(user_cards)


def notify_event_change(  # noqa: PLR0913 - explicit event-card change fields
    event_id,
    kind: str,
    *,
    old_start=None,
    old_end=None,
    old_start_date=None,
    old_end_date=None,
    added_count: int = 0,
    removed_count: int = 0,
    recurrence_scope: str = "",
    display_start=None,
    display_end=None,
    display_start_date=None,
    display_end_date=None,
    added_user_ids=(),
    removed_user_ids=(),
) -> None:
    """Compatibility entry point: load an existing event and push its change.

    ViewSet mutations use ``prepare_event_change`` before commit so a later
    delete cannot erase a queued notification. A missing row here is ignored.
    """
    from core import models  # noqa: PLC0415 - delayed to avoid model/service cycle

    event = (
        models.CalendarEvent.objects.select_related("organizer")
        .prefetch_related("attendees__user")
        .filter(id=event_id)
        .first()
    )
    if event is None:
        return
    delivery = prepare_event_change(
        event,
        kind,
        old_start=old_start,
        old_end=old_end,
        old_start_date=old_start_date,
        old_end_date=old_end_date,
        added_count=added_count,
        removed_count=removed_count,
        recurrence_scope=recurrence_scope,
        display_start=display_start,
        display_end=display_end,
        display_start_date=display_start_date,
        display_end_date=display_end_date,
        added_user_ids=added_user_ids,
        removed_user_ids=removed_user_ids,
    )
    deliver_event_change(delivery)


def notify_event_cancelled(
    cid: str,
    source_card: dict,
    *,
    organizer,
    attendee_user_ids,
    personal_card: dict | None = None,
) -> None:
    """Deliver one source card plus one personal cancellation per attendee."""
    from core import models  # noqa: PLC0415 - delayed to avoid model/service cycle

    if cid:
        push_card(cid, source_card, organizer=organizer)
    personal_card = personal_card or source_card
    push_user_cards(
        (user, personal_card)
        for user in models.User.objects.filter(id__in=attendee_user_ids)
        if user.id != organizer.id
    )


def notify_event_rsvp(event_id, responder_id, rsvp_status: str) -> None:
    """Tell the organizer when an invitee changes their RSVP."""
    from core import models  # noqa: PLC0415 - delayed to avoid model/service cycle

    event = (
        models.CalendarEvent.objects.select_related("organizer")
        .prefetch_related("attendees")
        .filter(id=event_id)
        .first()
    )
    responder = models.User.objects.filter(id=responder_id).first()
    if event is None or responder is None or event.organizer_id == responder.id:
        return
    responder_name = (
        responder.full_name or responder.short_name or responder.email or ""
    )
    recurrence_scope = (
        "one" if event.recurrence_parent_id else "all" if event.recurrence else ""
    )
    card = private_personal_card(
        build_event_card(
            event,
            im_cards.EVENT_KIND_RSVP_CHANGED,
            responder_name=responder_name,
            rsvp_status=rsvp_status,
            recurrence_scope=recurrence_scope,
        )
    )
    push_user_cards([(event.organizer, card)])
