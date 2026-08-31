"""API coverage for personal saved task workspace views."""

from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.models import TaskList, TaskListAccess, TaskSavedView

pytestmark = pytest.mark.django_db

URL = "/api/v1.0/task-saved-views/"


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _config(**overrides):
    return {
        "version": 1,
        "scope": "assigned",
        "status": "open",
        "time": "all",
        "priority": "urgent",
        "task_list": "all",
        "ordering": "due_date",
        "view": "list",
        **overrides,
    }


def _member():
    organization = OrganizationFactory()
    user = UserFactory()
    MembershipFactory(user=user, organization=organization, is_primary=True)
    return user, organization


def test_saved_views_are_private_and_support_crud():
    user, organization = _member()
    other = UserFactory()
    MembershipFactory(user=other, organization=organization, is_primary=True)

    created = _client(user).post(
        URL,
        {
            "name": "Urgent work",
            "config": _config(),
            "is_default": True,
            "owner": str(other.id),
        },
        format="json",
    )

    assert created.status_code == 201
    view_id = created.json()["id"]
    assert TaskSavedView.objects.get(pk=view_id).owner == user
    assert created.json()["position"] == 0
    assert _client(other).get(URL).json() == []
    assert _client(other).get(f"{URL}{view_id}/").status_code == 404

    renamed = _client(user).patch(
        f"{URL}{view_id}/", {"name": "Critical work"}, format="json"
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Critical work"
    assert _client(user).delete(f"{URL}{view_id}/").status_code == 204
    assert not TaskSavedView.objects.filter(pk=view_id).exists()


def test_saved_views_are_scoped_to_the_callers_primary_organization():
    user, primary = _member()
    secondary = OrganizationFactory()
    MembershipFactory(user=user, organization=secondary, is_primary=False)
    primary_view = TaskSavedView.objects.create(
        organization=primary, owner=user, name="Primary", config=_config()
    )
    TaskSavedView.objects.create(
        organization=secondary, owner=user, name="Secondary", config=_config()
    )

    response = _client(user).get(URL)

    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == [str(primary_view.id)]


def test_saved_view_validates_names_config_and_visible_task_lists():
    user, organization = _member()
    task_list = TaskList.objects.create(
        organization=organization, creator=user, name="Roadmap"
    )
    TaskListAccess.objects.create(
        task_list=task_list, user=user, role=TaskListAccess.Role.OWNER
    )

    valid = _client(user).post(
        URL,
        {"name": "Roadmap", "config": _config(task_list=str(task_list.id))},
        format="json",
    )
    assert valid.status_code == 201

    duplicate = _client(user).post(
        URL, {"name": " roadmap ", "config": _config()}, format="json"
    )
    assert duplicate.status_code == 400
    assert "name" in duplicate.json()

    invalid_enum = _client(user).post(
        URL,
        {"name": "Bad enum", "config": _config(scope="organization")},
        format="json",
    )
    assert invalid_enum.status_code == 400
    assert "config" in invalid_enum.json()

    hidden_list = _client(user).post(
        URL,
        {"name": "Hidden list", "config": _config(task_list=str(uuid4()))},
        format="json",
    )
    assert hidden_list.status_code == 400


def test_saved_view_accepts_the_unprioritized_filter():
    user, _organization = _member()

    response = _client(user).post(
        URL,
        {"name": "No priority", "config": _config(priority="none")},
        format="json",
    )

    assert response.status_code == 201
    assert response.json()["config"]["priority"] == "none"


def test_saved_view_v2_persists_grouping_and_field_configuration():
    user, _organization = _member()
    config = {
        **_config(),
        "version": 2,
        "grouping": "creator",
        "columns": ["title", "assignee", "completedAt"],
    }

    response = _client(user).post(
        URL,
        {"name": "By creator", "config": config},
        format="json",
    )

    assert response.status_code == 201
    assert response.json()["config"] == config


def test_setting_a_default_view_clears_the_previous_default():
    user, organization = _member()
    first = TaskSavedView.objects.create(
        organization=organization,
        owner=user,
        name="First",
        config=_config(),
        is_default=True,
    )
    second = TaskSavedView.objects.create(
        organization=organization,
        owner=user,
        name="Second",
        config=_config(scope="created"),
    )

    response = _client(user).patch(
        f"{URL}{second.id}/", {"is_default": True}, format="json"
    )

    assert response.status_code == 200
    first.refresh_from_db()
    second.refresh_from_db()
    assert first.is_default is False
    assert second.is_default is True


def test_invalid_saved_task_list_is_safely_replaced_on_read():
    user, organization = _member()
    task_list = TaskList.objects.create(
        organization=organization, creator=user, name="Temporary"
    )
    TaskListAccess.objects.create(
        task_list=task_list, user=user, role=TaskListAccess.Role.OWNER
    )
    view = TaskSavedView.objects.create(
        organization=organization,
        owner=user,
        name="Temporary list",
        config=_config(task_list=str(task_list.id)),
    )
    task_list.is_archived = True
    task_list.save(update_fields=["is_archived", "updated_at"])

    response = _client(user).get(f"{URL}{view.id}/")

    assert response.status_code == 200
    assert response.json()["invalid_task_list"] is True
    assert response.json()["config"]["task_list"] == "all"
    view.refresh_from_db()
    assert view.config["task_list"] == str(task_list.id)


def test_saved_view_limit_is_enforced():
    user, organization = _member()
    TaskSavedView.objects.bulk_create(
        [
            TaskSavedView(
                organization=organization,
                owner=user,
                name=f"View {index}",
                config=_config(),
                position=index,
            )
            for index in range(50)
        ]
    )

    response = _client(user).post(
        URL, {"name": "One too many", "config": _config()}, format="json"
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "You can save at most 50 task views."
