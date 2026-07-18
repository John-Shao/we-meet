"""P2-M1 重复日程:物化服务 + RRULE 校验 + 「仅此次」/系列删除语义。"""

from datetime import datetime, timedelta, timezone as dt_timezone
from zoneinfo import ZoneInfo

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from core import factories, models
from core.services.calendar_recurrence import materialize_recurrences

pytestmark = pytest.mark.django_db


def _membership(org, user, **kwargs):
    return models.Membership.objects.create(
        organization=org, user=user, is_primary=True, **kwargs
    )


def _make_parent(org, organizer, *, rrule="FREQ=DAILY", tz="Asia/Shanghai", **extra):
    start = extra.pop(
        "start_at",
        datetime(2026, 7, 20, 2, 0, tzinfo=dt_timezone.utc),  # 上海 10:00
    )
    event = models.CalendarEvent.objects.create(
        organization=org,
        organizer=organizer,
        title="站会",
        start_at=start,
        end_at=start + timedelta(hours=1),
        timezone=ZoneInfo(tz),
        recurrence=rrule,
        reminders=[10],
        **extra,
    )
    models.EventAttendee.objects.create(
        event=event,
        user=organizer,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
        rsvp=models.EventRSVPChoices.ACCEPTED,
    )
    return event


NOW = datetime(2026, 7, 19, 0, 0, tzinfo=dt_timezone.utc)


def test_materialize_daily_creates_children_and_is_idempotent():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    peer = factories.UserFactory()
    _membership(org, peer)
    parent = _make_parent(org, me, rrule="FREQ=DAILY;COUNT=5")
    models.EventAttendee.objects.create(event=parent, user=peer, rsvp="accepted")

    created = materialize_recurrences(now=NOW)
    # COUNT=5 含首场;首场=主事件行本身不重建 → 4 个子场次。
    assert created == 4
    children = list(parent.occurrences.order_by("start_at"))
    assert len(children) == 4
    # 间隔恒 24h,时长/标题/提醒/房间关联复制。
    assert children[0].start_at == parent.start_at + timedelta(days=1)
    assert children[0].end_at - children[0].start_at == timedelta(hours=1)
    assert children[0].title == parent.title
    assert children[0].reminders == [10]
    assert children[0].recurrence == ""
    # attendee 复制:组织者保持 accepted,受邀人重置为 needs_action。
    child_att = {
        a.user_id: a.rsvp for a in children[0].attendees.all()
    }
    assert child_att[me.id] == models.EventRSVPChoices.ACCEPTED
    assert child_att[peer.id] == models.EventRSVPChoices.NEEDS_ACTION

    # 幂等:再跑一轮零新建。
    assert materialize_recurrences(now=NOW) == 0
    assert parent.occurrences.count() == 4


def test_materialize_weekly_keeps_local_wall_clock():
    """周三 10:00(上海)的周会,展开后每场仍是上海 10:00。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    parent = _make_parent(org, me, rrule="FREQ=WEEKLY;COUNT=3")

    materialize_recurrences(now=NOW)
    sh = ZoneInfo("Asia/Shanghai")
    for child in parent.occurrences.all():
        local = child.start_at.astimezone(sh)
        assert (local.hour, local.minute) == (10, 0)


def test_delete_child_records_exdate_and_never_rematerializes():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    parent = _make_parent(org, me, rrule="FREQ=DAILY;COUNT=4")
    materialize_recurrences(now=NOW)
    victim = parent.occurrences.order_by("start_at").first()

    client = APIClient()
    client.force_login(me)
    resp = client.delete(f"/api/v1.0/calendar-events/{victim.id}/")
    assert resp.status_code == 204, resp.content

    parent.refresh_from_db()
    assert victim.start_at.isoformat() in parent.recurrence_exdates
    # 重物化:被删场次不重建,其余保持。
    assert materialize_recurrences(now=NOW) == 0
    assert parent.occurrences.count() == 2


def test_delete_parent_removes_future_children():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    parent = _make_parent(org, me, rrule="FREQ=DAILY;COUNT=4")
    materialize_recurrences(now=NOW)
    assert parent.occurrences.count() == 3

    client = APIClient()
    client.force_login(me)
    resp = client.delete(f"/api/v1.0/calendar-events/{parent.id}/")
    assert resp.status_code == 204, resp.content
    # 未来子场次一并删除(NOW 之前没有历史场次,故全清)。
    assert models.CalendarEvent.objects.filter(title="站会").count() == 0


def test_create_event_rejects_bad_rrule():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    start = timezone.now() + timedelta(days=1)

    client = APIClient()
    client.force_login(me)
    resp = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "bad",
            "start_at": start.isoformat(),
            "end_at": (start + timedelta(hours=1)).isoformat(),
            "recurrence": "FREQ=NOPE",
        },
        format="json",
    )
    assert resp.status_code == 400
    assert "recurrence" in resp.json()


# ---- P2-M2 三选编辑语义 ----


def test_edit_one_updates_child_and_exdates_original_slot():
    """仅此次:改子行(含改时刻),原槽位记 exdate 永不重建。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    parent = _make_parent(org, me, rrule="FREQ=DAILY;COUNT=4")
    materialize_recurrences(now=NOW)
    child = parent.occurrences.order_by("start_at").first()
    original_start = child.start_at
    moved = original_start + timedelta(hours=3)

    client = APIClient()
    client.force_login(me)
    resp = client.patch(
        f"/api/v1.0/calendar-events/{child.id}/",
        {
            "title": "站会(改期)",
            "start_at": moved.isoformat(),
            "end_at": (moved + timedelta(hours=1)).isoformat(),
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    child.refresh_from_db()
    assert child.title == "站会(改期)"
    assert child.start_at == moved

    parent.refresh_from_db()
    assert original_start.isoformat() in parent.recurrence_exdates
    # 原槽位不再重建;其余子行不受影响。
    assert materialize_recurrences(now=NOW) == 0
    assert parent.occurrences.count() == 3


def test_edit_following_splits_series():
    """此次及以后:老系列截断,新主事件带编辑值接管,COUNT 扣除已流逝场次。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    peer = factories.UserFactory()
    _membership(org, peer)
    parent = _make_parent(org, me, rrule="FREQ=DAILY;COUNT=6")
    models.EventAttendee.objects.create(event=parent, user=peer, rsvp="accepted")
    materialize_recurrences(now=NOW)
    # 场次:7/20(主)…7/25;取第 3 场(7/22)为分界。
    pivot_child = parent.occurrences.order_by("start_at")[1]
    pivot = pivot_child.start_at
    new_start = pivot + timedelta(hours=2)

    client = APIClient()
    client.force_login(me)
    resp = client.patch(
        f"/api/v1.0/calendar-events/{pivot_child.id}/",
        {
            "title": "站会 v2",
            "start_at": new_start.isoformat(),
            "end_at": (new_start + timedelta(hours=1)).isoformat(),
            "edit_scope": "following",
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["id"] != str(parent.id)
    assert body["title"] == "站会 v2"

    parent.refresh_from_db()
    # 老系列:UNTIL 截断、COUNT 移除,旧子行只剩分界点之前的(7/21 一场)。
    assert "UNTIL=" in parent.recurrence and "COUNT=" not in parent.recurrence
    assert parent.occurrences.count() == 1
    assert parent.occurrences.first().start_at < pivot

    new_parent = models.CalendarEvent.objects.get(id=body["id"])
    assert new_parent.start_at == new_start
    # 6 场流逝 2 场(7/20,7/21)→ 新系列 COUNT=4。
    assert "COUNT=4" in new_parent.recurrence
    # 新系列即时物化:主行 + 3 子行,间隔 24h 保持平移后的时刻。
    kids = list(new_parent.occurrences.order_by("start_at"))
    assert len(kids) == 3
    assert kids[0].start_at == new_start + timedelta(days=1)
    # 名册复制:组织者 accepted,受邀人重置。
    rsvps = {a.user_id: a.rsvp for a in new_parent.attendees.all()}
    assert rsvps[me.id] == models.EventRSVPChoices.ACCEPTED
    assert rsvps[peer.id] == models.EventRSVPChoices.NEEDS_ACTION


def test_edit_all_shifts_series_and_preserves_rsvp():
    """全部:标量传播 + 时间平移,未来子行重物化且 RSVP 按平移保留。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    peer = factories.UserFactory()
    _membership(org, peer)
    parent = _make_parent(org, me, rrule="FREQ=DAILY;COUNT=4")
    models.EventAttendee.objects.create(event=parent, user=peer, rsvp="accepted")
    materialize_recurrences(now=NOW)
    kids = list(parent.occurrences.order_by("start_at"))
    # peer 在第 2 个子场次点了接受。
    marked = kids[1]
    att = marked.attendees.get(user=peer)
    att.rsvp = models.EventRSVPChoices.ACCEPTED
    att.save(update_fields=["rsvp"])

    # 从第 1 个子场次发起「全部」:整体 +1h,改标题。
    pivot_child = kids[0]
    new_start = pivot_child.start_at + timedelta(hours=1)
    client = APIClient()
    client.force_login(me)
    resp = client.patch(
        f"/api/v1.0/calendar-events/{pivot_child.id}/",
        {
            "title": "站会(晚一小时)",
            "start_at": new_start.isoformat(),
            "end_at": (new_start + timedelta(hours=1)).isoformat(),
            "edit_scope": "all",
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["id"] == str(parent.id)

    parent.refresh_from_db()
    assert parent.title == "站会(晚一小时)"
    assert parent.start_at == datetime(
        2026, 7, 20, 3, 0, tzinfo=dt_timezone.utc
    )  # 原 02:00 UTC + 1h
    fresh = list(parent.occurrences.order_by("start_at"))
    assert len(fresh) == 3
    assert all(k.title == "站会(晚一小时)" for k in fresh)
    # 全系列平移 1h:子场次时刻 = 主 + n 天。
    assert fresh[0].start_at == parent.start_at + timedelta(days=1)
    # peer 的 accepted 落在平移后的第 2 个子场次上。
    preserved = fresh[1].attendees.get(user=peer)
    assert preserved.rsvp == models.EventRSVPChoices.ACCEPTED
    # 其它场次仍是待应答。
    assert (
        fresh[0].attendees.get(user=peer).rsvp
        == models.EventRSVPChoices.NEEDS_ACTION
    )


def test_delete_following_truncates_series():
    """此次及以后删除:该场次起全删,老系列 UNTIL 截断,不再重建。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    parent = _make_parent(org, me, rrule="FREQ=DAILY;COUNT=5")
    materialize_recurrences(now=NOW)
    kids = list(parent.occurrences.order_by("start_at"))
    pivot_child = kids[1]

    client = APIClient()
    client.force_login(me)
    resp = client.delete(
        f"/api/v1.0/calendar-events/{pivot_child.id}/?scope=following"
    )
    assert resp.status_code == 204, resp.content

    parent.refresh_from_db()
    assert "UNTIL=" in parent.recurrence and "COUNT=" not in parent.recurrence
    remaining = list(parent.occurrences.order_by("start_at"))
    assert len(remaining) == 1
    assert remaining[0].start_at < pivot_child.start_at
    assert materialize_recurrences(now=NOW) == 0


def test_edit_all_from_parent_propagates_to_whole_series():
    """主事件直接编辑(无 edit_scope)= 全部:标量传播 + 时间平移全系列。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    parent = _make_parent(org, me, rrule="FREQ=DAILY;COUNT=4")
    materialize_recurrences(now=NOW)
    assert parent.occurrences.count() == 3

    new_start = parent.start_at + timedelta(hours=2)
    client = APIClient()
    client.force_login(me)
    resp = client.patch(
        f"/api/v1.0/calendar-events/{parent.id}/",
        {
            "title": "全员站会",
            "start_at": new_start.isoformat(),
            "end_at": (new_start + timedelta(hours=1)).isoformat(),
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["id"] == str(parent.id)

    parent.refresh_from_db()
    assert parent.title == "全员站会"
    assert parent.start_at == new_start
    fresh = list(parent.occurrences.order_by("start_at"))
    assert len(fresh) == 3
    assert all(k.title == "全员站会" for k in fresh)
    # 全系列 +2h:子场次 = 主 + n 天。
    assert fresh[0].start_at == parent.start_at + timedelta(days=1)


def test_edit_following_without_count_preserves_until_rule():
    """无 COUNT 的规则做 following 分裂:新系列原样保留 FREQ/UNTIL,不凭空塞 COUNT。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    parent = _make_parent(org, me, rrule="FREQ=DAILY;UNTIL=20260725T235959")
    materialize_recurrences(now=NOW)
    # 7/20(主)…7/25;取 7/22 为分界。
    pivot_child = parent.occurrences.order_by("start_at")[1]
    new_start = pivot_child.start_at + timedelta(hours=2)

    client = APIClient()
    client.force_login(me)
    resp = client.patch(
        f"/api/v1.0/calendar-events/{pivot_child.id}/",
        {
            "start_at": new_start.isoformat(),
            "end_at": (new_start + timedelta(hours=1)).isoformat(),
            "edit_scope": "following",
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content

    parent.refresh_from_db()
    assert parent.occurrences.first().start_at < pivot_child.start_at

    new_parent = models.CalendarEvent.objects.get(id=resp.json()["id"])
    assert new_parent.start_at == new_start
    # 无 COUNT → 新系列保留原 UNTIL,不出现 COUNT。
    assert "COUNT=" not in new_parent.recurrence
    assert "FREQ=DAILY" in new_parent.recurrence
    assert "UNTIL=20260725T235959" in new_parent.recurrence


def test_edit_one_onto_existing_slot_returns_400():
    """仅此次改时刻撞到另一已物化场次的槽位 → (parent,start_at) 唯一索引 400。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    parent = _make_parent(org, me, rrule="FREQ=DAILY;COUNT=4")
    materialize_recurrences(now=NOW)
    kids = list(parent.occurrences.order_by("start_at"))
    first, second = kids[0], kids[1]

    client = APIClient()
    client.force_login(me)
    resp = client.patch(
        f"/api/v1.0/calendar-events/{first.id}/",
        {
            "title": "撞车",
            "start_at": second.start_at.isoformat(),
            "end_at": (second.start_at + timedelta(hours=1)).isoformat(),
        },
        format="json",
    )
    assert resp.status_code == 400, resp.content
    assert "start_at" in resp.json()
    # 撞车行未落库:原槽位仍是原标题。
    first.refresh_from_db()
    assert first.title == "站会"


# ---- P2-M3 忙闲视图 ----


def test_freebusy_returns_merged_intervals_without_details():
    """busy 区间合并、declined 排除、跨组织丢弃、响应不含标题。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    peer = factories.UserFactory()
    _membership(org, peer)
    outsider = factories.UserFactory()  # 另一组织,应被静默丢弃
    other_org = factories.OrganizationFactory()
    _membership(other_org, outsider)

    day = datetime(2026, 7, 21, 0, 0, tzinfo=dt_timezone.utc)

    def _event(title, s_h, e_h, attendee, rsvp="accepted"):
        ev = models.CalendarEvent.objects.create(
            organization=org,
            organizer=me,
            title=title,
            start_at=day + timedelta(hours=s_h),
            end_at=day + timedelta(hours=e_h),
            timezone=ZoneInfo("Asia/Shanghai"),
        )
        models.EventAttendee.objects.create(event=ev, user=attendee, rsvp=rsvp)
        return ev

    _event("秘密评审", 2, 4, peer)            # 02-04
    _event("重叠会", 3, 5, peer)              # 03-05 → 与上合并为 02-05
    _event("已拒绝", 8, 9, peer, rsvp="declined")  # 不算忙
    _event("我的会", 10, 11, me)

    client = APIClient()
    client.force_login(me)
    resp = client.get(
        "/api/v1.0/calendar-events/freebusy/",
        {
            "attendee_ids": f"{peer.id},{outsider.id},{me.id}",
            "start": day.isoformat(),
            "end": (day + timedelta(days=1)).isoformat(),
        },
    )
    assert resp.status_code == 200, resp.content
    results = {r["user_id"]: r["busy"] for r in resp.json()["results"]}
    # 跨组织的 outsider 不在结果里。
    assert str(outsider.id) not in results
    # peer:02-04 与 03-05 合并;declined 不出现。
    assert results[str(peer.id)] == [
        {
            "start": (day + timedelta(hours=2)).isoformat(),
            "end": (day + timedelta(hours=5)).isoformat(),
        }
    ]
    assert len(results[str(me.id)]) == 1
    # 只出区间——响应文本不含任何标题。
    assert "秘密评审" not in resp.content.decode()


def test_freebusy_rejects_oversized_window():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    day = datetime(2026, 7, 21, 0, 0, tzinfo=dt_timezone.utc)

    client = APIClient()
    client.force_login(me)
    resp = client.get(
        "/api/v1.0/calendar-events/freebusy/",
        {
            "attendee_ids": str(me.id),
            "start": day.isoformat(),
            "end": (day + timedelta(days=40)).isoformat(),
        },
    )
    assert resp.status_code == 400


def test_create_event_accepts_rrule_and_serializes_it():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    start = timezone.now() + timedelta(days=1)

    client = APIClient()
    client.force_login(me)
    resp = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "周会",
            "start_at": start.isoformat(),
            "end_at": (start + timedelta(hours=1)).isoformat(),
            "recurrence": "FREQ=WEEKLY",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["recurrence"] == "FREQ=WEEKLY"
    assert body["recurrence_parent"] is None
