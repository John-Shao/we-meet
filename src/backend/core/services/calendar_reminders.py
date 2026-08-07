"""Calendar event reminders (P2-c).

A periodic job (k8s CronJob → ``manage.py send_due_reminders``) scans events
whose reminder lead time has arrived but that haven't been reminded yet, and
posts a "🔔 即将开始" nudge into an *existing* IM conversation — the source
conversation for chat-created events, else the room's meeting group.

Reminders NEVER create a group: the lazily-created one-shot reminder groups
were the root cause of conversation-list flooding. When no conversation
exists, the in-app reminder entry (消息列表「日程提醒」, both clients) is the
only surface and the event is marked handled.

⚠️ **「已处理」不等于「送达了」。** 三条出口里有两条一条消息都不发(没有会话
可投 / 对方永久拒绝),它们和成功投递设的是同一个 ``reminder_pushed_at``。
所以结果另存 :attr:`CalendarEvent.reminder_outcome` —— 真机上查过一次
「我设了提醒为什么什么都没有」,库里只答得出「已提醒」,那次就是没有会议群。

Idempotent via ``CalendarEvent.reminder_pushed_at``. Transient transport
failures (network / 5xx) leave the flag NULL so the next run retries;
permanent failures (4xx, e.g. the source group was dissolved) mark the event
handled to stop pointless retries inside the 24h scan window.
"""

import logging
from datetime import timedelta

from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from core.models import CalendarEvent, EventStatusChoices, MeetingConversation

logger = logging.getLogger(__name__)

# Largest reminder lead we scan for — bounds the candidate query.
MAX_LEAD_HOURS = 24

#: :attr:`CalendarEvent.reminder_outcome` 的三个值。
OUTCOME_DELIVERED = "delivered"
#: 没有可投的会话 —— 房间从没进过会(会议群是入会那一刻才建的),或者事件
#: 既没有源会话也没有房间。**一条消息都没发**,双端消息列表的「日程提醒」
#: 入口是唯一的面。
OUTCOME_NO_CONVERSATION = "no_conversation"
#: 对方永久拒绝(4xx,典型是源群已解散)。同样一条消息都没到。
OUTCOME_REFUSED = "refused"


def push_due_reminders(now=None) -> int:
    """Handle due reminders.

    Returns the number of events handled (nudge pushed, or intentionally
    skipped because no conversation exists). Transiently-failed events are
    not counted — their ``reminder_pushed_at`` stays NULL and the next run
    retries them.
    """
    now = now or timezone.now()
    cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
    if not cfg or not cfg.get("api_url") or not cfg.get("admin_hmac_secret"):
        logger.info("calendar reminders skipped: JUSI_IM_CONFIGURATION incomplete")
        return 0

    horizon = now + timedelta(hours=MAX_LEAD_HOURS)
    candidates = (
        CalendarEvent.objects.filter(
            status=EventStatusChoices.CONFIRMED,
            reminder_pushed_at__isnull=True,
            start_at__gt=now,  # only upcoming events get a "starting soon" nudge
            start_at__lte=horizon,
        )
        # 有房间**或**有源会话 —— 两者都没有的日程无处可投,不必扫。
        #
        # 原来这里只有 ``room__isnull=False``。后来加了「从聊天创建的日程直发
        # 源会话」那条分支(见 :func:`_push_one`),却没动这个过滤 —— 于是
        # 「有源会话、没订会议室」的日程**永远走不到那条分支**,而模块开头
        # 第一句就写着「the source conversation for chat-created events」。
        .filter(Q(room__isnull=False) | ~Q(source_conversation_id=""))
        .select_related("room")
    )

    handled = 0
    for event in candidates:
        lead = _lead_minutes(event)
        if lead is None:
            continue
        if now < event.start_at - timedelta(minutes=lead):
            continue  # reminder time not reached yet
        if _push_one(event, cfg):
            handled += 1
    return handled


def _lead_minutes(event):
    """Largest reminder lead (minutes) for the event, or None if it has none."""
    leads = []
    for raw in event.reminders or []:
        try:
            leads.append(int(raw))
        except (TypeError, ValueError):
            continue
    return max(leads) if leads else None


def _push_one(event, cfg) -> bool:
    from core.services.jusi_im import (
        JusiImAdminClient,
        JusiImBadResponseError,
        JusiImUnreachableError,
    )

    client = JusiImAdminClient(
        api_url=str(cfg["api_url"]),
        admin_hmac_secret=str(cfg["admin_hmac_secret"]),
        timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
    )

    local_start = timezone.localtime(event.start_at, event.timezone)
    body = f"🔔 「{event.title}」即将开始（{local_start:%H:%M}）"

    # 从聊天创建的日程回源会话。瞬时故障(网络/5xx)→ 不标记,下轮 cron
    # 重试;永久失败(4xx,典型是源群已解散 404)→ 降级尝试已存在的会议群。
    if event.source_conversation_id:
        try:
            client.post_message(cid=event.source_conversation_id, body=body)
        except JusiImUnreachableError as exc:
            logger.warning(
                "reminder push to source conversation failed (transient) for "
                "event %s; will retry: %s",
                event.id,
                exc,
            )
            return False
        except JusiImBadResponseError as exc:
            logger.warning(
                "reminder push to source conversation failed (permanent, e.g. "
                "dissolved) for event %s; trying existing room group: %s",
                event.id,
                exc,
            )
            # 源会话没了,但如果还有房间就再试一次会议群;两者都没有就是
            # refused —— 不能落回 no_conversation,那会把「对方拒绝」记成
            # 「压根没有会话」,而这两件事要采取的动作完全不同。
            if event.room_id is None:
                return _mark_handled(event, None, OUTCOME_REFUSED)
        else:
            return _mark_handled(
                event, event.source_conversation_id, OUTCOME_DELIVERED
            )

    # 只投「已存在」的会议群,绝不为发提醒建群 —— 懒建的一次性提醒群是
    # 会话列表刷屏的根因。无群可投时仅靠双端消息列表「日程提醒」入口兜底,
    # 标记已处理防止 24h 扫描窗口内反复重扫。
    existing = (
        MeetingConversation.objects.filter(room=event.room).first()
        if event.room_id
        else None
    )
    if existing is None:
        logger.info(
            "reminder for event %s has no existing IM conversation; "
            "in-app reminder entry only",
            event.id,
        )
        return _mark_handled(event, None, OUTCOME_NO_CONVERSATION)

    try:
        client.post_message(cid=existing.cid, body=body)
    except JusiImUnreachableError as exc:
        logger.warning(
            "reminder push failed (transient) for event %s; will retry: %s",
            event.id,
            exc,
        )
        return False
    except JusiImBadResponseError as exc:
        logger.warning(
            "reminder push failed (permanent) for event %s; marking handled: %s",
            event.id,
            exc,
        )
        return _mark_handled(event, None, OUTCOME_REFUSED)
    return _mark_handled(event, existing.cid, OUTCOME_DELIVERED)


def _mark_handled(event, cid, outcome: str) -> bool:
    """Set the idempotency flag **and** record what actually happened.

    ``cid=None`` means no message was sent. 这两件事以前共用 ``reminder_pushed_at``
    一个字段,于是「已提醒」既可能是送达了、也可能是放弃了 —— 排查时库里问不出
    区别,只能去翻已经滚掉的日志。
    """
    event.reminder_pushed_at = timezone.now()
    event.reminder_outcome = outcome
    event.save(
        update_fields=["reminder_pushed_at", "reminder_outcome", "updated_at"]
    )
    if cid:
        logger.info("reminder pushed for event %s (cid=%s)", event.id, cid)
    else:
        logger.info(
            "reminder marked handled without push for event %s (%s)",
            event.id,
            outcome,
        )
    return True
