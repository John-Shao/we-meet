"""Human review lifecycle for meeting action items."""

from datetime import timedelta

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import (
    MeetingParticipationFactory,
    MeetingSessionFactory,
    RoomFactory,
    UserFactory,
)
from core.models import ActionItem, Summary

pytestmark = pytest.mark.django_db


def _world():
    owner = UserFactory()
    assignee = UserFactory()
    member = UserFactory()
    outsider = UserFactory()
    room = RoomFactory(
        users=[(owner, "owner"), (assignee, "member"), (member, "member")]
    )
    session = MeetingSessionFactory(
        room=room,
        started_at=timezone.now() - timedelta(hours=1),
    )
    MeetingParticipationFactory(
        session=session,
        user=assignee,
        identity=str(assignee.sub),
    )
    summary = Summary.objects.create(
        room=room,
        session=session,
        content="summary",
        status=Summary.Status.SUCCESS,
    )
    item = ActionItem.objects.create(
        room=room,
        session=session,
        summary=summary,
        content="Ship the action-item workflow",
    )
    return owner, assignee, member, outsider, room, item


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _url(room, item):
    return f"/api/v1.0/rooms/{room.id}/action-items/{item.id}/"


def test_manager_confirms_and_assigns_action_item():
    owner, assignee, _member, _outsider, room, item = _world()
    due_at = (timezone.now() + timedelta(days=2)).isoformat()

    response = _client(owner).patch(
        _url(room, item),
        {
            "status": ActionItem.Status.CONFIRMED,
            "assignee_id": str(assignee.id),
            "due_at": due_at,
        },
        format="json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == ActionItem.Status.CONFIRMED
    assert payload["assignee"]["id"] == str(assignee.id)
    assert payload["confirmed_by"]["id"] == str(owner.id)
    assert payload["confirmed_at"] is not None
    assert payload["can_manage"] is True
    item.refresh_from_db()
    assert item.is_completed is False


def test_assignee_can_complete_and_reopen_but_not_edit_content():
    owner, assignee, _member, _outsider, room, item = _world()
    item.assignee = assignee
    item.status = ActionItem.Status.CONFIRMED
    item.confirmed_by = owner
    item.confirmed_at = timezone.now()
    item.save()
    client = _client(assignee)

    response = client.patch(
        _url(room, item),
        {"status": ActionItem.Status.COMPLETED},
        format="json",
    )
    assert response.status_code == 200
    assert response.json()["is_completed"] is True
    assert response.json()["completed_at"] is not None

    response = client.patch(
        _url(room, item),
        {"status": ActionItem.Status.CONFIRMED},
        format="json",
    )
    assert response.status_code == 200
    assert response.json()["is_completed"] is False
    assert response.json()["completed_at"] is None

    response = client.patch(
        _url(room, item), {"content": "silently changed"}, format="json"
    )
    assert response.status_code == 403


def test_unassigned_member_cannot_update_action_item():
    _owner, _assignee, member, _outsider, room, item = _world()

    response = _client(member).patch(
        _url(room, item),
        {"status": ActionItem.Status.CONFIRMED},
        format="json",
    )

    assert response.status_code == 403


def test_manager_cannot_assign_outsider():
    owner, _assignee, _member, outsider, room, item = _world()

    response = _client(owner).patch(
        _url(room, item),
        {"assignee_id": str(outsider.id)},
        format="json",
    )

    assert response.status_code == 400
    assert "assignee_id" in response.json()


def test_invalid_status_transition_is_rejected():
    owner, _assignee, _member, _outsider, room, item = _world()

    response = _client(owner).patch(
        _url(room, item),
        {"status": ActionItem.Status.COMPLETED},
        format="json",
    )

    assert response.status_code == 400
    assert "status" in response.json()


def test_list_exposes_capabilities_for_current_user():
    owner, assignee, _member, _outsider, room, item = _world()
    item.assignee = assignee
    item.save()

    owner_payload = _client(owner).get(
        f"/api/v1.0/rooms/{room.id}/action-items/"
    ).json()[0]
    assignee_payload = _client(assignee).get(
        f"/api/v1.0/rooms/{room.id}/action-items/"
    ).json()[0]

    assert owner_payload["can_manage"] is True
    assert owner_payload["can_update_status"] is True
    assert assignee_payload["can_manage"] is False
    assert assignee_payload["can_update_status"] is True
