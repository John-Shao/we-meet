"""API tests for the calendar / scheduling endpoints (P2)."""

from datetime import timedelta

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db


def _membership(org, user, **kwargs):
    return models.Membership.objects.create(
        organization=org, user=user, is_primary=True, **kwargs
    )


def _times():
    start = timezone.now() + timedelta(days=1)
    return start, start + timedelta(hours=1)


def test_calendar_requires_authentication():
    assert APIClient().get("/api/v1.0/calendar-events/").status_code == 401


def test_create_event_provisions_room_and_attendees():
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Organizer", email="org@acme.com")
    _membership(org, me)
    peer = factories.UserFactory(full_name="Peer", email="peer@acme.com")
    _membership(org, peer)
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    resp = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Sprint planning",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_ids": [str(peer.id)],
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    event = models.CalendarEvent.objects.get(id=resp.json()["id"])

    assert event.organizer == me
    assert event.organization == org
    # Room provisioned with scheduled_at = start.
    assert event.room is not None
    assert event.room.scheduled_at == start
    # Organizer + invitee attendees.
    assert event.attendees.filter(
        user=me,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
        rsvp=models.EventRSVPChoices.ACCEPTED,
    ).exists()
    assert event.attendees.filter(
        user=peer, role=models.EventAttendeeRoleChoices.REQUIRED
    ).exists()
    # Room access: organizer owner + invitee member (so the IM group includes them).
    assert event.room.accesses.filter(user=me, role=models.RoleChoices.OWNER).exists()
    assert event.room.accesses.filter(
        user=peer, role=models.RoleChoices.MEMBER
    ).exists()


def test_create_event_drops_cross_org_attendees():
    """attendee_ids from outside the caller's org are silently dropped — no
    cross-org invite into the event / Room / IM group."""
    org = factories.OrganizationFactory()
    other_org = factories.OrganizationFactory()
    me = factories.UserFactory(email="o@acme.com")
    _membership(org, me)
    peer = factories.UserFactory(email="p@acme.com")
    _membership(org, peer)
    outsider = factories.UserFactory(email="x@other.com")
    _membership(other_org, outsider)  # active, but a different organization
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    resp = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Planning",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_ids": [str(peer.id), str(outsider.id)],
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    event = models.CalendarEvent.objects.get(id=resp.json()["id"])
    assert event.attendees.filter(user=peer).exists()
    assert not event.attendees.filter(user=outsider).exists()
    assert event.room.accesses.filter(
        user=peer, role=models.RoleChoices.MEMBER
    ).exists()
    assert not event.room.accesses.filter(user=outsider).exists()


def test_list_scoped_to_org_and_visibility():
    org = factories.OrganizationFactory()
    organizer = factories.UserFactory(email="o@acme.com")
    _membership(org, organizer)
    invitee = factories.UserFactory(email="i@acme.com")
    _membership(org, invitee)
    outsider = factories.UserFactory(email="x@acme.com")  # same org, not invited
    _membership(org, outsider)
    start, end = _times()

    event = models.CalendarEvent.objects.create(
        organization=org,
        organizer=organizer,
        title="Standup",
        start_at=start,
        end_at=end,
    )
    models.EventAttendee.objects.create(
        event=event,
        user=organizer,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
    )
    models.EventAttendee.objects.create(event=event, user=invitee)

    # Invitee sees it.
    c = APIClient()
    c.force_login(invitee)
    ids = {e["id"] for e in c.get("/api/v1.0/calendar-events/").json()["results"]}
    assert str(event.id) in ids
    # A same-org non-attendee does not.
    c2 = APIClient()
    c2.force_login(outsider)
    ids2 = {e["id"] for e in c2.get("/api/v1.0/calendar-events/").json()["results"]}
    assert str(event.id) not in ids2


def test_structured_attendees_support_roles_and_external_email():
    org = factories.OrganizationFactory()
    organizer = factories.UserFactory(email="o@acme.com")
    required = factories.UserFactory(email="required@acme.com")
    optional = factories.UserFactory(email="optional@acme.com")
    for user in (organizer, required, optional):
        _membership(org, user)
    start, end = _times()
    client = APIClient()
    client.force_login(organizer)

    response = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Partner review",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_entries": [
                {"user_id": str(required.id), "role": "required"},
                {"user_id": str(optional.id), "role": "optional"},
                {"email": " Guest@Example.COM ", "role": "optional"},
            ],
        },
        format="json",
    )

    assert response.status_code == 201, response.content
    event = models.CalendarEvent.objects.get(id=response.json()["id"])
    assert event.attendees.get(user=required).role == "required"
    assert event.attendees.get(user=optional).role == "optional"
    external = event.attendees.get(user__isnull=True)
    assert external.email == "guest@example.com"
    assert external.role == "optional"
    assert external.rsvp == models.EventRSVPChoices.NEEDS_ACTION
    assert event.room.accesses.filter(user=optional).exists()


@pytest.mark.parametrize(
    "entries",
    [
        [{"email": "not-an-email", "role": "required"}],
        [{"role": "required"}],
        [{"user_id": "00000000-0000-0000-0000-000000000001", "email": "x@y.io"}],
        [{"email": "same@example.com"}, {"email": "SAME@example.com"}],
        [{"email": "x@example.com", "role": "organizer"}],
    ],
)
def test_structured_attendees_reject_invalid_entries(entries):
    org = factories.OrganizationFactory()
    organizer = factories.UserFactory()
    _membership(org, organizer)
    start, end = _times()
    client = APIClient()
    client.force_login(organizer)
    response = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Invalid guest",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_entries": entries,
        },
        format="json",
    )
    assert response.status_code == 400, response.content


def test_attendee_entries_and_legacy_ids_are_mutually_exclusive():
    org = factories.OrganizationFactory()
    organizer = factories.UserFactory()
    peer = factories.UserFactory()
    _membership(org, organizer)
    _membership(org, peer)
    start, end = _times()
    client = APIClient()
    client.force_login(organizer)
    response = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Ambiguous guests",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_ids": [str(peer.id)],
            "attendee_entries": [{"user_id": str(peer.id)}],
        },
        format="json",
    )
    assert response.status_code == 400, response.content


def test_rsvp_updates_attendee_and_rejects_bad_status():
    org = factories.OrganizationFactory()
    organizer = factories.UserFactory(email="o@acme.com")
    _membership(org, organizer)
    invitee = factories.UserFactory(email="i@acme.com")
    _membership(org, invitee)
    start, end = _times()
    event = models.CalendarEvent.objects.create(
        organization=org,
        organizer=organizer,
        title="Review",
        start_at=start,
        end_at=end,
    )
    models.EventAttendee.objects.create(
        event=event,
        user=organizer,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
    )
    att = models.EventAttendee.objects.create(event=event, user=invitee)

    client = APIClient()
    client.force_login(invitee)
    ok = client.post(
        f"/api/v1.0/calendar-events/{event.id}/rsvp/",
        {"status": "accepted"},
        format="json",
    )
    assert ok.status_code == 200, ok.content
    att.refresh_from_db()
    assert att.rsvp == models.EventRSVPChoices.ACCEPTED

    bad = client.post(
        f"/api/v1.0/calendar-events/{event.id}/rsvp/",
        {"status": "maybe-later"},
        format="json",
    )
    assert bad.status_code == 400


def test_organizer_cannot_change_own_rsvp():
    org = factories.OrganizationFactory()
    organizer = factories.UserFactory(email="o@acme.com")
    _membership(org, organizer)
    start, end = _times()
    event = models.CalendarEvent.objects.create(
        organization=org,
        organizer=organizer,
        title="Owner stays accepted",
        start_at=start,
        end_at=end,
    )
    attendance = models.EventAttendee.objects.create(
        event=event,
        user=organizer,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
        rsvp=models.EventRSVPChoices.ACCEPTED,
    )
    client = APIClient()
    client.force_login(organizer)

    response = client.post(
        f"/api/v1.0/calendar-events/{event.id}/rsvp/",
        {"status": "declined"},
        format="json",
    )

    assert response.status_code == 403, response.content
    attendance.refresh_from_db()
    assert attendance.rsvp == models.EventRSVPChoices.ACCEPTED


def test_list_filters_by_date_range():
    org = factories.OrganizationFactory()
    me = factories.UserFactory(email="o@acme.com")
    _membership(org, me)
    soon_start = timezone.now() + timedelta(days=1)
    soon = models.CalendarEvent.objects.create(
        organization=org,
        organizer=me,
        title="Soon",
        start_at=soon_start,
        end_at=soon_start + timedelta(hours=1),
    )
    later_start = timezone.now() + timedelta(days=10)
    later = models.CalendarEvent.objects.create(
        organization=org,
        organizer=me,
        title="Later",
        start_at=later_start,
        end_at=later_start + timedelta(hours=1),
    )

    client = APIClient()
    client.force_login(me)
    win_start = timezone.now().isoformat()
    win_end = (timezone.now() + timedelta(days=3)).isoformat()
    # Params as a dict so the ISO "+00:00" offset is URL-encoded — inlined in an
    # f-string the "+" decodes to a space and the window filter is silently skipped.
    ids = {
        e["id"]
        for e in client.get(
            "/api/v1.0/calendar-events/", {"start": win_start, "end": win_end}
        ).json()["results"]
    }
    assert str(soon.id) in ids
    assert str(later.id) not in ids


def test_only_organizer_can_update_and_delete():
    org = factories.OrganizationFactory()
    organizer = factories.UserFactory(email="o@acme.com")
    _membership(org, organizer)
    invitee = factories.UserFactory(email="i@acme.com")
    _membership(org, invitee)
    start, end = _times()
    event = models.CalendarEvent.objects.create(
        organization=org,
        organizer=organizer,
        title="Plan",
        start_at=start,
        end_at=end,
    )
    models.EventAttendee.objects.create(
        event=event,
        user=organizer,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
    )
    models.EventAttendee.objects.create(event=event, user=invitee)

    # An invitee (in the queryset, so not 404) is forbidden from editing/deleting.
    ic = APIClient()
    ic.force_login(invitee)
    assert (
        ic.patch(
            f"/api/v1.0/calendar-events/{event.id}/",
            {"title": "Hacked"},
            format="json",
        ).status_code
        == 403
    )
    assert ic.delete(f"/api/v1.0/calendar-events/{event.id}/").status_code == 403

    # The organizer can.
    oc = APIClient()
    oc.force_login(organizer)
    assert (
        oc.patch(
            f"/api/v1.0/calendar-events/{event.id}/",
            {"title": "Renamed"},
            format="json",
        ).status_code
        == 200
    )
    event.refresh_from_db()
    assert event.title == "Renamed"
    assert oc.delete(f"/api/v1.0/calendar-events/{event.id}/").status_code == 204


def test_reschedule_syncs_linked_room():
    org = factories.OrganizationFactory()
    me = factories.UserFactory(email="o@acme.com")
    _membership(org, me)
    start, end = _times()
    client = APIClient()
    client.force_login(me)
    created = client.post(
        "/api/v1.0/calendar-events/",
        {"title": "Kickoff", "start_at": start.isoformat(), "end_at": end.isoformat()},
        format="json",
    )
    assert created.status_code == 201, created.content
    event = models.CalendarEvent.objects.get(id=created.json()["id"])
    assert event.room is not None

    new_start = start + timedelta(days=2)
    new_end = new_start + timedelta(hours=1)
    resp = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {
            "title": "Kickoff v2",
            "start_at": new_start.isoformat(),
            "end_at": new_end.isoformat(),
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    event.room.refresh_from_db()
    assert event.room.name == "Kickoff v2"
    assert event.room.scheduled_at == new_start


def test_update_adds_attendees_and_room_access():
    """PATCH with attendee_ids adds the invitee + Room access (regression:
    `room` was an undefined name in perform_update → NameError 500)."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(email="o@acme.com")
    _membership(org, me)
    late_invitee = factories.UserFactory(email="late@acme.com")
    _membership(org, late_invitee)
    start, end = _times()
    client = APIClient()
    client.force_login(me)
    created = client.post(
        "/api/v1.0/calendar-events/",
        {"title": "Sync", "start_at": start.isoformat(), "end_at": end.isoformat()},
        format="json",
    )
    assert created.status_code == 201, created.content
    event = models.CalendarEvent.objects.get(id=created.json()["id"])

    resp = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {"attendee_ids": [str(late_invitee.id)]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert event.attendees.filter(
        user=late_invitee, role=models.EventAttendeeRoleChoices.REQUIRED
    ).exists()
    assert event.room.accesses.filter(
        user=late_invitee, role=models.RoleChoices.MEMBER
    ).exists()


def test_update_attendee_ids_full_sync_adds_and_removes():
    """P8 编辑增删参与者:attendee_ids 传列表 = 全量同步 —— 新面孔补进,
    不在列表的既有参与者删行并移出 Room;组织者恒保留。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(email="o@acme.com")
    keep = factories.UserFactory(email="keep@acme.com")
    drop = factories.UserFactory(email="drop@acme.com")
    added = factories.UserFactory(email="added@acme.com")
    for u in (me, keep, drop, added):
        _membership(org, u)
    start, end = _times()
    client = APIClient()
    client.force_login(me)
    created = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Sync",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_ids": [str(keep.id), str(drop.id)],
        },
        format="json",
    )
    assert created.status_code == 201, created.content
    event = models.CalendarEvent.objects.get(id=created.json()["id"])

    resp = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {"attendee_ids": [str(keep.id), str(added.id)]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    attendee_users = set(event.attendees.values_list("user_id", flat=True))
    assert attendee_users == {me.id, keep.id, added.id}
    room_users = set(event.room.accesses.values_list("user_id", flat=True))
    assert drop.id not in room_users
    assert added.id in room_users
    # 组织者的 OWNER 访问不受同步影响。
    assert event.room.accesses.filter(user=me, role=models.RoleChoices.OWNER).exists()


def test_update_attendee_ids_absent_keeps_attendees():
    """PATCH 不带 attendee_ids(标量编辑)→ 参与者原样保留(兼容既有客户端)。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(email="o@acme.com")
    peer = factories.UserFactory(email="p@acme.com")
    _membership(org, me)
    _membership(org, peer)
    start, end = _times()
    client = APIClient()
    client.force_login(me)
    created = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Keep",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_ids": [str(peer.id)],
        },
        format="json",
    )
    assert created.status_code == 201, created.content
    event = models.CalendarEvent.objects.get(id=created.json()["id"])

    resp = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {"title": "Keep v2"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert event.attendees.filter(user=peer).exists()


def test_update_attendee_ids_empty_list_removes_all_but_organizer():
    """attendee_ids=[] = 清空受邀者,只剩组织者(组织者永不可被同步删除)。"""
    org = factories.OrganizationFactory()
    me = factories.UserFactory(email="o@acme.com")
    peer = factories.UserFactory(email="p@acme.com")
    _membership(org, me)
    _membership(org, peer)
    start, end = _times()
    client = APIClient()
    client.force_login(me)
    created = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Solo",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_ids": [str(peer.id)],
        },
        format="json",
    )
    assert created.status_code == 201, created.content
    event = models.CalendarEvent.objects.get(id=created.json()["id"])

    resp = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {"attendee_ids": []},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    attendee_users = set(event.attendees.values_list("user_id", flat=True))
    assert attendee_users == {me.id}
    assert not event.room.accesses.filter(user=peer).exists()


def test_update_attendee_entries_syncs_roles_and_external_emails():
    org = factories.OrganizationFactory()
    organizer = factories.UserFactory(email="o@acme.com")
    peer = factories.UserFactory(email="peer@acme.com")
    _membership(org, organizer)
    _membership(org, peer)
    start, end = _times()
    client = APIClient()
    client.force_login(organizer)
    created = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "External sync",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_entries": [
                {"user_id": str(peer.id), "role": "required"},
                {"email": "old@example.com", "role": "required"},
            ],
        },
        format="json",
    )
    assert created.status_code == 201, created.content
    event = models.CalendarEvent.objects.get(id=created.json()["id"])

    response = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {
            "attendee_entries": [
                {"user_id": str(peer.id), "role": "optional"},
                {"email": "new@example.com", "role": "optional"},
            ]
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    assert event.attendees.get(user=peer).role == "optional"
    assert not event.attendees.filter(email="old@example.com").exists()
    external = event.attendees.get(email="new@example.com")
    assert external.user_id is None
    assert external.role == "optional"


# ---- 分享日程到聊天:详情放宽为「凭 id 只读」,其余权限不放宽 ----


def _event_for_share():
    """组织者 + 一名参与人建好日程,并返回(日程, 组织者, 局外人)。

    局外人 = 同组织但既非组织者也非参与人,模拟「群里收到分享卡片的人」。
    """
    org = factories.OrganizationFactory()
    organizer = factories.UserFactory(full_name="Organizer")
    _membership(org, organizer)
    attendee = factories.UserFactory(full_name="Attendee")
    _membership(org, attendee)
    outsider = factories.UserFactory(full_name="Outsider")
    _membership(org, outsider)
    start, end = _times()

    client = APIClient()
    client.force_login(organizer)
    resp = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "周末派对",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_ids": [str(attendee.id)],
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    return resp.json()["id"], organizer, outsider


def test_outsider_can_retrieve_shared_event():
    """非参与人凭 event_id 可读详情 —— 群里点开分享卡片不再「日程加载失败」。"""
    event_id, _, outsider = _event_for_share()
    client = APIClient()
    client.force_login(outsider)
    resp = client.get(f"/api/v1.0/calendar-events/{event_id}/")
    assert resp.status_code == 200, resp.content
    assert resp.json()["title"] == "周末派对"
    # 非参与人没有表态记录 → 客户端据此收起 RSVP 区。
    assert resp.json()["my_rsvp"] is None


def test_private_event_details_are_redacted_for_outsider_but_not_attendee():
    event_id, _, outsider = _event_for_share()
    event = models.CalendarEvent.objects.get(id=event_id)
    event.visibility = models.EventVisibilityChoices.PRIVATE
    event.description = "secret notes"
    event.save(update_fields=["visibility", "description", "updated_at"])
    attendee = (
        event.attendees.exclude(role=models.EventAttendeeRoleChoices.ORGANIZER)
        .get()
        .user
    )

    outsider_client = APIClient()
    outsider_client.force_login(outsider)
    hidden = outsider_client.get(f"/api/v1.0/calendar-events/{event_id}/")
    assert hidden.status_code == 200, hidden.content
    body = hidden.json()
    assert body["details_redacted"] is True
    assert body["title"] == ""
    assert body["description"] == ""
    assert body["organizer"] is None
    assert body["attendees"] == []
    assert body["room"] is None
    assert body["room_slug"] is None
    assert body["meeting_room"] is None
    assert body["reminders"] == []

    attendee_client = APIClient()
    attendee_client.force_login(attendee)
    visible = attendee_client.get(f"/api/v1.0/calendar-events/{event_id}/")
    assert visible.status_code == 200, visible.content
    assert visible.json()["details_redacted"] is False
    assert visible.json()["title"] == "周末派对"
    assert visible.json()["description"] == "secret notes"
    assert len(visible.json()["attendees"]) == 2


def test_outsider_cannot_rsvp_shared_event():
    """放宽只到「读」为止:非参与人不能替自己表态(rsvp 仍走受限 queryset)。"""
    event_id, _, outsider = _event_for_share()
    client = APIClient()
    client.force_login(outsider)
    resp = client.post(
        f"/api/v1.0/calendar-events/{event_id}/rsvp/",
        {"status": "accepted"},
        format="json",
    )
    assert resp.status_code == 404, resp.content


def test_outsider_cannot_modify_or_delete_shared_event():
    """非参与人不能改/删他人日程。"""
    event_id, _, outsider = _event_for_share()
    client = APIClient()
    client.force_login(outsider)
    assert (
        client.patch(
            f"/api/v1.0/calendar-events/{event_id}/",
            {"title": "hacked"},
            format="json",
        ).status_code
        == 404
    )
    assert client.delete(f"/api/v1.0/calendar-events/{event_id}/").status_code == 404


def test_outsider_does_not_see_shared_event_in_list():
    """列表不放宽:被分享的日程不会混进局外人自己的日历。"""
    event_id, _, outsider = _event_for_share()
    client = APIClient()
    client.force_login(outsider)
    resp = client.get("/api/v1.0/calendar-events/")
    assert resp.status_code == 200, resp.content
    ids = [row["id"] for row in resp.json()["results"]]
    assert event_id not in ids


# --- P9 会议室:通过日程字段预订实体会议室 ---


def _room(org, **kwargs):
    return factories.MeetingRoomFactory(organization=org, **kwargs)


def test_create_event_books_a_meeting_room():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    room = _room(org, name="3F-01", capacity=8)
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    resp = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Design review",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "meeting_room_id": str(room.id),
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["meeting_room"]["name"] == "3F-01"
    assert body["meeting_room"]["booking_status"] == "confirmed"

    booking = models.MeetingRoomBooking.objects.get(room=room)
    assert (booking.start_at, booking.end_at) == (start, end)


def test_creating_over_a_booked_room_returns_409_and_saves_nothing():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    room = _room(org)
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    payload = {
        "title": "First",
        "start_at": start.isoformat(),
        "end_at": end.isoformat(),
        "meeting_room_id": str(room.id),
    }
    assert (
        client.post("/api/v1.0/calendar-events/", payload, format="json").status_code
        == 201
    )

    resp = client.post(
        "/api/v1.0/calendar-events/", {**payload, "title": "Second"}, format="json"
    )
    assert resp.status_code == 409, resp.content
    body = resp.json()
    assert body["code"] == "meeting_room_unavailable"
    assert body["conflicts"][0]["room_id"] == str(room.id)
    # The rejected event must not have been half-created.
    assert not models.CalendarEvent.objects.filter(title="Second").exists()


def test_rescheduling_moves_the_room_booking():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    room = _room(org)
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    event_id = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Standup",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "meeting_room_id": str(room.id),
        },
        format="json",
    ).json()["id"]

    moved_start = start + timedelta(hours=4)
    resp = client.patch(
        f"/api/v1.0/calendar-events/{event_id}/",
        {
            "start_at": moved_start.isoformat(),
            "end_at": (moved_start + timedelta(hours=1)).isoformat(),
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    booking = models.MeetingRoomBooking.objects.get(event_id=event_id)
    assert booking.start_at == moved_start


@pytest.mark.parametrize("clear_value", [None, ""])
def test_clearing_the_room_releases_the_booking(clear_value):
    """Both null and empty string mean "release" — Moshi cannot send null."""
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    room = _room(org)
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    event_id = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Standup",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "meeting_room_id": str(room.id),
        },
        format="json",
    ).json()["id"]

    resp = client.patch(
        f"/api/v1.0/calendar-events/{event_id}/",
        {"meeting_room_id": clear_value},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["meeting_room"] is None
    assert not models.MeetingRoomBooking.objects.filter(event_id=event_id).exists()


def test_omitting_the_field_leaves_the_room_alone():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    room = _room(org)
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    event_id = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Standup",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "meeting_room_id": str(room.id),
        },
        format="json",
    ).json()["id"]

    resp = client.patch(
        f"/api/v1.0/calendar-events/{event_id}/", {"title": "Renamed"}, format="json"
    )
    assert resp.status_code == 200
    assert resp.json()["meeting_room"]["id"] == str(room.id)


def test_deleting_an_event_releases_its_room():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    room = _room(org)
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    event_id = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Standup",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "meeting_room_id": str(room.id),
        },
        format="json",
    ).json()["id"]

    assert client.delete(f"/api/v1.0/calendar-events/{event_id}/").status_code == 204
    assert not models.MeetingRoomBooking.objects.filter(room=room).exists()


def test_all_day_events_cannot_book_a_room():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    room = _room(org)
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    resp = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Offsite",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "all_day": True,
            "meeting_room_id": str(room.id),
        },
        format="json",
    )
    assert resp.status_code == 400
    assert "meeting_room_id" in resp.json()


def test_room_from_another_organization_is_rejected():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    foreign = factories.MeetingRoomFactory()
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    resp = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Sneaky",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "meeting_room_id": str(foreign.id),
        },
        format="json",
    )
    # Explicit 400 rather than the silent drop attendee_ids uses: the user
    # picked this room and must not be told it was booked when it was not.
    assert resp.status_code == 400
    assert "meeting_room_id" in resp.json()


def test_events_without_a_room_report_none():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    resp = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "No room needed",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
        },
        format="json",
    )
    assert resp.status_code == 201
    assert resp.json()["meeting_room"] is None


# --- 视频会议可选(对标飞书「移除视频会议」) ---


def _create(client, **overrides):
    start, end = _times()
    payload = {
        "title": "Sync",
        "start_at": start.isoformat(),
        "end_at": end.isoformat(),
        **overrides,
    }
    return client.post("/api/v1.0/calendar-events/", payload, format="json")


def _organizer_client():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    client = APIClient()
    client.force_login(me)
    return org, me, client


def test_event_can_be_created_without_a_video_meeting():
    _org, _me, client = _organizer_client()

    resp = _create(client, with_video_meeting=False)

    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["room"] is None
    assert body["room_slug"] is None
    event = models.CalendarEvent.objects.get(id=body["id"])
    assert event.room is None


def test_omitting_the_flag_still_provisions_a_room():
    """老客户端不传该字段 —— 行为必须与改动前一字不差。"""
    _org, _me, client = _organizer_client()

    body = _create(client).json()

    assert body["room"] is not None
    assert body["room_slug"]


def test_creating_without_video_still_invites_attendees():
    org, me, client = _organizer_client()
    peer = factories.UserFactory()
    _membership(org, peer)

    body = _create(client, with_video_meeting=False, attendee_ids=[str(peer.id)]).json()

    event = models.CalendarEvent.objects.get(id=body["id"])
    assert event.room is None
    # 没有房间不影响参与者名册 —— 只是没有 ResourceAccess 可发。
    assert event.attendees.filter(user=peer).exists()
    assert event.attendees.filter(user=me).exists()


def test_adding_a_video_meeting_to_an_existing_event():
    org, me, client = _organizer_client()
    peer = factories.UserFactory()
    _membership(org, peer)
    event_id = _create(
        client, with_video_meeting=False, attendee_ids=[str(peer.id)]
    ).json()["id"]

    resp = client.patch(
        f"/api/v1.0/calendar-events/{event_id}/",
        {"with_video_meeting": True},
        format="json",
    )

    assert resp.status_code == 200, resp.content
    assert resp.json()["room_slug"]
    event = models.CalendarEvent.objects.get(id=event_id)
    assert event.room is not None
    # 补建房间时要把既有参与者一起放进去,否则他们进不了会。
    assert event.room.accesses.filter(user=me, role=models.RoleChoices.OWNER).exists()
    assert event.room.accesses.filter(
        user=peer, role=models.RoleChoices.MEMBER
    ).exists()


def test_removing_a_video_meeting_detaches_but_keeps_the_room():
    _org, _me, client = _organizer_client()
    created = _create(client).json()
    event_id, room_id = created["id"], created["room"]

    resp = client.patch(
        f"/api/v1.0/calendar-events/{event_id}/",
        {"with_video_meeting": False},
        format="json",
    )

    assert resp.status_code == 200, resp.content
    assert resp.json()["room"] is None
    assert models.CalendarEvent.objects.get(id=event_id).room is None
    # 房间本身保留:可能正在录制/有人在里面,同 perform_destroy 的口径。
    assert models.Room.objects.filter(id=room_id).exists()


def test_patching_other_fields_leaves_the_video_meeting_alone():
    """字段缺省 = 不动。少了这条,任何一次 PATCH 都会给无会议的日程补房间。"""
    _org, _me, client = _organizer_client()
    event_id = _create(client, with_video_meeting=False).json()["id"]

    resp = client.patch(
        f"/api/v1.0/calendar-events/{event_id}/",
        {"title": "Renamed"},
        format="json",
    )

    assert resp.status_code == 200
    assert resp.json()["room"] is None


def test_toggling_video_meeting_is_idempotent():
    _org, _me, client = _organizer_client()
    created = _create(client).json()
    event_id, room_id = created["id"], created["room"]

    resp = client.patch(
        f"/api/v1.0/calendar-events/{event_id}/",
        {"with_video_meeting": True},
        format="json",
    )

    assert resp.status_code == 200
    # 本来就有会议 —— 不该换一个新房间(会议号会变,已发出去的链接就废了)。
    assert resp.json()["room"] == room_id


# --- 会议室预定限制 (P9 M2 knobs, enforced at booking time) -----------------


def _book(client, room, *, start=None, end=None, title="Sync"):
    default_start, default_end = _times()
    return client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": title,
            "start_at": (start or default_start).isoformat(),
            "end_at": (end or default_end).isoformat(),
            "meeting_room_id": str(room.id),
        },
        format="json",
    )


def test_booking_longer_than_the_room_allows_is_rejected():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    room = _room(org, max_booking_minutes=60)
    start, _ = _times()
    client = APIClient()
    client.force_login(me)

    too_long = _book(client, room, start=start, end=start + timedelta(hours=2))
    assert too_long.status_code == 400
    assert models.MeetingRoomBooking.objects.count() == 0

    # Exactly at the limit still goes through — the cap is inclusive.
    assert (
        _book(client, room, start=start, end=start + timedelta(minutes=60)).status_code
        == 201
    )


def test_booking_further_ahead_than_the_room_allows_is_rejected():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    _membership(org, me)
    room = _room(org, advance_booking_days=7)
    far = timezone.now() + timedelta(days=30)
    client = APIClient()
    client.force_login(me)

    resp = _book(client, room, start=far, end=far + timedelta(hours=1))
    assert resp.status_code == 400
    assert models.MeetingRoomBooking.objects.count() == 0


def test_department_scoped_room_is_bookable_from_a_sub_department():
    """Granting 深圳总部 has to cover the teams inside it, not just its own members."""
    org = factories.OrganizationFactory()
    parent = factories.DepartmentFactory(organization=org)
    child = factories.DepartmentFactory(organization=org, parent=parent)
    insider = factories.UserFactory()
    outsider = factories.UserFactory()
    _membership(org, insider, department=child)
    _membership(org, outsider, department=factories.DepartmentFactory(organization=org))

    room = _room(org, booking_scope=models.MeetingRoomBookingScope.DEPARTMENTS)
    room.bookable_departments.set([parent])

    inside = APIClient()
    inside.force_login(insider)
    assert _book(inside, room).status_code == 201

    outside = APIClient()
    outside.force_login(outsider)
    resp = _book(outside, room, title="Nope")
    assert resp.status_code == 400
    # Hidden from browse too, not just refused on submit.
    listed = outside.get("/api/v1.0/meeting-rooms/").json()["results"]
    assert [r["id"] for r in listed] == []
