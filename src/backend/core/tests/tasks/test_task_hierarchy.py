"""API coverage for bounded recursive task hierarchies."""

import threading
from unittest.mock import patch

from django.db import connection
from django.test import override_settings

import pytest
from rest_framework.test import APIClient

from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.models import (
    Task,
    TaskConversationShare,
    TaskGroup,
    TaskImDelivery,
    TaskList,
    TaskListAccess,
)
from core.services.task_notifications import record_task_assignment

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


def test_subtask_collaborator_reads_the_complete_parent_chain():
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

    detail = client.get(f"{TASKS_URL}{child.id}/")
    parent_detail = client.get(f"{TASKS_URL}{parent.id}/")
    results = client.get(
        TASKS_URL,
        {"scope": "all", "status": "all", "q": "Visible child"},
    )
    ancestors = client.get(
        TASKS_URL,
        {"scope": "all", "status": "all"},
    )

    assert detail.status_code == 200
    assert [node["title"] for node in detail.json()["ancestor_path"]] == [
        "Secret parent",
        "Visible child",
    ]
    assert parent_detail.status_code == 200
    # Reading upwards never grants writing: the parent stays read-only.
    assert parent_detail.json()["can_edit"] is False
    assert parent_detail.json()["can_update_status"] is False
    assert parent_detail.json()["can_delete"] is False
    assert results.status_code == 200
    assert [item["id"] for item in results.json()["results"]] == [str(child.id)]
    assert {item["id"] for item in ancestors.json()["results"]} == {
        str(parent.id),
        str(child.id),
    }


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


@override_settings(TASK_MAX_SUBTASK_DEPTH=2)
def test_move_rejects_a_subtree_that_would_exceed_depth_limit():
    user = UserFactory()
    client = _client(user)
    source = _create(client, "Source").json()
    _create(client, "Source child", source["id"])
    target = _create(client, "Target").json()
    target_child = _create(client, "Target child", target["id"]).json()

    rejected = client.patch(
        f"{TASKS_URL}{source['id']}/",
        {
            "parent_id": target_child["id"],
            "confirm_subtree_node_count": 2,
        },
        format="json",
    )

    assert rejected.status_code == 400
    assert rejected.json()["parent_id"]["code"] == "task_depth_exceeded"


@override_settings(TASK_MAX_DIRECT_CHILDREN=1)
def test_move_rejects_a_full_target_parent():
    user = UserFactory()
    client = _client(user)
    target = _create(client, "Target").json()
    _create(client, "Existing", target["id"])
    source = _create(client, "Source").json()

    rejected = client.patch(
        f"{TASKS_URL}{source['id']}/",
        {"parent_id": target["id"]},
        format="json",
    )

    assert rejected.status_code == 400
    assert rejected.json()["parent_id"]["code"] == "task_direct_children_exceeded"


@override_settings(TASK_MAX_TREE_NODES=3)
def test_move_counts_the_complete_source_and_target_trees():
    user = UserFactory()
    client = _client(user)
    target = _create(client, "Target").json()
    _create(client, "Existing", target["id"])
    source = _create(client, "Source").json()
    _create(client, "Source child", source["id"])

    rejected = client.patch(
        f"{TASKS_URL}{source['id']}/",
        {"parent_id": target["id"], "confirm_subtree_node_count": 2},
        format="json",
    )

    assert rejected.status_code == 400
    assert rejected.json()["parent_id"]["code"] == "task_tree_nodes_exceeded"


@pytest.mark.parametrize(
    "visibility_role",
    ["creator", "assignee", "follower", "viewer", "editor", "owner"],
)
def test_complete_parent_chain_is_visible_to_every_collaborator_role(
    visibility_role,
):
    organization = OrganizationFactory()
    owner = UserFactory()
    viewer = UserFactory()
    MembershipFactory(user=owner, organization=organization)
    MembershipFactory(user=viewer, organization=organization)
    task_list = TaskList.objects.create(
        organization=organization,
        creator=owner,
        name="Hierarchy",
    )
    TaskListAccess.objects.create(
        task_list=task_list,
        user=owner,
        role=TaskListAccess.Role.OWNER,
    )
    creator = viewer if visibility_role == "creator" else owner
    parent = Task.objects.create(
        organization=organization,
        creator=creator,
        assignee=owner,
        title="Parent",
        task_list=task_list
        if visibility_role in {"viewer", "editor", "owner"}
        else None,
    )
    child = Task.objects.create(
        organization=organization,
        creator=creator,
        assignee=owner,
        title="Child",
        parent=parent,
        task_list=parent.task_list,
    )
    if visibility_role == "assignee":
        parent.assignees.add(viewer)
        child.assignees.add(viewer)
    elif visibility_role == "follower":
        parent.followers.add(viewer)
        child.followers.add(viewer)
    elif visibility_role in {"viewer", "editor", "owner"}:
        TaskListAccess.objects.create(
            task_list=task_list,
            user=viewer,
            role=getattr(TaskListAccess.Role, visibility_role.upper()),
        )

    client = _client(viewer)
    detail = client.get(f"{TASKS_URL}{child.id}/")
    filtered = client.get(
        TASKS_URL,
        {"scope": "all", "status": "all", "q": "Child"},
    )
    statistics = client.get(
        f"{TASKS_URL}statistics/",
        {"scope": "all", "status": "all", "hierarchy": "include_descendants"},
    )

    assert detail.status_code == 200
    assert [node["title"] for node in detail.json()["ancestor_path"]] == [
        "Parent",
        "Child",
    ]
    assert [item["id"] for item in filtered.json()["results"]] == [str(child.id)]
    assert statistics.json()["summary"]["total"] == 2


def test_subtask_assignee_lists_and_is_notified_through_the_parent_chain():
    parent_owner = UserFactory()
    child_owner = UserFactory()
    parent = Task.objects.create(
        title="Secret parent", creator=parent_owner, assignee=parent_owner
    )
    child = Task.objects.create(
        title="Visible child",
        creator=parent_owner,
        assignee=child_owner,
        parent=parent,
        due_date="2026-08-27",
    )
    child.assignees.add(child_owner)
    client = _client(child_owner)

    filtered = client.get(
        TASKS_URL,
        {"scope": "assigned", "status": "open", "time": "all"},
    )
    statistics = client.get(
        f"{TASKS_URL}statistics/",
        {"scope": "assigned", "status": "all"},
    )
    record_task_assignment(task=child, event=TaskImDelivery.Event.ASSIGNED)

    assert [item["id"] for item in filtered.json()["results"]] == [str(child.id)]
    # The ancestor stays out of the default "assigned" scope.
    assert statistics.json()["summary"]["total"] == 1
    assert TaskImDelivery.objects.filter(
        task=child,
        recipient=child_owner,
    ).exists()


@patch(
    "core.api.tasks._require_conversation_membership",
    side_effect=lambda _user, cid: cid,
)
def test_conversation_share_requires_the_complete_parent_chain(_membership):
    owner = UserFactory()
    viewer = UserFactory()
    parent = Task.objects.create(title="Parent", creator=owner, assignee=owner)
    child = Task.objects.create(
        title="Child", creator=owner, assignee=owner, parent=parent
    )
    owner_client = _client(owner)
    viewer_client = _client(viewer)

    rejected = owner_client.post(
        f"{TASKS_URL}{child.id}/share/",
        {"conversation_ids": ["hierarchy-chat"]},
        format="json",
    )
    TaskConversationShare.objects.create(
        task=parent,
        cid="hierarchy-chat",
        shared_by=owner,
    )
    accepted = owner_client.post(
        f"{TASKS_URL}{child.id}/share/",
        {"conversation_ids": ["hierarchy-chat"]},
        format="json",
    )
    detail = viewer_client.get(f"{TASKS_URL}{child.id}/?shared_via=hierarchy-chat")

    assert rejected.status_code == 400
    assert rejected.json()["parent_id"]["code"] == "task_parent_chain_invisible"
    assert accepted.status_code == 200
    assert detail.status_code == 200


def test_reorder_subtasks_requires_an_exact_snapshot_and_persists_positions():
    user = UserFactory()
    client = _client(user)
    parent = _create(client, "Parent").json()
    first = _create(client, "First", parent["id"]).json()
    second = _create(client, "Second", parent["id"]).json()

    stale = client.post(
        f"{TASKS_URL}{parent['id']}/subtasks/reorder/",
        {"task_ids": [second["id"]]},
        format="json",
    )
    reordered = client.post(
        f"{TASKS_URL}{parent['id']}/subtasks/reorder/",
        {"task_ids": [second["id"], first["id"]]},
        format="json",
    )

    assert stale.status_code == 400
    assert stale.json()["task_ids"]["code"] == "task_subtask_order_changed"
    assert reordered.status_code == 200
    assert [item["id"] for item in reordered.json()] == [second["id"], first["id"]]
    assert [
        str(task_id)
        for task_id in Task.objects.filter(parent_id=parent["id"])
        .order_by("position")
        .values_list("id", flat=True)
    ] == [second["id"], first["id"]]


@pytest.mark.django_db(transaction=True)
@override_settings(TASK_MAX_DIRECT_CHILDREN=1)
def test_concurrent_child_creation_cannot_bypass_direct_child_quota():
    user = UserFactory()
    parent = _create(_client(user), "Parent").json()
    barrier = threading.Barrier(2)
    statuses = []

    def create_child(title):
        try:
            client = _client(user)
            barrier.wait(timeout=10)
            statuses.append(_create(client, title, parent["id"]).status_code)
        finally:
            connection.close()

    threads = [
        threading.Thread(target=create_child, args=(f"Child {index}",))
        for index in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert sorted(statuses) == [201, 400]
    assert Task.objects.filter(parent_id=parent["id"]).count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_mutual_moves_leave_one_valid_acyclic_tree():
    user = UserFactory()
    client = _client(user)
    first = _create(client, "First").json()
    second = _create(client, "Second").json()
    barrier = threading.Barrier(2)
    statuses = []

    def move(task_id, parent_id):
        try:
            thread_client = _client(user)
            barrier.wait(timeout=10)
            response = thread_client.patch(
                f"{TASKS_URL}{task_id}/",
                {"parent_id": parent_id},
                format="json",
            )
            statuses.append(response.status_code)
        finally:
            connection.close()

    threads = [
        threading.Thread(target=move, args=(first["id"], second["id"])),
        threading.Thread(target=move, args=(second["id"], first["id"])),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert sorted(statuses) == [200, 400]
    first_parent = Task.objects.get(pk=first["id"]).parent_id
    second_parent = Task.objects.get(pk=second["id"]).parent_id
    assert (first_parent is None) != (second_parent is None)


def _assignee_with_parent(parent_owner):
    """Build a subtask owner who has no direct relationship to the parent."""

    subtask_owner = UserFactory()
    parent = Task.objects.create(
        title="Parent",
        creator=parent_owner,
        assignee=parent_owner,
    )
    child = Task.objects.create(
        title="Child",
        creator=parent_owner,
        assignee=subtask_owner,
        parent=parent,
    )
    child.assignees.add(subtask_owner)
    return parent, child, subtask_owner


def test_upward_visibility_reaches_every_ancestor_but_not_siblings():
    parent_owner = UserFactory()
    root = Task.objects.create(
        title="Root", creator=parent_owner, assignee=parent_owner
    )
    middle = Task.objects.create(
        title="Middle", creator=parent_owner, assignee=parent_owner, parent=root
    )
    leaf = Task.objects.create(
        title="Leaf",
        creator=parent_owner,
        assignee=parent_owner,
        parent=middle,
    )
    sibling = Task.objects.create(
        title="Sibling",
        creator=parent_owner,
        assignee=parent_owner,
        parent=middle,
    )
    reader = UserFactory()
    leaf.assignees.add(reader)
    client = _client(reader)

    detail = client.get(f"{TASKS_URL}{leaf.id}/")

    assert detail.status_code == 200
    assert [node["title"] for node in detail.json()["ancestor_path"]] == [
        "Root",
        "Middle",
        "Leaf",
    ]
    assert client.get(f"{TASKS_URL}{middle.id}/").status_code == 200
    assert client.get(f"{TASKS_URL}{root.id}/").status_code == 200
    # Reading upwards is one-directional: siblings are not part of the chain.
    assert client.get(f"{TASKS_URL}{sibling.id}/").status_code == 404


def test_upward_visibility_is_read_only_for_the_ancestors():
    parent_owner = UserFactory()
    parent, _child, subtask_owner = _assignee_with_parent(parent_owner)
    client = _client(subtask_owner)

    assert client.get(f"{TASKS_URL}{parent.id}/").status_code == 200
    assert client.patch(
        f"{TASKS_URL}{parent.id}/", {"title": "Hijacked"}, format="json"
    ).status_code == 403
    assert client.delete(f"{TASKS_URL}{parent.id}/").status_code == 403
    assert client.post(
        f"{TASKS_URL}{parent.id}/comments/", {"content": "Hi"}, format="json"
    ).status_code == 403
    assert client.post(
        f"{TASKS_URL}{parent.id}/followers/",
        {"follower_ids": [str(subtask_owner.id)]},
        format="json",
    ).status_code == 403
    assert Task.objects.get(pk=parent.id).title == "Parent"


def test_creator_can_assign_a_subtask_without_parent_access():
    organization = OrganizationFactory()
    owner = UserFactory()
    colleague = UserFactory()
    for user in (owner, colleague):
        MembershipFactory(organization=organization, user=user, is_primary=True)
    parent = Task.objects.create(
        title="Private parent", creator=owner, assignee=owner, organization=organization
    )

    created = _client(owner).post(
        TASKS_URL,
        {
            "title": "Delegated child",
            "parent_id": str(parent.id),
            "assignee_ids": [str(colleague.id)],
        },
        format="json",
    )

    assert created.status_code == 201
    colleague_client = _client(colleague)
    assert colleague_client.get(f"{TASKS_URL}{parent.id}/").status_code == 200
    assert colleague_client.get(f"{TASKS_URL}{parent.id}/").json()["can_edit"] is False


@override_settings(TASK_UPWARD_VISIBILITY=False)
def test_upward_visibility_can_be_disabled_at_deploy_time():
    parent_owner = UserFactory()
    parent, child, subtask_owner = _assignee_with_parent(parent_owner)
    client = _client(subtask_owner)

    listing = client.get(
        TASKS_URL, {"scope": "assigned", "status": "all", "time": "all"}
    )
    statistics = client.get(
        f"{TASKS_URL}statistics/", {"scope": "assigned", "status": "all"}
    )

    assert client.get(f"{TASKS_URL}{child.id}/").status_code == 404
    assert client.get(f"{TASKS_URL}{parent.id}/").status_code == 404
    assert listing.json()["results"] == []
    assert statistics.json()["summary"]["total"] == 0


@patch(
    "core.api.tasks._require_conversation_membership",
    side_effect=lambda _user, cid: cid,
)
def test_conversation_share_does_not_grant_upward_visibility(_membership):
    owner = UserFactory()
    viewer = UserFactory()
    parent = Task.objects.create(title="Parent", creator=owner, assignee=owner)
    child = Task.objects.create(
        title="Child", creator=owner, assignee=owner, parent=parent
    )
    # Written directly to reach the state the API refuses to create: the child
    # is shared into a conversation that never received the parent chain.
    TaskConversationShare.objects.create(
        task=child,
        cid="leak-chat",
        shared_by=owner,
    )
    client = _client(viewer)

    assert client.get(
        f"{TASKS_URL}{child.id}/?shared_via=leak-chat"
    ).status_code == 404
    assert client.get(
        f"{TASKS_URL}{parent.id}/?shared_via=leak-chat"
    ).status_code == 404
