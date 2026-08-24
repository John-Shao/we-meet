"""Task-list, custom-group, and workload API coverage."""

from datetime import timedelta

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.models import Task, TaskActivity, TaskGroup, TaskList

pytestmark = pytest.mark.django_db

TASKS_URL = "/api/v1.0/tasks/"
TASK_LISTS_URL = "/api/v1.0/task-lists/"


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _organization_user(*, organization=None, role="member"):
    organization = organization or OrganizationFactory()
    user = UserFactory()
    MembershipFactory(
        organization=organization,
        user=user,
        is_primary=True,
        org_role=role,
    )
    return organization, user


def test_task_lists_and_groups_are_scoped_and_managed_by_their_creator():
    organization, creator = _organization_user()
    _, colleague = _organization_user(organization=organization)
    other_organization, outsider = _organization_user()
    client = _client(creator)

    created = client.post(
        TASK_LISTS_URL,
        {"name": "  Product launch  ", "description": "Q4", "color": "purple"},
        format="json",
    )

    assert created.status_code == 201
    task_list = TaskList.objects.get()
    assert task_list.organization == organization
    assert task_list.creator == creator
    assert task_list.name == "Product launch"
    assert created.json()["can_manage"] is True
    assert created.json()["groups"] == []

    group = client.post(
        f"{TASK_LISTS_URL}{task_list.id}/groups/",
        {"name": "In analysis", "sort_order": 10},
        format="json",
    )
    assert group.status_code == 201
    assert group.json()["sort_order"] == 10
    assert TaskGroup.objects.get().task_list == task_list

    duplicate = client.post(
        f"{TASK_LISTS_URL}{task_list.id}/groups/",
        {"name": "in analysis"},
        format="json",
    )
    assert duplicate.status_code == 400

    assert (
        _client(colleague)
        .patch(
            f"/api/v1.0/task-groups/{group.json()['id']}/",
            {"name": "Denied"},
            format="json",
        )
        .status_code
        == 403
    )
    assert _client(outsider).get(TASK_LISTS_URL).json() == []
    assert task_list.organization != other_organization


def test_task_placement_filter_and_history_keep_list_and_group_consistent():
    organization, creator = _organization_user()
    task_list = TaskList.objects.create(
        organization=organization,
        creator=creator,
        name="Requirements",
    )
    analysis = TaskGroup.objects.create(task_list=task_list, name="Analysis")
    done = TaskGroup.objects.create(task_list=task_list, name="Ready", sort_order=1)
    client = _client(creator)

    created = client.post(
        TASKS_URL,
        {
            "title": "Confirm scope",
            "task_list_id": str(task_list.id),
            "group_id": str(analysis.id),
            "position": 2,
        },
        format="json",
    )

    assert created.status_code == 201
    assert created.json()["task_list"]["id"] == str(task_list.id)
    assert created.json()["group"]["id"] == str(analysis.id)
    assert created.json()["position"] == 2
    task = Task.objects.get()

    filtered = client.get(
        TASKS_URL,
        {"scope": "all", "task_list": str(task_list.id)},
    )
    assert filtered.status_code == 200
    assert [item["id"] for item in filtered.json()["results"]] == [str(task.id)]

    moved = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"group_id": str(done.id), "position": 1},
        format="json",
    )
    assert moved.status_code == 200
    assert moved.json()["group"]["id"] == str(done.id)
    activity = TaskActivity.objects.get(event=TaskActivity.Event.PLACEMENT_CHANGED)
    assert activity.changes["placement"]["from"]["group"]["name"] == "Analysis"
    assert activity.changes["placement"]["to"]["group"]["name"] == "Ready"

    cleared = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"task_list_id": None},
        format="json",
    )
    assert cleared.status_code == 200
    assert cleared.json()["task_list"] is None
    assert cleared.json()["group"] is None


def test_task_placement_rejects_cross_list_and_cross_organization_groups():
    organization, creator = _organization_user()
    first = TaskList.objects.create(
        organization=organization,
        creator=creator,
        name="First",
    )
    second = TaskList.objects.create(
        organization=organization,
        creator=creator,
        name="Second",
    )
    second_group = TaskGroup.objects.create(task_list=second, name="Second group")
    other_organization, outsider = _organization_user()
    outside_list = TaskList.objects.create(
        organization=other_organization,
        creator=outsider,
        name="Outside",
    )
    client = _client(creator)

    mismatched = client.post(
        TASKS_URL,
        {
            "title": "Mismatch",
            "task_list_id": str(first.id),
            "group_id": str(second_group.id),
        },
        format="json",
    )
    outside = client.post(
        TASKS_URL,
        {"title": "Outside", "task_list_id": str(outside_list.id)},
        format="json",
    )

    assert mismatched.status_code == 400
    assert "group_id" in mismatched.json()
    assert outside.status_code == 400
    assert "task_list_id" in outside.json()
    assert not Task.objects.exists()


def test_task_groups_can_only_be_deleted_when_empty():
    organization, creator = _organization_user()
    task_list = TaskList.objects.create(
        organization=organization,
        creator=creator,
        name="Delivery",
    )
    occupied = TaskGroup.objects.create(task_list=task_list, name="In progress")
    empty = TaskGroup.objects.create(task_list=task_list, name="Ready")
    Task.objects.create(
        organization=organization,
        creator=creator,
        title="Prepare rollout",
        task_list=task_list,
        group=occupied,
    )
    client = _client(creator)

    listed = client.get(TASK_LISTS_URL).json()[0]["groups"]
    can_delete = {group["id"]: group["can_delete"] for group in listed}
    assert can_delete[str(occupied.id)] is False
    assert can_delete[str(empty.id)] is True
    assert (
        client.delete(f"/api/v1.0/task-groups/{occupied.id}/").status_code == 400
    )
    assert client.delete(f"/api/v1.0/task-groups/{empty.id}/").status_code == 204


def test_statistics_report_visible_summary_and_assignee_workload_only():
    organization, creator = _organization_user()
    _, assignee = _organization_user(organization=organization)
    _, unrelated = _organization_user(organization=organization)
    task_list = TaskList.objects.create(
        organization=organization,
        creator=creator,
        name="Delivery",
    )
    today = timezone.localdate()
    Task.objects.create(
        title="Overdue",
        creator=creator,
        assignee=assignee,
        organization=organization,
        task_list=task_list,
        due_date=today - timedelta(days=1),
    )
    Task.objects.create(
        title="Done",
        creator=creator,
        assignee=assignee,
        organization=organization,
        task_list=task_list,
        status=Task.Status.COMPLETED,
        completed_at=timezone.now(),
    )
    Task.objects.create(
        title="Hidden",
        creator=unrelated,
        assignee=unrelated,
        organization=organization,
        task_list=task_list,
    )

    response = _client(creator).get(
        f"{TASKS_URL}statistics/",
        {
            "scope": "all",
            "status": "all",
            "time": "all",
            "priority": "all",
            "label": "all",
            "task_list": str(task_list.id),
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"] == {
        "total": 2,
        "open": 1,
        "completed": 1,
        "canceled": 0,
        "overdue": 1,
        "completion_rate": 50,
    }
    assert len(payload["workload"]) == 1
    assert payload["workload"][0]["assignee_id"] == str(assignee.id)
    assert payload["workload"][0]["assignee__avatar_url"] == ""
    assert payload["workload"][0]["total"] == 2
    assert payload["workload"][0]["open"] == 1
    assert payload["workload"][0]["completed"] == 1
    assert payload["workload"][0]["overdue"] == 1
