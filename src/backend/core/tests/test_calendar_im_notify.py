"""P8 变更推送测试:值差分防噪 + on_commit 触发 + 取消快照 + cid 写入不回读。"""

from datetime import timedelta
from unittest import mock

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from core import factories, models
from core.services import calendar_im_notify

pytestmark = pytest.mark.django_db

CID = "conv-p8-test"


def _membership(org, user):
    return models.Membership.objects.create(
        organization=org, user=user, is_primary=True
    )


def _setup():
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="组织者", email="o@acme.com")
    _membership(org, me)
    peer = factories.UserFactory(full_name="同事", email="p@acme.com")
    _membership(org, peer)
    client = APIClient()
    client.force_login(me)
    return org, me, peer, client


def _create(client, *, cid=CID, **extra):
    start = timezone.now() + timedelta(days=1)
    payload = {
        "title": "周会",
        "start_at": start.isoformat(),
        "end_at": (start + timedelta(hours=1)).isoformat(),
    }
    if cid:
        payload["source_conversation_id"] = cid
    payload.update(extra)
    resp = client.post("/api/v1.0/calendar-events/", payload, format="json")
    assert resp.status_code == 201, resp.content
    return resp.json()


def test_source_conversation_id_stored_but_not_returned():
    _, _, _, client = _setup()
    body = _create(client)
    # write_only:响应体不回读 cid(防泄露给后来补拉详情的人)。
    assert "source_conversation_id" not in body
    event = models.CalendarEvent.objects.get(id=body["id"])
    assert event.source_conversation_id == CID


def test_time_change_pushes_single_card(django_capture_on_commit_callbacks):
    _, _, _, client = _setup()
    body = _create(client)
    new_start = timezone.now() + timedelta(days=2)
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        with django_capture_on_commit_callbacks(execute=True):
            resp = client.patch(
                f"/api/v1.0/calendar-events/{body['id']}/",
                {
                    "start_at": new_start.isoformat(),
                    "end_at": (new_start + timedelta(hours=1)).isoformat(),
                },
                format="json",
            )
        assert resp.status_code == 200, resp.content
    assert push.call_count == 1
    cid, card = push.call_args.args
    assert cid == CID
    assert card["kind"] == "time_changed"
    assert card["v"] == 1
    assert card["event_id"] == body["id"]
    assert "old_start" in card and "old_end" in card


def test_title_only_change_does_not_push(django_capture_on_commit_callbacks):
    _, _, _, client = _setup()
    body = _create(client)
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        with django_capture_on_commit_callbacks(execute=True):
            resp = client.patch(
                f"/api/v1.0/calendar-events/{body['id']}/",
                {"title": "改个名"},
                format="json",
            )
        assert resp.status_code == 200, resp.content
    push.assert_not_called()


def test_idempotent_patch_does_not_push(django_capture_on_commit_callbacks):
    _, _, _, client = _setup()
    body = _create(client)
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        with django_capture_on_commit_callbacks(execute=True):
            resp = client.patch(
                f"/api/v1.0/calendar-events/{body['id']}/",
                {"start_at": body["start_at"], "end_at": body["end_at"]},
                format="json",
            )
        assert resp.status_code == 200, resp.content
    push.assert_not_called()


def test_attendee_add_pushes_attendees_changed(django_capture_on_commit_callbacks):
    _, _, peer, client = _setup()
    body = _create(client)
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        with django_capture_on_commit_callbacks(execute=True):
            resp = client.patch(
                f"/api/v1.0/calendar-events/{body['id']}/",
                {"attendee_ids": [str(peer.id)]},
                format="json",
            )
        assert resp.status_code == 200, resp.content
    assert push.call_count == 1
    _, card = push.call_args.args
    assert card["kind"] == "attendees_changed"
    assert card["added_count"] == 1
    # 组卡在 on_commit 后重取,人数应包含新参会者(组织者+1)。
    assert card["attendee_count"] == 2


def test_time_and_attendee_change_pushes_one_time_changed_card(
    django_capture_on_commit_callbacks,
):
    """时间+人同变 → 只发一张 time_changed(不发两条,防噪)。"""
    _, _, peer, client = _setup()
    body = _create(client)
    new_start = timezone.now() + timedelta(days=3)
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        with django_capture_on_commit_callbacks(execute=True):
            resp = client.patch(
                f"/api/v1.0/calendar-events/{body['id']}/",
                {
                    "start_at": new_start.isoformat(),
                    "end_at": (new_start + timedelta(hours=1)).isoformat(),
                    "attendee_ids": [str(peer.id)],
                },
                format="json",
            )
        assert resp.status_code == 200, resp.content
    assert push.call_count == 1
    _, card = push.call_args.args
    assert card["kind"] == "time_changed"


def test_destroy_pushes_cancelled_snapshot(django_capture_on_commit_callbacks):
    _, _, _, client = _setup()
    body = _create(client)
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        with django_capture_on_commit_callbacks(execute=True):
            resp = client.delete(f"/api/v1.0/calendar-events/{body['id']}/")
        assert resp.status_code == 204, resp.content
    assert push.call_count == 1
    cid, card = push.call_args.args
    assert cid == CID
    assert card["kind"] == "cancelled"
    # 快照在删除前组好 —— 标题/人数仍在。
    assert card["title"] == "周会"
    assert card["attendee_count"] == 1


def test_event_without_cid_never_pushes(django_capture_on_commit_callbacks):
    _, _, _, client = _setup()
    body = _create(client, cid=None)
    new_start = timezone.now() + timedelta(days=2)
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        with django_capture_on_commit_callbacks(execute=True):
            client.patch(
                f"/api/v1.0/calendar-events/{body['id']}/",
                {
                    "start_at": new_start.isoformat(),
                    "end_at": (new_start + timedelta(hours=1)).isoformat(),
                },
                format="json",
            )
            client.delete(f"/api/v1.0/calendar-events/{body['id']}/")
    push.assert_not_called()


def test_notify_event_change_skips_missing_event():
    """行已不在(并发删除)→ 静默返回,不组卡不推送。"""
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        calendar_im_notify.notify_event_change(
            "00000000-0000-0000-0000-000000000000", "time_changed"
        )
    push.assert_not_called()
