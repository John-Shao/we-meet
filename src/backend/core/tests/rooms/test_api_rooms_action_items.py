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
from core.models import ActionItem, Summary, Task, TaskActivity, TaskImDelivery

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


def _task_url(room, item):
    return f"/api/v1.0/rooms/{room.id}/action-items/{item.id}/task/"


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


def test_manager_can_list_members_and_participants_as_assignees():
    owner, assignee, member, _outsider, room, item = _world()
    participant_only = UserFactory()
    MeetingParticipationFactory(
        session=item.session,
        user=participant_only,
        identity=str(participant_only.sub),
    )

    response = _client(owner).get(
        f"/api/v1.0/rooms/{room.id}/action-item-assignees/"
    )

    assert response.status_code == 200
    assert {entry["id"] for entry in response.json()} == {
        str(owner.id),
        str(assignee.id),
        str(member.id),
        str(participant_only.id),
    }
    assert all("email" in entry for entry in response.json())


def test_member_cannot_list_action_item_assignees():
    _owner, _assignee, member, _outsider, room, _item = _world()

    response = _client(member).get(
        f"/api/v1.0/rooms/{room.id}/action-item-assignees/"
    )

    assert response.status_code == 403


def test_manager_creates_task_from_confirmed_action_item():
    owner, assignee, _member, _outsider, room, item = _world()
    due_at = timezone.now() + timedelta(days=2)
    item.status = ActionItem.Status.CONFIRMED
    item.assignee = assignee
    item.due_at = due_at
    item.save()

    response = _client(owner).post(_task_url(room, item), format="json")

    assert response.status_code == 201
    payload = response.json()
    assert payload["title"] == item.content
    assert payload["status"] == Task.Status.TODO
    assert payload["creator"]["id"] == str(owner.id)
    assert payload["assignee"]["id"] == str(assignee.id)
    assert payload["source_action_item_id"] == str(item.id)
    assert payload["due_date"] == timezone.localdate(due_at).isoformat()
    item.refresh_from_db()
    assert item.task_id == Task.objects.get().id
    activity = TaskActivity.objects.get()
    assert activity.actor == owner
    assert activity.event == TaskActivity.Event.CREATED
    delivery = TaskImDelivery.objects.get()
    assert delivery.recipient == assignee
    assert delivery.event == TaskImDelivery.Event.ASSIGNED


def test_action_item_task_conversion_is_idempotent():
    owner, assignee, _member, _outsider, room, item = _world()
    item.status = ActionItem.Status.CONFIRMED
    item.assignee = assignee
    item.save()
    client = _client(owner)

    first = client.post(_task_url(room, item), format="json")
    second = client.post(_task_url(room, item), format="json")

    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    assert Task.objects.count() == 1
    assert TaskActivity.objects.count() == 1
    assert TaskImDelivery.objects.count() == 1


def test_only_manager_can_convert_action_item_to_task():
    owner, assignee, member, _outsider, room, item = _world()
    item.status = ActionItem.Status.CONFIRMED
    item.assignee = assignee
    item.save()

    response = _client(member).post(_task_url(room, item), format="json")

    assert response.status_code == 403
    assert Task.objects.count() == 0


def test_action_item_must_be_confirmed_and_assigned_before_conversion():
    owner, assignee, _member, _outsider, room, item = _world()
    client = _client(owner)

    response = client.post(_task_url(room, item), format="json")
    assert response.status_code == 400

    item.status = ActionItem.Status.CONFIRMED
    item.save()
    response = client.post(_task_url(room, item), format="json")
    assert response.status_code == 400

    item.assignee = assignee
    item.save()
    response = client.post(_task_url(room, item), format="json")
    assert response.status_code == 201
