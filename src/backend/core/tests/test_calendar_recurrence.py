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
