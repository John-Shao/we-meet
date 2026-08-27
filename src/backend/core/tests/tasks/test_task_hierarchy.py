"""API coverage for bounded recursive task hierarchies."""

from django.test import override_settings

import pytest
from rest_framework.test import APIClient

from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.models import Task, TaskGroup, TaskList, TaskListAccess

pytestmark = pytest.mark.django_db

TASKS_URL = "/api/v1.0/tasks/"


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _create(client, title, parent_id=None):
    payload = {"title": title}
    if parent_id is not None:
        payload["parent_id"] = str(parent_id)
    return client.post(TASKS_URL, payload, format="json")


def test_create_recursive_subtasks_returns_depth_path_progress_and_children():
    user = UserFactory()
    client = _client(user)

    root_response = _create(client, "Release")
    root_id = root_response.json()["id"]
    child_response = _create(client, "Backend", root_id)
    child_id = child_response.json()["id"]
    leaf_response = _create(client, "Migration", child_id)

    assert root_response.status_code == 201
    assert child_response.status_code == 201
    assert leaf_response.status_code == 201
    assert leaf_response.json()["depth"] == 2
    assert [node["title"] for node in leaf_response.json()["ancestor_path"]] == [
        "Release",
        "Backend",
        "Migration",
    ]

    completed = client.patch(
        f"{TASKS_URL}{leaf_response.json()['id']}/",
        {"status": Task.Status.COMPLETED},
        format="json",
    )
    assert completed.status_code == 200
    root = client.get(f"{TASKS_URL}{root_id}/").json()
    assert root["status"] == Task.Status.TODO
    assert root["descendant_progress"] == {"completed": 1, "total": 2}

    children = client.get(f"{TASKS_URL}{root_id}/subtasks/")
    assert children.status_code == 200
    assert [task["title"] for task in children.json()] == ["Backend"]


def test_assignee_can_create_subtask_with_inherited_parent_placement():
    organization = OrganizationFactory()
    owner = UserFactory()
    assignee = UserFactory()
    MembershipFactory(user=owner, organization=organization, is_primary=True)
    MembershipFactory(user=assignee, organization=organization, is_primary=True)
    task_list = TaskList.objects.create(
        organization=organization,
        creator=owner,
        name="Delivery",
    )
    TaskListAccess.objects.create(
        task_list=task_list,
        user=owner,
        role=TaskListAccess.Role.OWNER,
    )
    TaskListAccess.objects.create(
        task_list=task_list,
        user=assignee,
        role=TaskListAccess.Role.VIEWER,
    )
    group = TaskGroup.objects.create(task_list=task_list, name="Backend")
    parent = Task.objects.create(
        organization=organization,
        creator=owner,
        assignee=assignee,
        title="Parent",
        task_list=task_list,
        group=group,
    )
    parent.assignees.add(assignee)
    client = _client(assignee)

    denied_root = client.post(
        TASKS_URL,
        {"title": "Root", "task_list_id": str(task_list.id)},
        format="json",
    )
    child = client.post(
        TASKS_URL,
        {
            "title": "Child",
            "parent_id": str(parent.id),
            "task_list_id": str(task_list.id),
            "group_id": str(group.id),
        },
        format="json",
    )

    assert denied_root.status_code == 400
    assert child.status_code == 201
    assert child.json()["parent_id"] == str(parent.id)
    assert child.json()["task_list"]["id"] == str(task_list.id)
    assert child.json()["group"]["id"] == str(group.id)


@override_settings(TASK_MAX_SUBTASK_DEPTH=2)
def test_depth_limit_is_runtime_configuration():
    user = UserFactory()
    client = _client(user)

    root = _create(client, "Root").json()
    child = _create(client, "Child", root["id"]).json()
    leaf = _create(client, "Leaf", child["id"])
    rejected = _create(client, "Too deep", leaf.json()["id"])

    assert leaf.status_code == 201
    assert rejected.status_code == 400
    assert rejected.json()["parent_id"]["code"] == "task_depth_exceeded"


def test_default_depth_allows_five_subtask_levels_and_rejects_sixth():
    user = UserFactory()
    client = _client(user)
    current = _create(client, "Depth 0").json()

    for depth in range(1, 6):
        response = _create(client, f"Depth {depth}", current["id"])
        assert response.status_code == 201
        assert response.json()["depth"] == depth
        current = response.json()

    rejected = _create(client, "Depth 6", current["id"])
    assert rejected.status_code == 400
    assert rejected.json()["parent_id"]["code"] == "task_depth_exceeded"


@override_settings(TASK_MAX_DIRECT_CHILDREN=1)
def test_direct_child_limit_is_enforced():
    user = UserFactory()
    client = _client(user)
    root = _create(client, "Root").json()

    assert _create(client, "First", root["id"]).status_code == 201
    rejected = _create(client, "Second", root["id"])

    assert rejected.status_code == 400
    assert rejected.json()["parent_id"]["code"] == "task_direct_children_exceeded"


@override_settings(TASK_MAX_TREE_NODES=2)
def test_tree_node_limit_is_enforced():
    user = UserFactory()
    client = _client(user)
    root = _create(client, "Root").json()
    child = _create(client, "Child", root["id"]).json()

    rejected = _create(client, "Third", child["id"])

    assert rejected.status_code == 400
    assert rejected.json()["parent_id"]["code"] == "task_tree_nodes_exceeded"


def test_move_rejects_cycle_and_cross_organization_parent():
    first_org = OrganizationFactory()
    second_org = OrganizationFactory()
    first_user = UserFactory()
    second_user = UserFactory()
    MembershipFactory(user=first_user, organization=first_org)
    MembershipFactory(user=second_user, organization=second_org)
    first_client = _client(first_user)
    second_client = _client(second_user)

    root = _create(first_client, "Root").json()
    child = _create(first_client, "Child", root["id"]).json()
    cycle = first_client.patch(
        f"{TASKS_URL}{root['id']}/",
        {"parent_id": child["id"], "confirm_subtree_node_count": 2},
        format="json",
    )
    assert cycle.status_code == 400
    assert cycle.json()["parent_id"]["code"] == "task_hierarchy_cycle"

    foreign_parent = Task.objects.get(pk=root["id"])
    foreign_parent.assignees.add(second_user)
    own_task = _create(second_client, "Own").json()
    cross_org = second_client.patch(
        f"{TASKS_URL}{own_task['id']}/",
        {"parent_id": root["id"]},
        format="json",
    )
    assert cross_org.status_code == 400
    assert cross_org.json()["parent_id"]["code"] == "task_cross_organization"


def test_move_parent_preserves_subtree_and_records_hierarchy_activity():
    user = UserFactory()
    client = _client(user)
    first_root = _create(client, "First root").json()
    second_root = _create(client, "Second root").json()
    child = _create(client, "Child", first_root["id"]).json()
    leaf = _create(client, "Leaf", child["id"]).json()

    moved = client.patch(
        f"{TASKS_URL}{child['id']}/",
        {
            "parent_id": second_root["id"],
            "confirm_subtree_node_count": 2,
        },
        format="json",
    )
    moved_leaf = client.get(f"{TASKS_URL}{leaf['id']}/")
    activities = client.get(f"{TASKS_URL}{child['id']}/activities/")

    assert moved.status_code == 200
    assert [node["title"] for node in moved.json()["ancestor_path"]] == [
        "Second root",
        "Child",
    ]
    assert [node["title"] for node in moved_leaf.json()["ancestor_path"]] == [
        "Second root",
        "Child",
        "Leaf",
    ]
    hierarchy_activity = next(
        item for item in activities.json() if item["event"] == "hierarchy_changed"
    )
    assert hierarchy_activity["changes"]["parent"] == {
        "from": {"id": first_root["id"], "title": "First root"},
        "to": {"id": second_root["id"], "title": "Second root"},
    }


def test_hidden_ancestor_hides_child_from_detail_and_search():
    parent_owner = UserFactory()
    child_owner = UserFactory()
    parent = Task.objects.create(
        title="Secret parent", creator=parent_owner, assignee=parent_owner
    )
    child = Task.objects.create(
        title="Visible child",
        creator=child_owner,
        assignee=child_owner,
        parent=parent,
    )
    child.assignees.add(child_owner)
    client = _client(child_owner)

    assert client.get(f"{TASKS_URL}{child.id}/").status_code == 404
    results = client.get(
        TASKS_URL,
        {"scope": "all", "status": "all", "q": "Visible child"},
    )
    assert results.status_code == 200
    assert results.json()["count"] == 0
    assert results.json()["results"] == []


def test_hidden_descendant_does_not_leak_subtree_impact_or_delete_count():
    parent_owner = UserFactory()
    child_owner = UserFactory()
    parent = Task.objects.create(
        title="Visible parent", creator=parent_owner, assignee=parent_owner
    )
    Task.objects.create(
        title="Hidden child",
        creator=child_owner,
        assignee=child_owner,
        parent=parent,
    )
    client = _client(parent_owner)

    impact = client.get(f"{TASKS_URL}{parent.id}/subtree-impact/")
    deleted = client.delete(f"{TASKS_URL}{parent.id}/")

    assert impact.status_code == 403
    assert deleted.status_code == 403
    assert "expected" not in str(deleted.json())


def test_subtree_impact_and_delete_cover_the_complete_tree():
    user = UserFactory()
    client = _client(user)
    root = _create(client, "Root").json()
    child = _create(client, "Child", root["id"]).json()
    _create(client, "Leaf", child["id"])

    impact = client.get(f"{TASKS_URL}{root['id']}/subtree-impact/")
    rejected = client.delete(f"{TASKS_URL}{root['id']}/")
    deleted = client.delete(f"{TASKS_URL}{root['id']}/?confirm_subtree_node_count=3")

    assert impact.status_code == 200
    assert impact.json()["node_count"] == 3
    assert impact.json()["descendant_count"] == 2
    assert rejected.status_code == 400
    assert (
        rejected.json()["confirm_subtree_node_count"]["code"]
        == "task_subtree_confirmation_required"
    )
    assert deleted.status_code == 204
    assert Task.objects.count() == 0


def test_statistics_explicitly_support_roots_or_all_descendants():
    user = UserFactory()
    client = _client(user)
    root = _create(client, "Root").json()
    _create(client, "Child", root["id"])

    all_nodes = client.get(
        f"{TASKS_URL}statistics/",
        {"scope": "all", "status": "all", "hierarchy": "include_descendants"},
    )
    roots = client.get(
        f"{TASKS_URL}statistics/",
        {"scope": "all", "status": "all", "hierarchy": "roots_only"},
    )

    assert all_nodes.status_code == 200
    assert all_nodes.json()["hierarchy_scope"] == "include_descendants"
    assert all_nodes.json()["summary"]["total"] == 2
    assert roots.status_code == 200
    assert roots.json()["hierarchy_scope"] == "roots_only"
    assert roots.json()["summary"]["total"] == 1
