"""Recurring-event materialization (P2-M1 重复日程, see
docs/features/foundation_p0_p3.md §P2-D1).

主事件行存 RRULE;本任务把未来 ``HORIZON_DAYS`` 天窗口内的发生(occurrence)
物化为子事件行(``recurrence_parent`` 指回主事件,复制 title/attendees/
reminders/room/source_conversation_id 关联)。收益:提醒扫描、RSVP、详情、
IM 推送、前端渲染全部按场次生效。系列重物化会按原槽位/平移后槽位恢复
提醒幂等状态，只有仍在未来的新触发点才重新布置。

展开按事件**创作时区**(``CalendarEvent.timezone``)的墙上钟进行,再换算回
UTC 存储——跨 DST 的地区维持「每周三 10:00」语义(中国无 DST,不受影响)。

幂等三重保障:窗口内 ``(recurrence_parent, start_at)`` 先查后建、DB 条件
唯一索引兜底、``recurrence_exdates``(「仅此次」删除的场次)永不重建。
与 ``push_due_reminders`` 同一 beat 周期执行(send_due_reminders 命令内
先物化后扫提醒,新场次当轮即可被提醒任务看到)。
"""

import logging
import re
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone

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
from core.services import calendar_reminders, calendar_time, meeting_room_booking

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
        except Exception:  # 单条坏 RRULE 不拖垮整批
            logger.exception(
                "recurrence materialize failed for event %s (rrule=%r)",
                parent.id,
                parent.recurrence,
            )
    return created_total


def _materialize_one(parent, now, horizon) -> int:
    duration = parent.end_at - parent.start_at
    all_day_span = (
        parent.end_date - parent.start_date
        if parent.all_day and parent.start_date and parent.end_date
        else None
    )
    tz = calendar_time.parse_zone(parent.timezone)
    # P9 会议室:整个系列订的是主事件那间房。取一次,循环里给每个子场次各建
    # 一条 booking —— 抢不到就落 conflict 行(policy=skip),绝不中断物化:
    # 会议照开,只是那一场没订上会议室。
    parent_booking = meeting_room_booking.active_booking_for(parent)
    series_room = parent_booking.room if parent_booking is not None else None

    # 墙上钟展开:dtstart 用创作时区的 naive 本地时间,发生集也是 naive 本地。
    local_start = parent.start_at.astimezone(tz).replace(tzinfo=None)
    if all_day_span is not None:
        local_start = datetime.combine(parent.start_date, datetime.min.time())
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
        start_date = end_date = None
        end_at = start_at + duration
        if all_day_span is not None:
            start_date = occ.date()
            end_date = start_date + all_day_span
            start_at, end_at = calendar_time.all_day_anchors(start_date, end_date, tz)
        # dateutil RRULE drops DTSTART microseconds. Compare at the protocol's
        # second precision or a parent created with fractional seconds would
        # be materialized again as a duplicate first occurrence.
        if start_at.replace(microsecond=0) == parent.start_at.replace(microsecond=0):
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
                    end_at=end_at,
                    start_date=start_date,
                    end_date=end_date,
                    timezone=tz,
                    all_day=parent.all_day,
                    room=parent.room,
                    status=parent.status,
                    visibility=parent.visibility,
                    reminders=list(parent.reminders or []),
                    recurrence="",
                    recurrence_parent=parent,
                    source_conversation_id=parent.source_conversation_id,
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
                if series_room is not None:
                    meeting_room_booking.book_for_event(
                        child,
                        series_room,
                        policy=meeting_room_booking.SKIP,
                        booked_by=parent.organizer,
                    )
        except IntegrityError:
            continue  # 并发/重复轮次撞唯一索引 = 已存在,幂等跳过
        created += 1
    return created


def _iso_utc(dt) -> str:
    """Occurrence key as ISO-8601 UTC — the exdate format perform_destroy writes."""
    return dt.astimezone(dt_timezone.utc).isoformat()


# ---- P2-M2 三选编辑语义(one 在 viewset 内完成;以下是 following / all / 删除) ----

# 「全部」编辑可传播的标量字段(时间走 delta 平移,attendees/timezone 不在内)。
SCALAR_FIELDS = ("title", "description", "all_day", "visibility")


def materialize_parent(parent, now=None, horizon_days: int = HORIZON_DAYS) -> int:
    """Materialize one parent immediately (编辑后即时补窗口,不等下一轮 beat)。"""
    now = now or timezone.now()
    return _materialize_one(parent, now, now + timedelta(days=horizon_days))


def _rrule_body(rrule_str: str) -> str:
    return rrule_str.replace("RRULE:", "").strip()


def _rrule_without(rrule_str: str, *keys: str) -> str:
    prefixes = tuple(k.upper() + "=" for k in keys)
    parts = [p for p in _rrule_body(rrule_str).split(";") if p]
    return ";".join(p for p in parts if not p.upper().startswith(prefixes))


def truncate_rrule_before(rrule_str: str, cutoff_local_naive) -> str:
    """截断规则:UNTIL = cutoff 前一秒(浮动本地时刻,与全库口径一致)。

    原 COUNT 一并移除——截断后的上界语义由 UNTIL 独立承担。
    """
    base = _rrule_without(rrule_str, "UNTIL", "COUNT")
    until = (cutoff_local_naive - timedelta(seconds=1)).strftime("%Y%m%dT%H%M%S")
    return f"{base};UNTIL={until}"


def _remaining_rrule_for_split(parent, split_start_utc) -> str:
    """新主事件的 RRULE:COUNT 扣除分界点前已流逝的场次;UNTIL 原样保留
    (仍是有效上界)。剩余 ≤1 场时返回空串(新主事件退化为单次)。"""
    rule_str = _rrule_body(parent.recurrence)
    match = re.search(r"COUNT=(\d+)", rule_str, re.IGNORECASE)
    if not match:
        return rule_str
    total = int(match.group(1))
    tz = calendar_time.parse_zone(parent.timezone)
    dtstart_local = parent.start_at.astimezone(tz).replace(tzinfo=None)
    split_local = split_start_utc.astimezone(tz).replace(tzinfo=None)
    rule = rrulestr(rule_str, dtstart=dtstart_local)
    # between 不含 dtstart 本身 → +1 把首场计入「已流逝」。
    elapsed = len(rule.between(dtstart_local, split_local, inc=False)) + 1
    remaining = total - elapsed
    if remaining <= 1:
        return ""
    return f"{_rrule_without(rule_str, 'COUNT')};COUNT={remaining}"


def _copy_attendees(source_event, target_event) -> None:
    """复制参与人名册:组织者保持 accepted,其余重置为待应答(与物化口径一致)。"""
    EventAttendee.objects.bulk_create(
        [
            EventAttendee(
                event=target_event,
                user=a.user,
                email=a.email,
                role=a.role,
                rsvp=a.rsvp
                if a.role == EventAttendeeRoleChoices.ORGANIZER
                else EventRSVPChoices.NEEDS_ACTION,
            )
            for a in source_event.attendees.all()
        ]
    )


def _shift_exdates(exdates, delta) -> list:
    """exdate 时刻整体平移(系列时间变更后仍指向同一「场次」)。坏串原样保留。"""
    shifted = []
    for s in exdates or []:
        try:
            shifted.append((datetime.fromisoformat(s) + delta).isoformat())
        except (ValueError, TypeError):
            shifted.append(s)
    return shifted


def _shift_all_day_exdates(exdates, old_timezone, new_timezone, day_delta) -> list:
    """Move all-day exclusions by civil date, including across DST changes."""
    shifted = []
    for value in exdates or []:
        try:
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=old_timezone)
            old_date = parsed.astimezone(old_timezone).date()
        except (ValueError, TypeError):
            shifted.append(value)
            continue
        new_date = old_date + day_delta
        shifted.append(
            calendar_time.all_day_anchors(
                new_date, new_date + timedelta(days=1), new_timezone
            )[0].isoformat()
        )
    return shifted


def _reminder_state(event):
    """The reminder fields that must survive occurrence re-materialization."""
    return event.reminder_pushed_at, event.reminder_outcome


def _restore_reminder_state(
    event,
    state,
    *,
    schedule_changed: bool,
    now,
) -> None:
    """Restore an occurrence's idempotency state under the P0 re-arm rule."""
    if state is None:
        return
    pushed_at, outcome = state
    if pushed_at is not None and schedule_changed:
        trigger_at = calendar_reminders.reminder_trigger_at(
            event.start_at, event.reminders
        )
        if trigger_at is not None and trigger_at > now:
            pushed_at, outcome = None, ""
    if event.reminder_pushed_at == pushed_at and event.reminder_outcome == outcome:
        return
    event.reminder_pushed_at = pushed_at
    event.reminder_outcome = outcome
    event.save(update_fields=["reminder_pushed_at", "reminder_outcome", "updated_at"])


def split_series(
    child,
    new_values,
    *,
    schedule_changed: bool = False,
    now=None,
) -> CalendarEvent:
    """「此次及以后」:老主事件截断到该场次之前,新主事件从该场次接管后续。

    - 分界点 = 该子场次的**原**时刻;新主事件 start = 编辑后的时刻(整段后续
      系列随 delta 平移),RRULE 的 COUNT 扣除已流逝场次、UNTIL 原样保留。
    - >= 分界点的旧子行删除(该场次由新主事件行本身承载);exdates 按分界点
      分家,迁移侧随 delta 平移。参与人名册复制,RSVP 重置(组织者除外)。
    Returns the new parent.
    """
    now = now or timezone.now()
    parent = child.recurrence_parent
    old_tz = calendar_time.parse_zone(parent.timezone)
    tz = calendar_time.parse_zone(new_values.get("timezone", old_tz))
    pivot = child.start_at
    pivot_local = pivot.astimezone(old_tz).replace(tzinfo=None)

    duration = child.end_at - child.start_at
    new_start = new_values.get("start_at") or pivot
    new_end = new_values.get("end_at") or (new_start + duration)
    delta = new_start - pivot
    new_rrule = _remaining_rrule_for_split(parent, pivot)
    # 会议室随系列迁移到新主事件(读在删除之前,否则拿不到)。
    old_booking = meeting_room_booking.active_booking_for(parent)
    series_room = old_booking.room if old_booking is not None else None
    all_day_edit = bool(parent.all_day and child.start_date)
    day_delta = (
        new_values.get("start_date", child.start_date) - child.start_date
        if all_day_edit
        else None
    )
    reminder_snapshot = {
        occurrence.start_date if all_day_edit else occurrence.start_at: (
            _reminder_state(occurrence)
        )
        for occurrence in parent.occurrences.filter(start_at__gte=pivot)
    }

    with transaction.atomic():
        keep, moved = [], []
        for s in parent.recurrence_exdates or []:
            try:
                # TypeError 兜 naive 串与 aware pivot 的比较(理论不该出现,防御)。
                is_after = datetime.fromisoformat(s) >= pivot
            except (ValueError, TypeError):
                keep.append(s)
                continue
            (moved if is_after else keep).append(s)

        parent.recurrence = truncate_rrule_before(parent.recurrence, pivot_local)
        parent.recurrence_exdates = keep
        parent.save(update_fields=["recurrence", "recurrence_exdates", "updated_at"])

        new_parent = CalendarEvent.objects.create(
            organization=parent.organization,
            organizer=parent.organizer,
            title=new_values.get("title", parent.title),
            description=new_values.get("description", parent.description),
            start_at=new_start,
            end_at=new_end,
            start_date=new_values.get("start_date", child.start_date),
            end_date=new_values.get("end_date", child.end_date),
            timezone=tz,
            all_day=new_values.get("all_day", parent.all_day),
            room=parent.room,
            status=parent.status,
            visibility=new_values.get("visibility", parent.visibility),
            reminders=list(new_values.get("reminders", parent.reminders or [])),
            recurrence=new_rrule,
            recurrence_exdates=(
                _shift_all_day_exdates(moved, old_tz, tz, day_delta)
                if all_day_edit and day_delta is not None
                else _shift_exdates(moved, delta)
            ),
            source_conversation_id=parent.source_conversation_id,
        )
        _copy_attendees(parent, new_parent)
        parent.occurrences.filter(start_at__gte=pivot).delete()
        # P9 会议室:顺序不可颠倒。旧子场次先删(booking 随 CASCADE 释放),
        # 新主事件才抢得到那个槽位——反过来它会撞上自己的旧场次。
        if series_room is not None:
            meeting_room_booking.book_for_event(
                new_parent,
                series_room,
                policy=meeting_room_booking.SKIP,
                booked_by=parent.organizer,
            )
        materialize_parent(new_parent, now=now)
        _restore_reminder_state(
            new_parent,
            reminder_snapshot.get(child.start_date if all_day_edit else pivot),
            schedule_changed=schedule_changed,
            now=now,
        )
        for occurrence in new_parent.occurrences.all():
            snapshot_key = (
                occurrence.start_date - day_delta
                if all_day_edit and occurrence.start_date and day_delta is not None
                else occurrence.start_at - delta
            )
            _restore_reminder_state(
                occurrence,
                reminder_snapshot.get(snapshot_key),
                schedule_changed=schedule_changed,
                now=now,
            )
    return new_parent


def edit_series_all(  # noqa: PLR0912,PLR0915 - timed/all-day share one transaction
    parent,
    pivot_old_start,
    new_values,
    now=None,
    *,
    schedule_changed: bool = False,
) -> CalendarEvent:
    """「全部」:标量字段传播全系列;时间按「该场次新旧时刻之差」平移整个系列。

    - 主事件 dtstart/exdates 随 delta 平移;未来窗口重物化,已 RSVP 状态按
      平移映射(旧时刻 = 新时刻 - delta)保留——冲突以新时间为准(doc 口径)。
    - 历史子行只传播标量,不动时间(已经发生过的场次不回改时刻)。

    已知损失:RSVP 平移映射按墙上钟展开做精确时刻匹配。跨 DST 边界的地区,
    平移后的新场次可能 ≠ 旧场次 + delta(墙上钟发散),该场次 RSVP 会被重置为
    待应答。中国无 DST 不受影响;若日后接入有 DST 的时区需在此加容差匹配。
    """
    now = now or timezone.now()
    new_start = new_values.get("start_at")
    old_timezone = calendar_time.parse_zone(parent.timezone)
    new_timezone = calendar_time.parse_zone(new_values.get("timezone", parent.timezone))
    all_day_edit = bool(
        parent.all_day and parent.start_date and new_values.get("start_date")
    )
    day_delta = timedelta(0)
    if all_day_edit:
        pivot_old_date = pivot_old_start.astimezone(old_timezone).date()
        day_delta = new_values["start_date"] - pivot_old_date
        new_parent_start_date = parent.start_date + day_delta
        new_span = new_values["end_date"] - new_values["start_date"]
        new_parent_end_date = new_parent_start_date + new_span
        parent_start_at, parent_end_at = calendar_time.all_day_anchors(
            new_parent_start_date, new_parent_end_date, new_timezone
        )
        delta = parent_start_at - parent.start_at
    else:
        delta = (new_start - pivot_old_start) if new_start else timedelta(0)
        if new_values.get("end_at"):
            duration = new_values["end_at"] - (new_start or pivot_old_start)
        else:
            duration = parent.end_at - parent.start_at

    with transaction.atomic():
        for field in SCALAR_FIELDS:
            if field in new_values:
                setattr(parent, field, new_values[field])
        if "timezone" in new_values:
            parent.timezone = new_values["timezone"]
        if "reminders" in new_values:
            parent.reminders = list(new_values["reminders"] or [])
        if all_day_edit:
            parent.start_date = new_parent_start_date
            parent.end_date = new_parent_end_date
            parent.start_at = parent_start_at
            parent.end_at = parent_end_at
            parent.recurrence_exdates = _shift_all_day_exdates(
                parent.recurrence_exdates,
                old_timezone,
                new_timezone,
                day_delta,
            )
        else:
            parent.start_at = parent.start_at + delta
            parent.end_at = parent.start_at + duration
            parent.recurrence_exdates = _shift_exdates(parent.recurrence_exdates, delta)
        parent.save()

        future = list(
            parent.occurrences.filter(start_at__gte=now).prefetch_related("attendees")
        )
        snapshot = {
            c.start_date if all_day_edit else c.start_at: {
                a.user_id: a.rsvp for a in c.attendees.all()
            }
            for c in future
        }
        reminder_snapshot = {
            c.start_date if all_day_edit else c.start_at: _reminder_state(c)
            for c in future
        }
        parent.occurrences.filter(start_at__gte=now).delete()
        # P9 会议室:未来子场次的 booking 刚随删除释放,主事件此刻才能安全平移
        # 到新时段;子场次的 booking 由下面的 materialize_parent 重建。
        # policy=skip —— 系列编辑动辄几十场,一场冲突整体拒绝会让用户彻底改不动。
        meeting_room_booking.resync_event_booking(
            parent, policy=meeting_room_booking.SKIP
        )

        past_updates = {f: new_values[f] for f in SCALAR_FIELDS if f in new_values}
        if "reminders" in new_values:
            past_updates["reminders"] = list(new_values["reminders"] or [])
        if past_updates:
            # QuerySet.update 绕过 auto_now,显式刷 updated_at,免得历史子行与
            # 重物化的未来子行(create,updated_at 是新的)时间戳不一致。
            parent.occurrences.update(updated_at=now, **past_updates)

        materialize_parent(parent, now=now)
        if snapshot or reminder_snapshot:
            fresh = list(
                parent.occurrences.filter(start_at__gte=now).prefetch_related(
                    "attendees"
                )
            )
            for child in fresh:
                snapshot_key = (
                    child.start_date - day_delta
                    if all_day_edit and child.start_date
                    else child.start_at - delta
                )
                old_rsvps = snapshot.get(snapshot_key)
                if old_rsvps:
                    for att in child.attendees.all():
                        want = old_rsvps.get(att.user_id)
                        if want and want != att.rsvp:
                            att.rsvp = want
                            att.save(update_fields=["rsvp", "updated_at"])
                _restore_reminder_state(
                    child,
                    reminder_snapshot.get(snapshot_key),
                    schedule_changed=schedule_changed,
                    now=now,
                )
    return parent


def delete_following(child) -> None:
    """「此次及以后」删除:主事件截断到该场次前,>= 该场次的子行与 exdates 清理。"""
    parent = child.recurrence_parent
    pivot = child.start_at
    pivot_local = pivot.astimezone(calendar_time.parse_zone(parent.timezone)).replace(
        tzinfo=None
    )

    def _before_pivot(s: str) -> bool:
        try:
            return datetime.fromisoformat(s) < pivot
        except (ValueError, TypeError):
            return True

    with transaction.atomic():
        parent.recurrence = truncate_rrule_before(parent.recurrence, pivot_local)
        parent.recurrence_exdates = [
            s for s in (parent.recurrence_exdates or []) if _before_pivot(s)
        ]
        parent.save(update_fields=["recurrence", "recurrence_exdates", "updated_at"])
        parent.occurrences.filter(start_at__gte=pivot).delete()
