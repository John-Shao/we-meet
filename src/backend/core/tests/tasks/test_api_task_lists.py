"""Task-list, custom-group, and workload API coverage."""

from datetime import timedelta

from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.models import (
    Task,
    TaskActivity,
    TaskGroup,
    TaskList,
    TaskListAccess,
    TaskListGroup,
)

pytestmark = pytest.mark.django_db

TASKS_URL = "/api/v1.0/tasks/"
TASK_LISTS_URL = "/api/v1.0/task-lists/"
TASK_LIST_GROUPS_URL = "/api/v1.0/task-list-groups/"


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
    assert TaskListAccess.objects.get(task_list=task_list, user=creator).role == "owner"
    assert task_list.name == "Product launch"
    assert created.json()["can_manage"] is True
    assert created.json()["list_group"] is None
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


def test_task_list_counts_do_not_add_queries_per_list():
    organization, owner = _organization_user()
    client = _client(owner)

    def create_list(name):
        task_list = TaskList.objects.create(
            organization=organization,
            creator=owner,
            name=name,
        )
        TaskListAccess.objects.create(
            task_list=task_list,
            user=owner,
            role=TaskListAccess.Role.OWNER,
        )
        Task.objects.create(
            organization=organization,
            creator=owner,
            task_list=task_list,
            title=f"{name} task",
        )
        return task_list

    create_list("First")
    client.get(TASK_LISTS_URL)
    with CaptureQueriesContext(connection) as single_list_queries:
        single_response = client.get(TASK_LISTS_URL)

    create_list("Second")
    create_list("Third")
    create_list("Fourth")
    with CaptureQueriesContext(connection) as multiple_list_queries:
        multiple_response = client.get(TASK_LISTS_URL)

    assert single_response.status_code == 200
    assert multiple_response.status_code == 200
    assert [item["task_count"] for item in single_response.json()] == [1]
    assert [item["task_count"] for item in multiple_response.json()] == [1, 1, 1, 1]
    assert len(multiple_list_queries) == len(single_list_queries)


def test_task_list_sharing_enforces_viewer_and_editor_permissions():
    organization, owner = _organization_user()
    _, colleague = _organization_user(organization=organization)
    _, outsider = _organization_user()
    owner_client = _client(owner)
    task_list_id = owner_client.post(
        TASK_LISTS_URL, {"name": "Shared delivery", "color": "blue"}, format="json"
    ).json()["id"]
    task = Task.objects.create(
        organization=organization,
        creator=owner,
        title="Visible through list access",
        task_list_id=task_list_id,
    )

    shared = owner_client.post(
        f"{TASK_LISTS_URL}{task_list_id}/shares/",
        {"user_id": str(colleague.id), "role": "viewer"},
        format="json",
    )
    assert shared.status_code == 201
    assert shared.json()["role"] == "viewer"
    owner_visible_tasks = owner_client.get(
        TASKS_URL,
        {"scope": "all", "task_list": task_list_id},
    )
    assert owner_visible_tasks.status_code == 200
    assert [item["id"] for item in owner_visible_tasks.json()["results"]] == [
        str(task.id)
    ]
    assert (
        owner_client.post(
            f"{TASK_LISTS_URL}{task_list_id}/shares/",
            {"user_id": str(outsider.id), "role": "viewer"},
            format="json",
        ).status_code
        == 400
    )

    colleague_client = _client(colleague)
    listed = colleague_client.get(TASK_LISTS_URL).json()[0]
    assert listed["access_role"] == "viewer"
    assert listed["can_manage"] is False
    assert listed["can_delete"] is False
    visible_tasks = colleague_client.get(
        TASKS_URL,
        {"scope": "all", "task_list": task_list_id},
    )
    assert [item["id"] for item in visible_tasks.json()["results"]] == [str(task.id)]
    assert (
        colleague_client.post(
            TASKS_URL,
            {"title": "Denied", "task_list_id": task_list_id},
            format="json",
        ).status_code
        == 400
    )
    assert (
        colleague_client.patch(
            f"{TASKS_URL}{task.id}/", {"title": "Denied"}, format="json"
        ).status_code
        == 403
    )
    assert (
        colleague_client.patch(
            f"{TASKS_URL}{task.id}/", {"status": "completed"}, format="json"
        ).status_code
        == 403
    )
    assert (
        colleague_client.post(
            f"{TASKS_URL}{task.id}/comments/",
            {"content": "Denied"},
            format="json",
        ).status_code
        == 403
    )

    changed = owner_client.patch(
        f"{TASK_LISTS_URL}{task_list_id}/shares/{colleague.id}/",
        {"role": "editor"},
        format="json",
    )
    assert changed.status_code == 200
    assert changed.json()["role"] == "editor"
    assert (
        colleague_client.patch(
            f"{TASKS_URL}{task.id}/", {"title": "Edited"}, format="json"
        ).status_code
        == 200
    )


def test_task_list_archive_leave_and_owner_delete_keep_expected_tasks():
    organization, owner = _organization_user()
    _, editor = _organization_user(organization=organization)
    owner_client = _client(owner)
    created = owner_client.post(
        TASK_LISTS_URL, {"name": "Project archive", "color": "blue"}, format="json"
    ).json()
    task_list_id = created["id"]
    owner_client.post(
        f"{TASK_LISTS_URL}{task_list_id}/shares/",
        {"user_id": str(editor.id), "role": "editor"},
        format="json",
    )
    assigned = Task.objects.create(
        organization=organization,
        creator=owner,
        assignee=editor,
        title="Keep assigned",
        task_list_id=task_list_id,
    )
    orphan = Task.objects.create(
        organization=organization,
        creator=owner,
        title="Delete orphan",
        task_list_id=task_list_id,
    )
    retained_parent = Task.objects.create(
        organization=organization,
        creator=owner,
        title="Parent required by assigned subtask",
        task_list_id=task_list_id,
    )
    assigned_subtask = Task.objects.create(
        organization=organization,
        creator=owner,
        assignee=editor,
        parent=retained_parent,
        title="Keep assigned subtask",
        task_list_id=task_list_id,
    )

    editor_client = _client(editor)
    archived = editor_client.patch(
        f"{TASK_LISTS_URL}{task_list_id}/",
        {"is_archived": True},
        format="json",
    )
    assert archived.status_code == 200
    assert editor_client.get(TASK_LISTS_URL).json() == []
    assert editor_client.get(TASK_LISTS_URL, {"archived": "true"}).json()[0][
        "is_archived"
    ] is True
    assert (
        editor_client.post(
            TASKS_URL,
            {"title": "No new work", "task_list_id": task_list_id},
            format="json",
        ).status_code
        == 400
    )
    assert (
        editor_client.patch(
            f"{TASKS_URL}{assigned.id}/", {"title": "Still editable"}, format="json"
        ).status_code
        == 200
    )
    assert (
        editor_client.patch(
            f"{TASK_LISTS_URL}{task_list_id}/?archived=true",
            {"is_archived": False},
            format="json",
        ).status_code
        == 200
    )
    assert editor_client.post(f"{TASK_LISTS_URL}{task_list_id}/leave/").status_code == 204
    assert editor_client.get(TASK_LISTS_URL).json() == []

    deleted = owner_client.delete(
        f"{TASK_LISTS_URL}{task_list_id}/?delete_unassigned=true"
    )
    assert deleted.status_code == 204
    assigned.refresh_from_db()
    retained_parent.refresh_from_db()
    assigned_subtask.refresh_from_db()
    assert assigned.task_list is None
    assert retained_parent.task_list is None
    assert assigned_subtask.task_list is None
    assert not Task.objects.filter(id=orphan.id).exists()


def test_task_list_groups_organize_lists_and_enforce_management_permissions():
    organization, creator = _organization_user()
    _, colleague = _organization_user(organization=organization)
    _, outsider = _organization_user()
    client = _client(creator)

    created_group = client.post(
        TASK_LIST_GROUPS_URL,
        {"name": "  Product development  ", "sort_order": 10},
        format="json",
    )

    assert created_group.status_code == 201
    group_payload = created_group.json()
    group = TaskListGroup.objects.get()
    assert group.name == "Product development"
    assert group.organization == organization
    assert group.creator == creator
    assert group_payload["can_manage"] is True
    assert group_payload["list_count"] == 0

    created_list = client.post(
        TASK_LISTS_URL,
        {
            "name": "Roadmap",
            "color": "blue",
            "list_group_id": str(group.id),
        },
        format="json",
    )
    assert created_list.status_code == 201
    assert created_list.json()["list_group"] == {
        "id": str(group.id),
        "name": "Product development",
        "sort_order": 10,
    }
    assert TaskList.objects.get().list_group == group
    assert client.get(TASK_LIST_GROUPS_URL).json()[0]["list_count"] == 1

    duplicate = client.post(
        TASK_LIST_GROUPS_URL,
        {"name": "product development"},
        format="json",
    )
    assert duplicate.status_code == 400
    assert (
        _client(colleague)
        .patch(
            f"{TASK_LIST_GROUPS_URL}{group.id}/",
            {"name": "Denied"},
            format="json",
        )
        .status_code
        == 403
    )
    assert _client(outsider).get(TASK_LIST_GROUPS_URL).json() == []


def test_deleting_task_list_group_keeps_lists_and_cross_org_assignment_is_rejected():
    organization, creator = _organization_user()
    group = TaskListGroup.objects.create(
        organization=organization,
        creator=creator,
        name="Team management",
    )
    task_list = TaskList.objects.create(
        organization=organization,
        creator=creator,
        list_group=group,
        name="Hiring",
    )
    other_organization, outsider = _organization_user()
    outside_group = TaskListGroup.objects.create(
        organization=other_organization,
        creator=outsider,
        name="Outside",
    )
    client = _client(creator)

    cross_org = client.patch(
        f"{TASK_LISTS_URL}{task_list.id}/",
        {"list_group_id": str(outside_group.id)},
        format="json",
    )
    assert cross_org.status_code == 400
    assert "list_group_id" in cross_org.json()

    deleted = client.delete(f"{TASK_LIST_GROUPS_URL}{group.id}/")
    assert deleted.status_code == 204
    task_list.refresh_from_db()
    assert task_list.list_group is None
    assert TaskList.objects.filter(id=task_list.id).exists()


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
