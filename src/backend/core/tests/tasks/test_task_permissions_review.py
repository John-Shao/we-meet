"""Regression scenarios from the task collaboration UX review."""

import pytest

from core import models
from core.services.offboarding import collect_owned_resources
from core.tests.tasks.test_api_task_lists import (
    TASK_LISTS_URL,
    TASKS_URL,
    _client,
    _organization_user,
)

pytestmark = pytest.mark.django_db


def _shared_list():
    organization, owner = _organization_user()
    _, member = _organization_user(organization=organization)
    client = _client(owner)
    data = client.post(TASK_LISTS_URL, {"name": "Review"}, format="json").json()
    task_list = models.TaskList.objects.get(pk=data["id"])
    access = models.TaskListAccess.objects.create(
        task_list=task_list, user=member, role="editor"
    )
    return organization, owner, member, task_list, access


def test_editor_cannot_manage_members_or_delete_others_tasks():
    organization, owner, editor, task_list, _ = _shared_list()
    client = _client(editor)
    task = models.Task.objects.create(
        organization=organization,
        creator=owner,
        task_list=task_list,
        title="Owned work",
    )
    detail = client.get(f"{TASK_LISTS_URL}{task_list.pk}/").json()
    assert detail["can_manage"] is True
    assert detail["can_share"] is False
    task_detail = client.get(f"{TASKS_URL}{task.pk}/").json()
    assert task_detail["can_edit"] is True
    assert task_detail["can_move"] is True
    assert task_detail["can_delete"] is False
    assert client.delete(f"{TASKS_URL}{task.pk}/").status_code == 403
    url = f"{TASK_LISTS_URL}{task_list.pk}/shares/"
    assert client.get(url).status_code == 403
    assert (
        client.post(
            url, {"user_id": str(owner.pk), "role": "viewer"}, format="json"
        ).status_code
        == 403
    )
    assert (
        client.patch(f"{url}{owner.pk}/", {"role": "viewer"}, format="json").status_code
        == 403
    )
    assert client.delete(f"{url}{owner.pk}/").status_code == 403


def test_assignee_can_edit_but_cannot_move_out_of_view_only_list():
    organization, owner, member, task_list, access = _shared_list()
    access.role = "viewer"
    access.save()
    task = models.Task.objects.create(
        organization=organization,
        creator=owner,
        assignee=member,
        task_list=task_list,
        title="Assigned work",
    )
    client = _client(member)
    url = f"{TASKS_URL}{task.pk}/"
    detail = client.get(url).json()
    assert detail["can_edit"] is True
    assert detail["can_move"] is False
    assert client.patch(url, {"title": "Updated"}, format="json").status_code == 200
    assert (
        client.patch(
            url, {"task_list_id": str(task_list.pk)}, format="json"
        ).status_code
        == 200
    )
    assert client.patch(url, {"task_list_id": None}, format="json").status_code == 403
    task.refresh_from_db()
    assert task.task_list == task_list


def test_transfer_then_leave_does_not_restore_creator_ownership():
    _, owner, member, task_list, _ = _shared_list()
    url = f"{TASK_LISTS_URL}{task_list.pk}/"
    client = _client(owner)
    result = client.post(f"{url}transfer/", {"user_id": str(member.pk)}, format="json")
    assert result.status_code == 200
    assert result.json()["access_role"] == "editor"
    assert result.json()["can_share"] is False
    assert _client(member).get(url).json()["access_role"] == "owner"
    assert models.AuditLog.objects.filter(
        action="task_list.transfer", target_id=str(task_list.pk), actor=owner
    ).exists()
    assert client.post(f"{url}leave/").status_code == 204
    assert client.get(url).status_code == 404
    assert client.get(TASK_LISTS_URL).json() == []
    assert client.delete(url).status_code == 404
    assert (
        client.get(
            TASKS_URL, {"scope": "all", "task_list": str(task_list.pk)}
        ).status_code
        == 400
    )


@pytest.mark.parametrize("target", [None, "invalid", "self", "outside", "inactive"])
def test_transfer_rejects_invalid_or_ineligible_targets(target):
    _, owner, member, task_list, _ = _shared_list()
    if target == "self":
        target = str(owner.pk)
    elif target == "outside":
        _, outsider = _organization_user()
        target = str(outsider.pk)
    elif target == "inactive":
        member.is_active = False
        member.save()
        target = str(member.pk)
    response = _client(owner).post(
        f"{TASK_LISTS_URL}{task_list.pk}/transfer/", {"user_id": target}, format="json"
    )
    assert response.status_code == 400
    assert task_list.accesses.get(user=owner).role == "owner"
    assert not models.AuditLog.objects.filter(action="task_list.transfer").exists()


def test_archived_viewer_can_open_filter_and_leave_list():
    organization, owner, viewer, task_list, access = _shared_list()
    task_list.is_archived = True
    task_list.save()
    access.role = "viewer"
    access.save()
    task = models.Task.objects.create(
        organization=organization,
        creator=owner,
        task_list=task_list,
        title="Archived work",
    )
    client = _client(viewer)
    url = f"{TASK_LISTS_URL}{task_list.pk}/"
    assert client.get(url).status_code == 200
    response = client.get(TASKS_URL, {"scope": "all", "task_list": str(task_list.pk)})
    assert response.status_code == 200
    assert response.json()["results"][0]["id"] == str(task.pk)
    assert (
        _client(owner).get(f"{TASKS_URL}{task.pk}/").json()["can_create_subtasks"]
        is False
    )
    assert (
        _client(owner)
        .post(TASKS_URL, {"title": "Child", "parent_id": str(task.pk)}, format="json")
        .status_code
        == 400
    )
    assert client.post(f"{url}leave/").status_code == 204
    assert client.get(url).status_code == 404


def test_deletion_impact_change_requires_new_confirmation_and_keeps_assigned_children():
    organization, owner, member, task_list, _ = _shared_list()
    parent = models.Task.objects.create(
        organization=organization,
        creator=owner,
        task_list=task_list,
        title="Unassigned parent",
    )
    parent.followers.add(member)
    child = models.Task.objects.create(
        organization=organization,
        creator=owner,
        assignee=member,
        task_list=task_list,
        parent=parent,
        title="Assigned child",
    )
    client = _client(owner)
    url = f"{TASK_LISTS_URL}{task_list.pk}/"
    impact = client.get(f"{url}deletion-impact/").json()
    assert impact["count"] == 1
    assert impact["tasks"] == [{"id": str(parent.pk), "title": parent.title}]
    assert (
        client.delete(f"{url}?delete_unassigned=true", format="json").status_code == 409
    )
    parent.title = "Updated scope"
    parent.save()
    assert (
        client.delete(
            f"{url}?delete_unassigned=true",
            {"confirmation_token": impact["token"]},
            format="json",
        ).status_code
        == 409
    )
    assert models.Task.objects.filter(pk=parent.pk).exists()
    current = client.get(f"{url}deletion-impact/").json()
    assert (
        client.delete(
            f"{url}?delete_unassigned=true",
            {"confirmation_token": current["token"]},
            format="json",
        ).status_code
        == 204
    )
    assert not models.Task.objects.filter(pk=parent.pk).exists()
    child.refresh_from_db()
    assert child.parent_id is None
    assert child.task_list_id is None


def test_recovery_is_scoped_audited_and_requires_an_inactive_owner():
    organization, owner, member, task_list, _ = _shared_list()
    _, admin = _organization_user(organization=organization, role="administrator")
    _, foreign_admin = _organization_user(role="administrator")
    client = _client(admin)
    url = f"{TASK_LISTS_URL}{task_list.pk}/"
    assert client.get(url).status_code == 404
    assert client.get(f"{TASK_LISTS_URL}recoverable/").json() == []
    assert client.post(f"{url}takeover/").status_code == 403
    models.Membership.objects.filter(user=owner).update(status="suspended")
    assert client.get(f"{TASK_LISTS_URL}recoverable/").json() == [
        {"id": str(task_list.pk), "name": task_list.name}
    ]
    assert _client(member).post(f"{url}takeover/").status_code == 403
    assert _client(foreign_admin).post(f"{url}takeover/").status_code == 404
    result = client.post(f"{url}takeover/")
    assert result.status_code == 200
    assert result.json()["access_role"] == "owner"
    assert models.AuditLog.objects.filter(
        action="task_list.takeover", actor=admin, target_id=str(task_list.pk)
    ).exists()
    assert client.get(f"{TASK_LISTS_URL}recoverable/").json() == []


def test_offboarding_includes_legacy_owner_with_other_collaborators():
    _, owner, _, task_list, _ = _shared_list()
    task_list.accesses.filter(user=owner).delete()
    resources = collect_owned_resources(models.Membership.objects.get(user=owner))
    assert resources["owned_task_lists"] == [
        {"id": task_list.pk, "name": task_list.name}
    ]
