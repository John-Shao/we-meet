"""P8 变更推送:日程 改时间/增删参会人/取消 → 向来源 IM 会话推 event-card。

协议 v1(与 Web `eventCard.ts` / Android `MessageContent.EventCard` 一致):
``{v, kind, event_id, title, start, end, all_day, attendee_count,
organizer_name, old_start?, old_end?, added_count?}``,content_type
固定 ``event-card``,SYSTEM 身份注入。

契约:**best-effort** —— 推送失败只记 warning,绝不影响日程操作本身
(镜像 im.py `_post_system_message`);创建卡由客户端发,这里只发变更/取消。
触发点收敛在 CalendarEventViewSet.perform_update / perform_destroy,经
``transaction.on_commit`` 调用(事务回滚不推、不拖长 DB 事务)。
"""

import json
import logging

from django.conf import settings

from core.services.jusi_im import JusiImAdminClient, JusiImServiceError

logger = logging.getLogger(__name__)

CONTENT_TYPE = "event-card"


def _make_client() -> JusiImAdminClient | None:
    """Settings → admin client;未配置返回 None(推送直接跳过)。"""
    cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
    if not cfg:
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


def build_event_card(
    event,
    kind: str,
    *,
    old_start=None,
    old_end=None,
    added_count: int = 0,
) -> dict:
    """组协议 v1 卡片 dict。perform_destroy 在删除前调用留快照。"""
    card = {
        "v": 1,
        "kind": kind,
        "event_id": str(event.id),
        "title": event.title,
        "start": event.start_at.isoformat(),
        "end": event.end_at.isoformat(),
        "all_day": bool(event.all_day),
        "attendee_count": event.attendees.count(),
        "organizer_name": _organizer_name(event),
    }
    if kind == "time_changed" and old_start is not None and old_end is not None:
        card["old_start"] = old_start.isoformat()
        card["old_end"] = old_end.isoformat()
    if kind == "attendees_changed" and added_count:
        card["added_count"] = added_count
    return card


def push_card(cid: str, card: dict) -> None:
    """Best-effort 注入卡片;jusi 不可达/报错仅 warning。"""
    if not cid:
        return
    client = _make_client()
    if client is None:
        return
    try:
        client.post_message(
            cid=cid, body=json.dumps(card, ensure_ascii=False),
            content_type=CONTENT_TYPE,
        )
    except JusiImServiceError:
        logger.warning(
            "calendar_im_notify: push %s failed for cid=%s event=%s",
            card.get("kind"), cid, card.get("event_id"), exc_info=True,
        )


def notify_event_change(
    event_id,
    kind: str,
    *,
    old_start=None,
    old_end=None,
    added_count: int = 0,
) -> None:
    """on_commit 后重取 event(闭包持旧对象会读到过期值)并推送。

    行已不在 / 无来源会话 → 静默返回。
    """
    from core import models  # 延迟导入防循环

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
            event, kind,
            old_start=old_start, old_end=old_end, added_count=added_count,
        ),
    )
