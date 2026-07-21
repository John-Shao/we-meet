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
    removed_count: int = 0,
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
    if kind == "attendees_changed" and removed_count:
        card["removed_count"] = removed_count
    return card


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
    except JusiImServiceError:
        logger.warning(
            "calendar_im_notify: organizer uid resolve failed for user %s",
            organizer.pk, exc_info=True,
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
                organizer.pk, exc_info=True,
            )
    return uid


def push_card(cid: str, card: dict, *, organizer=None) -> None:
    """Best-effort 注入卡片(sender = 组织者,解析失败退 SYSTEM);
    jusi 不可达/报错仅 warning。"""
    if not cid:
        return
    client = _make_client()
    if client is None:
        return
    try:
        client.post_message(
            cid=cid, body=json.dumps(card, ensure_ascii=False),
            sender_uid=_organizer_sender_uid(client, organizer),
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
    removed_count: int = 0,
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
            old_start=old_start, old_end=old_end,
            added_count=added_count, removed_count=removed_count,
        ),
        organizer=event.organizer,
    )
