"""P8 变更推送测试:值差分防噪 + on_commit 触发 + 取消快照 + cid 写入不回读。"""

import json
from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services import calendar_im_notify
from core.services.calendar_recurrence import materialize_recurrences

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
    with mock.patch.object(calendar_im_notify, "verify_source_membership"):
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
    # P8-UX:变更卡以组织者身份发出。
    assert push.call_args.kwargs["organizer"].email == "o@acme.com"


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
    # P8-UX:取消卡以组织者身份发出(行已删,组织者对象来自删除前快照)。
    assert push.call_args.kwargs["organizer"].email == "o@acme.com"


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


def _recurring_child(client, *, cid=CID):
    body = _create(
        client,
        cid=cid,
        recurrence="FREQ=DAILY;COUNT=4",
        reminders=[10],
    )
    parent = models.CalendarEvent.objects.get(pk=body["id"])
    materialize_recurrences(now=timezone.now())
    return parent, parent.occurrences.order_by("start_at").first()


@pytest.mark.parametrize("scope", ["one", "following", "all"])
def test_recurring_time_change_pushes_one_range_aware_card(
    scope,
    django_capture_on_commit_callbacks,
):
    _, _, _, client = _setup()
    _parent, child = _recurring_child(client)
    old_start, old_end = child.start_at, child.end_at
    new_start = old_start + timedelta(hours=2)
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        with django_capture_on_commit_callbacks(execute=True):
            response = client.patch(
                f"/api/v1.0/calendar-events/{child.id}/",
                {
                    "start_at": new_start.isoformat(),
                    "end_at": (new_start + timedelta(hours=1)).isoformat(),
                    "edit_scope": scope,
                },
                format="json",
            )

    assert response.status_code == 200, response.content
    assert push.call_count == 1
    cid, card = push.call_args.args
    assert cid == CID
    assert card["kind"] == "time_changed"
    assert card["recurrence_scope"] == scope
    assert card["old_start"] == old_start.isoformat()
    assert card["old_end"] == old_end.isoformat()
    assert card["start"] == new_start.isoformat()


@pytest.mark.parametrize("scope", ["one", "following", "all"])
def test_recurring_delete_pushes_one_range_aware_card(
    scope,
    django_capture_on_commit_callbacks,
):
    _, _, _, client = _setup()
    _parent, child = _recurring_child(client)
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        with django_capture_on_commit_callbacks(execute=True):
            response = client.delete(
                f"/api/v1.0/calendar-events/{child.id}/?scope={scope}"
            )

    assert response.status_code == 204, response.content
    assert push.call_count == 1
    cid, card = push.call_args.args
    assert cid == CID
    assert card["kind"] == "cancelled"
    assert card["recurrence_scope"] == scope
    assert card["event_id"] == str(child.id)


def test_recurring_title_change_and_unsourced_series_do_not_push(
    django_capture_on_commit_callbacks,
):
    _, _, _, client = _setup()
    _parent, sourced = _recurring_child(client)
    _parent, unsourced = _recurring_child(client, cid=None)
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        with django_capture_on_commit_callbacks(execute=True):
            renamed = client.patch(
                f"/api/v1.0/calendar-events/{sourced.id}/",
                {"title": "Quiet rename", "edit_scope": "all"},
                format="json",
            )
            moved_start = unsourced.start_at + timedelta(hours=1)
            moved = client.patch(
                f"/api/v1.0/calendar-events/{unsourced.id}/",
                {
                    "start_at": moved_start.isoformat(),
                    "end_at": (moved_start + timedelta(hours=1)).isoformat(),
                    "edit_scope": "one",
                },
                format="json",
            )

    assert renamed.status_code == 200, renamed.content
    assert moved.status_code == 200, moved.content
    push.assert_not_called()


def test_push_card_sender_is_organizer_with_system_fallback():
    """P11c:留群严格发送;UID 解析失败直接退 SYSTEM。"""
    organizer = factories.UserFactory(email="cached@acme.com", im_uid="uid-cached")
    fake = mock.Mock()
    with mock.patch.object(calendar_im_notify, "_make_client", return_value=fake):
        calendar_im_notify.push_card(
            "cid-1", {"kind": "cancelled"}, organizer=organizer
        )
    assert fake.post_message.call_args.kwargs["sender_uid"] == "uid-cached"
    assert fake.post_message.call_args.kwargs["require_sender_membership"] is True
    fake.issue_token.assert_not_called()

    # 无缓存 + issue_token 失败 → SYSTEM(None)兜底,不炸。
    stranger = factories.UserFactory(email="nocache@acme.com")
    fake2 = mock.Mock()
    fake2.issue_token.side_effect = calendar_im_notify.JusiImServiceError("down")
    with mock.patch.object(calendar_im_notify, "_make_client", return_value=fake2):
        calendar_im_notify.push_card("cid-1", {"kind": "cancelled"}, organizer=stranger)
    assert fake2.post_message.call_args.kwargs["sender_uid"] is None


def test_push_card_organizer_left_uses_calendar_assistant_once():
    organizer = factories.UserFactory(email="left@acme.com", im_uid="uid-left")
    fake = mock.Mock()
    fake.post_message.side_effect = calendar_im_notify.JusiImSenderNotMemberError(
        "sender is not a conversation member"
    )
    assistant_result = mock.Mock(sender_uid="uid-calendar-assistant")

    with (
        mock.patch.object(calendar_im_notify, "_make_client", return_value=fake),
        mock.patch.object(
            calendar_im_notify.im_bots,
            "post_as_builtin",
            return_value=assistant_result,
        ) as post_as_builtin,
    ):
        calendar_im_notify.push_card(
            "cid-1",
            {"kind": "cancelled", "organizer_name": "张三"},
            organizer=organizer,
        )

    post_as_builtin.assert_called_once_with(
        calendar_im_notify.im_bots.BOT_CALENDAR_ASSISTANT,
        "cid-1",
        mock.ANY,
        content_type=calendar_im_notify.CONTENT_TYPE,
    )
    assert fake.post_message.call_count == 1, "助手成功后不能再落一条 SYSTEM"
    assert json.loads(post_as_builtin.call_args.args[2])["organizer_name"] == "张三"


def test_push_card_calendar_assistant_failure_falls_back_to_system():
    organizer = factories.UserFactory(email="left2@acme.com", im_uid="uid-left2")
    fake = mock.Mock()
    fake.post_message.side_effect = [
        calendar_im_notify.JusiImSenderNotMemberError("left"),
        mock.DEFAULT,
    ]

    with (
        mock.patch.object(calendar_im_notify, "_make_client", return_value=fake),
        mock.patch.object(
            calendar_im_notify.im_bots, "post_as_builtin", return_value=None
        ),
    ):
        calendar_im_notify.push_card(
            "cid-1", {"kind": "cancelled"}, organizer=organizer
        )

    assert fake.post_message.call_count == 2
    assert fake.post_message.call_args.kwargs["sender_uid"] is None


def test_push_card_other_jusi_error_does_not_impersonate_calendar_assistant():
    organizer = factories.UserFactory(email="error@acme.com", im_uid="uid-error")
    fake = mock.Mock()
    fake.post_message.side_effect = calendar_im_notify.JusiImServiceError("down")

    with (
        mock.patch.object(calendar_im_notify, "_make_client", return_value=fake),
        mock.patch.object(calendar_im_notify.im_bots, "post_as_builtin") as assistant,
    ):
        calendar_im_notify.push_card(
            "cid-1", {"kind": "cancelled"}, organizer=organizer
        )

    assistant.assert_not_called()


def test_notify_event_change_skips_missing_event():
    """行已不在(并发删除)→ 静默返回,不组卡不推送。"""
    with mock.patch.object(calendar_im_notify, "push_card") as push:
        calendar_im_notify.notify_event_change(
            "00000000-0000-0000-0000-000000000000", "time_changed"
        )
    push.assert_not_called()


def test_verify_source_membership_uses_the_callers_roster_token():
    user = factories.UserFactory(im_uid="")
    fake = mock.Mock()
    fake.issue_token.return_value = mock.Mock(uid="uid-me", token="member-token")
    fake.get_members.return_value = [{"uid": "uid-me", "role": "member"}]

    with mock.patch.object(calendar_im_notify, "_make_client", return_value=fake):
        calendar_im_notify.verify_source_membership(user, "source-cid")

    fake.get_members.assert_called_once_with("source-cid", "member-token")
    user.refresh_from_db()
    assert user.im_uid == "uid-me"


def test_verify_source_membership_maps_nonmember_to_access_denied():
    user = factories.UserFactory()
    fake = mock.Mock()
    fake.issue_token.return_value = mock.Mock(uid="uid-me", token="member-token")
    fake.get_members.side_effect = (
        calendar_im_notify.JusiImConversationAccessDeniedError("403")
    )

    with mock.patch.object(calendar_im_notify, "_make_client", return_value=fake):
        with pytest.raises(calendar_im_notify.SourceConversationAccessDenied):
            calendar_im_notify.verify_source_membership(user, "source-cid")


def test_verify_source_membership_fails_closed_on_unexpected_roster():
    user = factories.UserFactory()
    fake = mock.Mock()
    fake.issue_token.return_value = mock.Mock(uid="uid-me", token="member-token")
    fake.get_members.return_value = [{"uid": "someone-else", "role": "owner"}]

    with mock.patch.object(calendar_im_notify, "_make_client", return_value=fake):
        with pytest.raises(
            calendar_im_notify.SourceConversationVerificationUnavailable
        ):
            calendar_im_notify.verify_source_membership(user, "source-cid")
