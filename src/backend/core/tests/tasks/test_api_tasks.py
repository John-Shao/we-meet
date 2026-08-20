"""API coverage for the minimal standalone task module."""

from datetime import timedelta

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import RoomFactory, UserFactory
from core.models import ActionItem, Summary, Task

pytestmark = pytest.mark.django_db

TASKS_URL = "/api/v1.0/tasks/"


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def test_user_creates_personal_task_assigned_to_self():
    user = UserFactory()
    due_at = (timezone.now() + timedelta(days=1)).isoformat()

    response = _client(user).post(
        TASKS_URL,
        {"title": "  Prepare launch  ", "description": "Checklist", "due_at": due_at},
        format="json",
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["title"] == "Prepare launch"
    assert payload["creator"]["id"] == str(user.id)
    assert payload["assignee"]["id"] == str(user.id)
    assert payload["status"] == Task.Status.TODO
    assert payload["source_room_id"] is None
    assert payload["source_room_name"] is None
    assert payload["can_edit"] is True
    assert payload["can_update_status"] is True
    task = Task.objects.get()
    assert task.creator == user
    assert task.assignee == user


def test_list_scopes_tasks_to_creator_and_assignee():
    creator = UserFactory()
    assignee = UserFactory()
    outsider = UserFactory()
    shared = Task.objects.create(
        title="Shared task", creator=creator, assignee=assignee
    )
    personal = Task.objects.create(
        title="Personal task", creator=creator, assignee=creator
    )

    assigned = _client(creator).get(f"{TASKS_URL}?scope=assigned").json()
    created = _client(creator).get(f"{TASKS_URL}?scope=created").json()
    all_related = _client(creator).get(f"{TASKS_URL}?scope=all").json()
    outsider_results = _client(outsider).get(f"{TASKS_URL}?scope=all").json()

    assert {entry["id"] for entry in assigned["results"]} == {str(personal.id)}
    assert {entry["id"] for entry in created["results"]} == {
        str(shared.id),
        str(personal.id),
    }
    assert {entry["id"] for entry in all_related["results"]} == {
        str(shared.id),
        str(personal.id),
    }
    assert outsider_results["results"] == []


def test_assignee_can_advance_status_but_cannot_edit_content():
    creator = UserFactory()
    assignee = UserFactory()
    task = Task.objects.create(title="Follow up", creator=creator, assignee=assignee)
    client = _client(assignee)

    response = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.IN_PROGRESS},
        format="json",
    )
    assert response.status_code == 200
    assert response.json()["status"] == Task.Status.IN_PROGRESS
    assert response.json()["can_edit"] is False
    assert response.json()["can_update_status"] is True

    response = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"title": "Changed by assignee"},
        format="json",
    )
    assert response.status_code == 403


def test_creator_edits_content_and_completion_timestamp():
    creator = UserFactory()
    task = Task.objects.create(title="Draft", creator=creator, assignee=creator)
    client = _client(creator)

    completed = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"title": "Final draft", "status": Task.Status.COMPLETED},
        format="json",
    )
    assert completed.status_code == 200
    assert completed.json()["title"] == "Final draft"
    assert completed.json()["completed_at"] is not None

    reopened = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.TODO},
        format="json",
    )
    assert reopened.status_code == 200
    assert reopened.json()["completed_at"] is None


def test_invalid_status_transition_is_rejected():
    user = UserFactory()
    task = Task.objects.create(
        title="Done", creator=user, assignee=user, status=Task.Status.COMPLETED
    )

    response = _client(user).patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.IN_PROGRESS},
        format="json",
    )

    assert response.status_code == 400
    assert "status" in response.json()


def test_outsider_cannot_retrieve_task():
    creator = UserFactory()
    outsider = UserFactory()
    task = Task.objects.create(title="Private", creator=creator, assignee=creator)

    response = _client(outsider).get(f"{TASKS_URL}{task.id}/")

    assert response.status_code == 404


def test_meeting_task_exposes_source_room():
    owner = UserFactory()
    assignee = UserFactory()
    room = RoomFactory(users=[(owner, "owner"), (assignee, "member")])
    summary = Summary.objects.create(
        room=room,
        content="Summary",
        status=Summary.Status.SUCCESS,
    )
    action_item = ActionItem.objects.create(
        room=room,
        summary=summary,
        content="Call the supplier",
        status=ActionItem.Status.CONFIRMED,
        assignee=assignee,
    )
    task = Task.objects.create(
        title=action_item.content,
        creator=owner,
        assignee=assignee,
        source_action_item=action_item,
    )

    response = _client(assignee).get(f"{TASKS_URL}{task.id}/")

    assert response.status_code == 200
    assert response.json()["source_room_id"] == str(room.id)
    assert response.json()["source_room_name"] == room.name
