"""Recurring-event materialization (P2-M1 重复日程, see
docs/features/foundation_p0_p3.md §P2-D1).

主事件行存 RRULE;本任务把未来 ``HORIZON_DAYS`` 天窗口内的发生(occurrence)
物化为子事件行(``recurrence_parent`` 指回主事件,复制 title/attendees/
reminders/room 关联)。收益:提醒扫描、RSVP、详情、IM 推送、前端渲染全部
现有逻辑零改动,天然逐次生效。

展开按事件**创作时区**(``CalendarEvent.timezone``)的墙上钟进行,再换算回
UTC 存储——跨 DST 的地区维持「每周三 10:00」语义(中国无 DST,不受影响)。

幂等三重保障:窗口内 ``(recurrence_parent, start_at)`` 先查后建、DB 条件
唯一索引兜底、``recurrence_exdates``(「仅此次」删除的场次)永不重建。
与 ``push_due_reminders`` 同一 beat 周期执行(send_due_reminders 命令内
先物化后扫提醒,新场次当轮即可被提醒任务看到)。
"""

import logging
from datetime import timedelta, timezone as dt_timezone

from django.db import IntegrityError, transaction
from django.utils import timezone

from dateutil.rrule import rrulestr

from core.models import (
    CalendarEvent,
    EventAttendee,
    EventAttendeeRoleChoices,
    EventRSVPChoices,
    EventStatusChoices,
)

logger = logging.getLogger(__name__)

# 物化窗口与单主事件单轮生成上限(防御病态 RRULE,如 FREQ=MINUTELY)。
HORIZON_DAYS = 60
MAX_PER_PARENT_PER_RUN = 120


def materialize_recurrences(now=None, horizon_days: int = HORIZON_DAYS) -> int:
    """Materialize upcoming occurrences for all recurring parents.

    Returns the number of child rows created. Best-effort per parent — one
    broken RRULE never aborts the batch (logged, skipped).
    """
    now = now or timezone.now()
    horizon = now + timedelta(days=horizon_days)
    parents = (
        CalendarEvent.objects.filter(
            status=EventStatusChoices.CONFIRMED,
            recurrence_parent__isnull=True,
        )
        .exclude(recurrence="")
        .prefetch_related("attendees")
    )

    created_total = 0
    for parent in parents:
        try:
            created_total += _materialize_one(parent, now, horizon)
        except Exception:  # noqa: BLE001 — 单条坏 RRULE 不拖垮整批
            logger.exception(
                "recurrence materialize failed for event %s (rrule=%r)",
                parent.id,
                parent.recurrence,
            )
    return created_total


def _materialize_one(parent, now, horizon) -> int:
    duration = parent.end_at - parent.start_at
    tz = parent.timezone

    # 墙上钟展开:dtstart 用创作时区的 naive 本地时间,发生集也是 naive 本地。
    local_start = parent.start_at.astimezone(tz).replace(tzinfo=None)
    rule = rrulestr(parent.recurrence, dtstart=local_start)
    win_lo = now.astimezone(tz).replace(tzinfo=None)
    win_hi = horizon.astimezone(tz).replace(tzinfo=None)
    occurrences = rule.between(win_lo, win_hi, inc=True)

    exdates = set(parent.recurrence_exdates or [])
    existing = set(
        CalendarEvent.objects.filter(
            recurrence_parent=parent,
            start_at__gte=now - duration,
            start_at__lte=horizon,
        ).values_list("start_at", flat=True)
    )
    attendee_rows = list(parent.attendees.all())

    created = 0
    for occ in occurrences:
        if created >= MAX_PER_PARENT_PER_RUN:
            logger.warning(
                "recurrence cap hit for event %s (>%d per run)",
                parent.id,
                MAX_PER_PARENT_PER_RUN,
            )
            break
        start_at = occ.replace(tzinfo=tz)  # ZoneInfo attach(fold 规则生效)
        if start_at == parent.start_at:
            continue  # 主事件行本身就是首个发生
        if start_at.isoformat() in exdates or _iso_utc(start_at) in exdates:
            continue  # 「仅此次」删除过,永不重建
        if start_at in existing:
            continue
        try:
            with transaction.atomic():
                child = CalendarEvent.objects.create(
                    organization=parent.organization,
                    organizer=parent.organizer,
                    title=parent.title,
                    description=parent.description,
                    start_at=start_at,
                    end_at=start_at + duration,
                    timezone=tz,
                    all_day=parent.all_day,
                    room=parent.room,
                    status=parent.status,
                    visibility=parent.visibility,
                    reminders=list(parent.reminders or []),
                    recurrence="",
                    recurrence_parent=parent,
                )
                EventAttendee.objects.bulk_create(
                    [
                        EventAttendee(
                            event=child,
                            user=a.user,
                            email=a.email,
                            role=a.role,
                            # 组织者恒 accepted;其余每场次重新应答。
                            rsvp=a.rsvp
                            if a.role == EventAttendeeRoleChoices.ORGANIZER
                            else EventRSVPChoices.NEEDS_ACTION,
                        )
                        for a in attendee_rows
                    ]
                )
        except IntegrityError:
            continue  # 并发/重复轮次撞唯一索引 = 已存在,幂等跳过
        created += 1
    return created


def _iso_utc(dt) -> str:
    """Occurrence key as ISO-8601 UTC — the exdate format perform_destroy writes."""
    return dt.astimezone(dt_timezone.utc).isoformat()
