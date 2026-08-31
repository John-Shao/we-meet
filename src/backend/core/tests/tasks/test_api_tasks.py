"""API coverage for the minimal standalone task module."""

from datetime import date, timedelta
from unittest import mock
from uuid import uuid4
from zoneinfo import ZoneInfo

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import (
    FileFactory,
    MembershipFactory,
    OrganizationFactory,
    RoomFactory,
    UserFactory,
)
from core.models import (
    ActionItem,
    FileTypeChoices,
    FileUploadStateChoices,
    Summary,
    Task,
    TaskActivity,
    TaskAttachment,
    TaskComment,
    TaskConversationShare,
    TaskImDelivery,
    TaskList,
    TaskListAccess,
    TaskPreference,
    TaskReminderPreference,
)

pytestmark = pytest.mark.django_db

TASKS_URL = "/api/v1.0/tasks/"


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def test_task_labels_api_is_removed():
    response = _client(UserFactory()).get("/api/v1.0/task-labels/")

    assert response.status_code == 404


@mock.patch(
    "core.api.tasks._require_conversation_membership",
    side_effect=lambda _user, cid: cid,
)
def test_task_card_share_grants_conversation_read_without_changing_role(
    require_membership,
):
    creator = UserFactory()
    viewer = UserFactory()
    task = Task.objects.create(
        title="Discuss the launch plan",
        creator=creator,
        assignee=creator,
    )
    cid = "b9d15e66-71f0-4fad-aac9-86aa4fc55bd1"

    shared = _client(creator).post(
        f"{TASKS_URL}{task.id}/share/",
        {"conversation_ids": [cid]},
        format="json",
    )

    assert shared.status_code == 200
    assert shared.json() == {"conversation_ids": [cid]}
    assert TaskConversationShare.objects.filter(
        task=task,
        cid=cid,
        shared_by=creator,
    ).exists()
    assert _client(viewer).get(f"{TASKS_URL}{task.id}/").status_code == 404

    detail = _client(viewer).get(f"{TASKS_URL}{task.id}/?shared_via={cid}")
    assert detail.status_code == 200
    assert detail.json()["can_edit"] is False
    assert detail.json()["can_comment"] is False
    assert detail.json()["is_following"] is False

    denied_edit = _client(viewer).patch(
        f"{TASKS_URL}{task.id}/?shared_via={cid}",
        {"title": "Should not change"},
        format="json",
    )
    assert denied_edit.status_code == 404

    followed = _client(viewer).post(f"{TASKS_URL}{task.id}/follow/?shared_via={cid}")
    assert followed.status_code == 200
    assert followed.json()["is_following"] is True
    assert followed.json()["can_comment"] is True
    assert task.followers.filter(id=viewer.id).exists()

    commented = _client(viewer).post(
        f"{TASKS_URL}{task.id}/comments/?shared_via={cid}",
        {"content": "I can help with this."},
        format="json",
    )
    assert commented.status_code == 201
    assert commented.json()["content"] == "I can help with this."
    assert require_membership.call_count >= 3


@mock.patch(
    "core.api.tasks._require_conversation_membership",
    side_effect=lambda _user, cid: cid,
)
def test_conversation_shared_task_lists_shared_subtasks(_membership):
    creator = UserFactory()
    viewer = UserFactory()
    parent = Task.objects.create(title="Parent", creator=creator, assignee=creator)
    child = Task.objects.create(
        title="Child",
        creator=creator,
        assignee=creator,
        parent=parent,
    )
    cid = "task-thread"
    TaskConversationShare.objects.bulk_create(
        [
            TaskConversationShare(task=parent, cid=cid, shared_by=creator),
            TaskConversationShare(task=child, cid=cid, shared_by=creator),
        ]
    )

    response = _client(viewer).get(f"{TASKS_URL}{parent.id}/subtasks/?shared_via={cid}")

    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == [str(child.id)]


@mock.patch(
    "core.api.tasks._require_conversation_membership",
    side_effect=lambda _user, cid: cid,
)
def test_conversation_task_sidebar_lists_only_cards_shared_there(_membership):
    creator = UserFactory()
    first = Task.objects.create(title="First", creator=creator, assignee=creator)
    second = Task.objects.create(title="Second", creator=creator, assignee=creator)
    TaskConversationShare.objects.create(task=first, cid="conversation-a")
    TaskConversationShare.objects.create(task=second, cid="conversation-b")

    response = _client(UserFactory()).get(
        f"{TASKS_URL}conversation/?cid=conversation-a"
    )

    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == [str(first.id)]
    assert response.json()[0]["can_edit"] is False


@mock.patch(
    "core.api.tasks._require_conversation_membership",
    side_effect=lambda _user, cid: cid,
)
def test_share_denies_task_list_viewer(_membership):
    organization = OrganizationFactory()
    creator = UserFactory()
    viewer = UserFactory()
    task_list = TaskList.objects.create(
        organization=organization,
        creator=creator,
        name="Forward guard",
    )
    TaskListAccess.objects.create(
        task_list=task_list,
        user=viewer,
        role=TaskListAccess.Role.VIEWER,
    )
    task = Task.objects.create(
        title="Do not forward",
        creator=creator,
        assignee=creator,
        task_list=task_list,
    )
    cid = "conversation-target"

    client = _client(viewer)
    followed = client.post(f"{TASKS_URL}{task.id}/follow/")
    assert followed.status_code == 200
    assert followed.json()["is_following"] is True

    response = client.post(
        f"{TASKS_URL}{task.id}/share/",
        {"conversation_ids": [cid]},
        format="json",
    )

    assert response.status_code == 403
    assert not TaskConversationShare.objects.filter(task=task, cid=cid).exists()


@mock.patch(
    "core.api.tasks._require_conversation_membership",
    side_effect=lambda _user, cid: cid,
)
def test_parent_candidates_available_for_shared_task(_membership):
    creator = UserFactory()
    viewer = UserFactory()
    task = Task.objects.create(title="Shared root", creator=creator, assignee=creator)
    cid = "shared-thread"
    TaskConversationShare.objects.create(task=task, cid=cid, shared_by=creator)

    response = _client(viewer).get(
        f"{TASKS_URL}{task.id}/parent-candidates/?shared_via={cid}"
    )

    assert response.status_code == 200
    assert response.json() == []


def test_user_creates_personal_task_assigned_to_self():
    user = UserFactory()

    response = _client(user).post(
        TASKS_URL,
        {
            "title": "  Prepare launch  ",
            "description": "Checklist",
            "start_date": "2026-08-20",
            "due_date": "2026-08-31",
        },
        format="json",
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["title"] == "Prepare launch"
    assert payload["creator"]["id"] == str(user.id)
    assert payload["creator"]["avatar_url"] == ""
    assert payload["assignee"]["id"] == str(user.id)
    assert payload["assignee"]["avatar_url"] == ""
    assert [assignee["id"] for assignee in payload["assignees"]] == [str(user.id)]
    assert payload["status"] == Task.Status.TODO
    assert payload["priority"] == Task.Priority.MEDIUM
    assert "labels" not in payload
    assert payload["start_date"] == "2026-08-20"
    assert payload["due_date"] == "2026-08-31"
    assert payload["source_room_id"] is None
    assert payload["source_room_name"] is None
    assert payload["can_edit"] is True
    assert payload["can_update_status"] is True
    assert payload["can_delete"] is True
    task = Task.objects.get()
    assert task.creator == user
    assert task.assignee == user
    assert list(task.assignees.all()) == [user]
    assert task.start_date.isoformat() == "2026-08-20"
    assert task.due_date.isoformat() == "2026-08-31"
    activity = TaskActivity.objects.get()
    assert activity.task == task
    assert activity.actor == user
    assert activity.event == TaskActivity.Event.CREATED
    assert TaskImDelivery.objects.count() == 0


def test_task_without_start_date_defaults_to_creator_current_date():
    user = UserFactory(timezone="UTC")

    response = _client(user).post(
        TASKS_URL,
        {"title": "Start today", "start_date": None},
        format="json",
    )

    assert response.status_code == 201
    assert response.json()["start_date"] == timezone.localdate().isoformat()
    assert Task.objects.get().start_date == timezone.localdate()


def test_task_priority_is_created_validated_and_serialized():
    user = UserFactory()
    client = _client(user)

    response = client.post(
        TASKS_URL,
        {"title": "Production incident", "priority": Task.Priority.URGENT},
        format="json",
    )

    assert response.status_code == 201
    assert response.json()["priority"] == Task.Priority.URGENT
    assert Task.objects.get().priority == Task.Priority.URGENT

    invalid = client.post(
        TASKS_URL,
        {"title": "Invalid priority", "priority": "critical"},
        format="json",
    )
    assert invalid.status_code == 400
    assert "priority" in invalid.json()

    no_priority = client.post(
        TASKS_URL,
        {"title": "No priority is no longer assignable", "priority": "none"},
        format="json",
    )
    assert no_priority.status_code == 400
    assert "priority" in no_priority.json()


def test_task_date_range_must_be_chronological():
    user = UserFactory()

    response = _client(user).post(
        TASKS_URL,
        {
            "title": "Impossible schedule",
            "start_date": "2026-08-31",
            "due_date": "2026-08-20",
        },
        format="json",
    )

    assert response.status_code == 400
    assert "due_date" in response.json()


def test_creator_assigns_task_to_colleague_from_same_organization():
    organization = OrganizationFactory()
    creator = UserFactory()
    colleague = UserFactory()
    MembershipFactory(
        organization=organization,
        user=creator,
        is_primary=True,
    )
    MembershipFactory(
        organization=organization,
        user=colleague,
        is_primary=True,
    )

    response = _client(creator).post(
        TASKS_URL,
        {"title": "Review proposal", "assignee_id": str(colleague.id)},
        format="json",
    )

    assert response.status_code == 201
    assert response.json()["assignee"]["id"] == str(colleague.id)
    assert Task.objects.get().assignee == colleague
    delivery = TaskImDelivery.objects.get()
    assert delivery.recipient == colleague
    assert delivery.event == TaskImDelivery.Event.ASSIGNED
    assert delivery.status == TaskImDelivery.Status.PENDING


def test_creator_assigns_task_to_multiple_colleagues():
    organization = OrganizationFactory()
    creator = UserFactory()
    first = UserFactory(full_name="Ada")
    second = UserFactory(full_name="Grace")
    for user in (creator, first, second):
        MembershipFactory(
            organization=organization,
            user=user,
            is_primary=True,
        )

    response = _client(creator).post(
        TASKS_URL,
        {
            "title": "Ship together",
            "assignee_ids": [str(first.id), str(second.id)],
        },
        format="json",
    )

    assert response.status_code == 201
    task = Task.objects.get()
    assert set(task.assignees.values_list("id", flat=True)) == {first.id, second.id}
    assert {item["id"] for item in response.json()["assignees"]} == {
        str(first.id),
        str(second.id),
    }
    assert set(TaskImDelivery.objects.values_list("recipient_id", flat=True)) == {
        first.id,
        second.id,
    }
    assert _client(first).get(f"{TASKS_URL}{task.id}/").status_code == 200
    assert _client(second).get(f"{TASKS_URL}{task.id}/").status_code == 200

    TaskImDelivery.objects.all().delete()
    changed = _client(creator).patch(
        f"{TASKS_URL}{task.id}/",
        {"priority": Task.Priority.HIGH},
        format="json",
    )
    assert changed.status_code == 200
    assert set(
        TaskImDelivery.objects.filter(
            event=TaskImDelivery.Event.PRIORITY_CHANGED
        ).values_list("recipient_id", flat=True)
    ) == {first.id, second.id}

    completed = _client(first).patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.COMPLETED},
        format="json",
    )
    assert completed.status_code == 200
    assert completed.json()["status"] == Task.Status.COMPLETED


def test_task_rejects_more_than_ten_assignees():
    creator = UserFactory()

    response = _client(creator).post(
        TASKS_URL,
        {
            "title": "Too many owners",
            "assignee_ids": [str(creator.id)] * 11,
        },
        format="json",
    )

    assert response.status_code == 400
    assert "assignee_ids" in response.json()


def test_creator_cannot_assign_task_outside_organization():
    creator = UserFactory()
    outsider = UserFactory()
    MembershipFactory(
        organization=OrganizationFactory(),
        user=creator,
        is_primary=True,
    )
    MembershipFactory(
        organization=OrganizationFactory(),
        user=outsider,
        is_primary=True,
    )

    response = _client(creator).post(
        TASKS_URL,
        {"title": "Private assignment", "assignee_id": str(outsider.id)},
        format="json",
    )

    assert response.status_code == 400
    assert "assignee_id" in response.json()
    assert Task.objects.count() == 0


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


def test_task_followers_are_visible_read_only_collaborators_who_can_comment():
    organization = OrganizationFactory()
    creator = UserFactory()
    assignee = UserFactory()
    follower = UserFactory()
    for user in (creator, assignee, follower):
        MembershipFactory(
            organization=organization,
            user=user,
            is_primary=True,
        )

    created = _client(creator).post(
        TASKS_URL,
        {
            "title": "Publish release notes",
            "assignee_id": str(assignee.id),
            "follower_ids": [str(follower.id)],
        },
        format="json",
    )

    assert created.status_code == 201
    task_id = created.json()["id"]
    assert [item["id"] for item in created.json()["followers"]] == [str(follower.id)]

    detail = _client(follower).get(f"{TASKS_URL}{task_id}/")
    assert detail.status_code == 200
    assert detail.json()["is_following"] is True
    assert detail.json()["can_edit"] is False
    assert detail.json()["can_update_status"] is False
    assert detail.json()["can_delete"] is False
    assert detail.json()["can_comment"] is True
    assert detail.json()["can_manage_attachments"] is False
    assert detail.json()["can_manage_followers"] is False

    following = _client(follower).get(f"{TASKS_URL}?scope=following&status=open")
    assert [item["id"] for item in following.json()["results"]] == [task_id]
    assert (
        _client(follower)
        .patch(
            f"{TASKS_URL}{task_id}/",
            {"title": "Follower edit"},
            format="json",
        )
        .status_code
        == 403
    )
    assert (
        _client(follower)
        .patch(
            f"{TASKS_URL}{task_id}/",
            {"status": Task.Status.COMPLETED},
            format="json",
        )
        .status_code
        == 403
    )
    comment = _client(follower).post(
        f"{TASKS_URL}{task_id}/comments/",
        {"content": "Looks good to me."},
        format="json",
    )
    assert comment.status_code == 201


def test_creator_and_assignee_manage_followers_and_self_follow_is_toggleable():
    organization = OrganizationFactory()
    creator = UserFactory()
    assignee = UserFactory()
    follower = UserFactory()
    other = UserFactory()
    for user in (creator, assignee, follower, other):
        MembershipFactory(organization=organization, user=user, is_primary=True)
    task = Task.objects.create(
        title="Review launch plan",
        creator=creator,
        assignee=assignee,
        organization=organization,
    )

    added = _client(creator).post(
        f"{TASKS_URL}{task.id}/followers/",
        {"follower_ids": [str(follower.id)]},
        format="json",
    )
    assert added.status_code == 200
    assert task.followers.filter(id=follower.id).exists()

    denied = _client(follower).post(
        f"{TASKS_URL}{task.id}/followers/",
        {"follower_ids": [str(other.id)]},
        format="json",
    )
    assert denied.status_code == 403

    removed = _client(assignee).delete(f"{TASKS_URL}{task.id}/followers/{follower.id}/")
    assert removed.status_code == 204
    assert not task.followers.filter(id=follower.id).exists()

    followed = _client(assignee).post(f"{TASKS_URL}{task.id}/follow/")
    assert followed.status_code == 200
    assert followed.json()["is_following"] is True
    unfollowed = _client(assignee).delete(f"{TASKS_URL}{task.id}/follow/")
    assert unfollowed.status_code == 200
    assert unfollowed.json()["is_following"] is False


def test_followers_receive_status_and_durable_deletion_notices_only_while_following():
    creator = UserFactory()
    assignee = UserFactory()
    follower = UserFactory()
    task = Task.objects.create(
        title="Ship the release",
        creator=creator,
        assignee=assignee,
    )
    task.followers.add(follower)

    completed = _client(creator).patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.COMPLETED},
        format="json",
    )
    assert completed.status_code == 200
    assert set(
        TaskImDelivery.objects.filter(
            event=TaskImDelivery.Event.STATUS_CHANGED
        ).values_list("recipient_id", flat=True)
    ) == {assignee.id, follower.id}

    _client(follower).delete(f"{TASKS_URL}{task.id}/follow/")
    reopened = _client(creator).patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.TODO},
        format="json",
    )
    assert reopened.status_code == 200
    latest_activity = TaskActivity.objects.filter(
        task=task,
        event=TaskActivity.Event.STATUS_CHANGED,
    ).latest("created_at")
    assert not TaskImDelivery.objects.filter(
        activity=latest_activity,
        recipient=follower,
    ).exists()

    task.followers.add(follower)
    deleted = _client(creator).delete(f"{TASKS_URL}{task.id}/")
    assert deleted.status_code == 204
    deletion = TaskImDelivery.objects.get(
        event=TaskImDelivery.Event.DELETED,
        recipient=follower,
    )
    assert deletion.task_id is None
    assert deletion.task_title == "Ship the release"
    assert deletion.actor_name


def test_standalone_count_includes_all_visible_tasks_without_a_task_list():
    creator = UserFactory()
    assignee = UserFactory()
    outsider = UserFactory()
    task_list = TaskList.objects.create(
        organization=OrganizationFactory(),
        creator=creator,
        name="Listed work",
    )
    Task.objects.create(title="Created standalone", creator=creator)
    Task.objects.create(
        title="Assigned completed standalone",
        creator=assignee,
        assignee=creator,
        status=Task.Status.COMPLETED,
    )
    Task.objects.create(title="Outsider standalone", creator=outsider)
    Task.objects.create(
        title="Listed task",
        creator=creator,
        task_list=task_list,
    )

    response = _client(creator).get(f"{TASKS_URL}standalone-count/")

    assert response.status_code == 200
    assert response.json() == {"count": 2}


def test_task_list_filters_and_serializes_time_state():
    user = UserFactory(timezone="UTC")
    today = timezone.localdate()
    starting = Task.objects.create(
        title="Starts today",
        creator=user,
        assignee=user,
        start_date=today,
        due_date=today + timedelta(days=3),
    )
    due = Task.objects.create(
        title="Due today",
        creator=user,
        assignee=user,
        due_date=today,
    )
    overdue = Task.objects.create(
        title="Overdue",
        creator=user,
        assignee=user,
        due_date=today - timedelta(days=1),
    )
    one_day = Task.objects.create(
        title="Starts and ends today",
        creator=user,
        assignee=user,
        start_date=today,
        due_date=today,
    )
    Task.objects.create(
        title="Completed overdue",
        creator=user,
        assignee=user,
        due_date=today - timedelta(days=2),
        status=Task.Status.COMPLETED,
    )

    client = _client(user)
    starting_payload = client.get(f"{TASKS_URL}?scope=all&time=starting_today").json()
    due_payload = client.get(f"{TASKS_URL}?scope=all&time=due_today").json()
    overdue_payload = client.get(f"{TASKS_URL}?scope=all&time=overdue").json()

    assert [
        (item["id"], item["time_state"]) for item in starting_payload["results"]
    ] == [(str(starting.id), "starting_today")]
    assert {(item["id"], item["time_state"]) for item in due_payload["results"]} == {
        (str(due.id), "due_today"),
        (str(one_day.id), "due_today"),
    }
    assert [
        (item["id"], item["time_state"]) for item in overdue_payload["results"]
    ] == [(str(overdue.id), "overdue")]
    assert client.get(f"{TASKS_URL}?time=tomorrow").status_code == 400


def test_task_global_search_matches_title_and_description_by_relevance(
    django_assert_max_num_queries,
):
    user = UserFactory()
    description_match = Task.objects.create(
        title="Prepare launch notes",
        description="Review the Search Target with the team",
        creator=user,
    )
    title_contains = Task.objects.create(
        title="A search target review",
        creator=user,
    )
    title_prefix = Task.objects.create(
        title="Search Target follow-up",
        creator=user,
    )
    title_exact = Task.objects.create(title="search target", creator=user)
    Task.objects.create(title="Unrelated task", creator=user)

    client = _client(user)
    with django_assert_max_num_queries(15):
        response = client.get(
            TASKS_URL,
            {"scope": "all", "q": "Search Target"},
        )

    assert response.status_code == 200
    assert [item["id"] for item in response.json()["results"]] == [
        str(title_exact.id),
        str(title_prefix.id),
        str(title_contains.id),
        str(description_match.id),
    ]

    explicit_order = client.get(
        TASKS_URL,
        {"scope": "all", "q": "search target", "ordering": "created_at"},
    )
    assert explicit_order.status_code == 200
    assert [item["id"] for item in explicit_order.json()["results"]] == [
        str(description_match.id),
        str(title_contains.id),
        str(title_prefix.id),
        str(title_exact.id),
    ]


def test_task_global_search_person_filters_use_or_within_and_between_fields():
    viewer = UserFactory()
    second_creator = UserFactory()
    first_assignee = UserFactory()
    second_assignee = UserFactory()
    follower = UserFactory()
    matching = Task.objects.create(title="Matching task", creator=viewer)
    matching.assignees.add(first_assignee)
    matching.followers.add(follower)
    legacy = Task.objects.create(
        title="Legacy matching task",
        creator=second_creator,
        assignee=second_assignee,
    )
    legacy.followers.add(viewer, follower)
    Task.objects.create(title="Wrong people", creator=viewer, assignee=viewer)

    response = _client(viewer).get(
        TASKS_URL,
        {
            "scope": "all",
            "creator_ids": f"{viewer.id},{second_creator.id}",
            "assignee_ids": f"{first_assignee.id},{second_assignee.id}",
            "follower_ids": str(follower.id),
        },
    )

    assert response.status_code == 200
    assert {item["id"] for item in response.json()["results"]} == {
        str(matching.id),
        str(legacy.id),
    }


@mock.patch(
    "core.api.tasks.local_date_for_user",
    return_value=date(2026, 8, 26),
)
def test_task_global_search_due_filters_and_status_composition(local_date):
    user = UserFactory(timezone="Asia/Shanghai")
    # Keep exact-day fixtures distinct from this week's Sunday on every run day.
    today = date(2026, 8, 26)
    tasks = {
        "today": Task.objects.create(title="Due today", creator=user, due_date=today),
        "tomorrow": Task.objects.create(
            title="Due tomorrow", creator=user, due_date=today + timedelta(days=1)
        ),
        "overdue": Task.objects.create(
            title="Due overdue", creator=user, due_date=today - timedelta(days=1)
        ),
        "completed_overdue": Task.objects.create(
            title="Completed overdue",
            creator=user,
            due_date=today - timedelta(days=1),
            status=Task.Status.COMPLETED,
        ),
        "no_date": Task.objects.create(title="No date", creator=user),
    }
    end_of_week = today + timedelta(days=6 - today.weekday())
    this_week = Task.objects.create(
        title="This week", creator=user, due_date=end_of_week
    )

    client = _client(user)
    assert {
        item["id"]
        for item in client.get(TASKS_URL, {"scope": "all", "due": "today"}).json()[
            "results"
        ]
    } == {str(tasks["today"].id)}
    assert {
        item["id"]
        for item in client.get(TASKS_URL, {"scope": "all", "due": "tomorrow"}).json()[
            "results"
        ]
    } == {str(tasks["tomorrow"].id)}
    assert {
        item["id"]
        for item in client.get(TASKS_URL, {"scope": "all", "due": "overdue"}).json()[
            "results"
        ]
    } == {str(tasks["overdue"].id)}
    assert {
        item["id"]
        for item in client.get(TASKS_URL, {"scope": "all", "due": "no_date"}).json()[
            "results"
        ]
    } == {str(tasks["no_date"].id)}
    assert str(this_week.id) in {
        item["id"]
        for item in client.get(
            TASKS_URL, {"scope": "all", "due": "this_week", "status": "todo"}
        ).json()["results"]
    }
    assert local_date.called


def test_task_global_search_visibility_includes_list_members_but_not_card_only():
    organization = OrganizationFactory()
    creator = UserFactory()
    viewer = UserFactory()
    editor = UserFactory()
    outsider = UserFactory()
    task_list = TaskList.objects.create(
        organization=organization,
        creator=creator,
        name="Search list",
    )
    TaskListAccess.objects.create(
        task_list=task_list,
        user=viewer,
        role=TaskListAccess.Role.VIEWER,
    )
    TaskListAccess.objects.create(
        task_list=task_list,
        user=editor,
        role=TaskListAccess.Role.EDITOR,
    )
    listed = Task.objects.create(
        title="Visible search result",
        creator=creator,
        task_list=task_list,
    )
    card_only = Task.objects.create(
        title="Visible search card only",
        creator=creator,
    )
    TaskConversationShare.objects.create(
        task=card_only,
        cid="search-conversation",
        shared_by=creator,
    )

    def search_ids(user):
        response = _client(user).get(
            TASKS_URL,
            {"scope": "all", "q": "Visible search"},
        )
        assert response.status_code == 200
        return {item["id"] for item in response.json()["results"]}

    assert search_ids(viewer) == {str(listed.id)}
    assert search_ids(editor) == {str(listed.id)}
    assert search_ids(outsider) == set()

    card_only.followers.add(viewer)
    assert search_ids(viewer) == {str(listed.id), str(card_only.id)}


@pytest.mark.parametrize(
    ("parameter", "value"),
    [
        ("q", "x"),
        ("q", "  "),
        ("q", "x" * 201),
        ("creator_ids", "not-a-uuid"),
        ("assignee_ids", ",".join(str(uuid4()) for _ in range(21))),
        ("follower_ids", ","),
        ("due", "next_month"),
    ],
)
def test_task_global_search_rejects_invalid_parameters(parameter, value):
    response = _client(UserFactory()).get(
        TASKS_URL,
        {"scope": "all", parameter: value},
    )

    assert response.status_code == 400
    assert parameter in response.json()


def test_task_list_filters_and_orders_by_status_priority_due_date_and_update():
    user = UserFactory(timezone="UTC")
    today = timezone.localdate()
    urgent = Task.objects.create(
        title="Todo urgent",
        creator=user,
        assignee=user,
        priority=Task.Priority.URGENT,
        due_date=today + timedelta(days=9),
    )
    high_older = Task.objects.create(
        title="Todo high older",
        creator=user,
        assignee=user,
        priority=Task.Priority.HIGH,
        due_date=today + timedelta(days=1),
    )
    high_newer = Task.objects.create(
        title="Todo high newer",
        creator=user,
        assignee=user,
        priority=Task.Priority.HIGH,
        due_date=today + timedelta(days=1),
    )
    tied_high_tasks = [
        Task.objects.create(
            title=f"Todo high tied {index}",
            creator=user,
            assignee=user,
            priority=Task.Priority.HIGH,
            due_date=today + timedelta(days=2),
        )
        for index in range(2)
    ]
    fixed_updated_at = timezone.now() - timedelta(days=1)
    Task.objects.filter(pk=high_older.pk).update(
        updated_at=fixed_updated_at - timedelta(hours=1)
    )
    Task.objects.filter(pk=high_newer.pk).update(updated_at=fixed_updated_at)
    Task.objects.filter(pk__in=[task.pk for task in tied_high_tasks]).update(
        updated_at=fixed_updated_at
    )
    no_priority = Task.objects.create(
        title="Todo no priority",
        creator=user,
        assignee=user,
    )
    completed = Task.objects.create(
        title="Completed urgent",
        creator=user,
        assignee=user,
        status=Task.Status.COMPLETED,
        priority=Task.Priority.URGENT,
    )
    response = _client(user).get(f"{TASKS_URL}?scope=all&priority=all")

    assert response.status_code == 200
    assert [item["id"] for item in response.json()["results"]] == [
        str(urgent.id),
        str(high_newer.id),
        str(high_older.id),
        *sorted(str(task.id) for task in tied_high_tasks),
        str(no_priority.id),
        str(completed.id),
    ]
    high_response = _client(user).get(f"{TASKS_URL}?scope=all&priority=high")
    assert [item["id"] for item in high_response.json()["results"]] == [
        str(high_newer.id),
        str(high_older.id),
        *sorted(str(task.id) for task in tied_high_tasks),
    ]
    invalid = _client(user).get(f"{TASKS_URL}?priority=critical")
    assert invalid.status_code == 400
    assert "priority" in invalid.json()


def test_task_list_orders_priority_and_status_by_business_rank():
    user = UserFactory()
    priorities = {
        priority: Task.objects.create(
            title=priority,
            creator=user,
            assignee=user,
            priority=priority,
        )
        for priority in Task.Priority.values
    }

    client = _client(user)
    ascending = client.get(f"{TASKS_URL}?scope=all&ordering=priority")
    descending = client.get(f"{TASKS_URL}?scope=all&ordering=-priority")

    assert ascending.status_code == 200
    assert [item["id"] for item in ascending.json()["results"]] == [
        str(priorities[Task.Priority.URGENT].id),
        str(priorities[Task.Priority.HIGH].id),
        str(priorities[Task.Priority.MEDIUM].id),
        str(priorities[Task.Priority.LOW].id),
        str(priorities[Task.Priority.NONE].id),
    ]
    assert [item["id"] for item in descending.json()["results"]] == [
        str(priorities[Task.Priority.LOW].id),
        str(priorities[Task.Priority.MEDIUM].id),
        str(priorities[Task.Priority.HIGH].id),
        str(priorities[Task.Priority.URGENT].id),
        str(priorities[Task.Priority.NONE].id),
    ]

    Task.objects.all().delete()
    statuses = {
        task_status: Task.objects.create(
            title=task_status,
            creator=user,
            assignee=user,
            status=task_status,
        )
        for task_status in Task.Status.values
    }
    ascending = client.get(f"{TASKS_URL}?scope=all&ordering=status")
    descending = client.get(f"{TASKS_URL}?scope=all&ordering=-status")

    assert [item["id"] for item in ascending.json()["results"]] == [
        str(statuses[Task.Status.TODO].id),
        str(statuses[Task.Status.COMPLETED].id),
    ]
    assert [item["id"] for item in descending.json()["results"]] == [
        str(statuses[Task.Status.COMPLETED].id),
        str(statuses[Task.Status.TODO].id),
    ]


def test_task_list_orders_people_by_display_name_with_empty_values_last():
    viewer = UserFactory(full_name="Viewer")
    alpha = UserFactory(full_name="", short_name="Alpha")
    zulu = UserFactory(full_name="zulu")
    assigned_alpha = Task.objects.create(
        title="Assigned Alpha", creator=viewer, assignee=alpha
    )
    assigned_zulu = Task.objects.create(
        title="Assigned Zulu", creator=viewer, assignee=zulu
    )
    unassigned = Task.objects.create(title="Unassigned", creator=viewer)
    created_alpha = Task.objects.create(
        title="Created Alpha", creator=alpha, assignee=viewer
    )
    created_zulu = Task.objects.create(
        title="Created Zulu", creator=zulu, assignee=viewer
    )

    client = _client(viewer)
    assignees = client.get(f"{TASKS_URL}?scope=created&ordering=assignee")
    creators = client.get(f"{TASKS_URL}?scope=assigned&ordering=-creator")

    assert assignees.status_code == 200
    assert [item["id"] for item in assignees.json()["results"]] == [
        str(assigned_alpha.id),
        str(assigned_zulu.id),
        str(unassigned.id),
    ]
    assert [item["id"] for item in creators.json()["results"]] == [
        str(created_zulu.id),
        str(created_alpha.id),
    ]


def test_task_list_orders_dates_with_empty_values_last_and_validates_field():
    user = UserFactory()
    today = timezone.localdate()
    early = Task.objects.create(
        title="Early",
        creator=user,
        assignee=user,
        start_date=today,
        due_date=today + timedelta(days=1),
    )
    late = Task.objects.create(
        title="Late",
        creator=user,
        assignee=user,
        start_date=today + timedelta(days=2),
        due_date=today + timedelta(days=3),
    )
    empty = Task.objects.create(
        title="Empty", creator=user, assignee=user, start_date=None, due_date=None
    )
    Task.objects.filter(pk=early.pk).update(
        created_at=timezone.now() - timedelta(days=2)
    )
    Task.objects.filter(pk=late.pk).update(
        created_at=timezone.now() - timedelta(days=1)
    )

    client = _client(user)
    for field in ("start_date", "due_date"):
        ascending = client.get(f"{TASKS_URL}?scope=all&ordering={field}")
        descending = client.get(f"{TASKS_URL}?scope=all&ordering=-{field}")
        assert [item["id"] for item in ascending.json()["results"]] == [
            str(early.id),
            str(late.id),
            str(empty.id),
        ]
        assert [item["id"] for item in descending.json()["results"]] == [
            str(late.id),
            str(early.id),
            str(empty.id),
        ]

    newest = client.get(f"{TASKS_URL}?scope=all&ordering=-created_at")
    assert [item["id"] for item in newest.json()["results"]] == [
        str(empty.id),
        str(late.id),
        str(early.id),
    ]
    invalid = client.get(f"{TASKS_URL}?scope=all&ordering=-updated_at")
    assert invalid.status_code == 400
    assert "ordering" in invalid.json()


def test_task_priority_filter_combines_with_time_filter():
    user = UserFactory(timezone="UTC")
    today = timezone.localdate()
    urgent = Task.objects.create(
        title="Urgent today",
        creator=user,
        assignee=user,
        priority=Task.Priority.URGENT,
        due_date=today,
    )
    Task.objects.create(
        title="Low today",
        creator=user,
        assignee=user,
        priority=Task.Priority.LOW,
        due_date=today,
    )

    response = _client(user).get(
        f"{TASKS_URL}?scope=all&time=due_today&priority=urgent"
    )

    assert response.status_code == 200
    assert [item["id"] for item in response.json()["results"]] == [str(urgent.id)]


def test_task_time_filter_uses_current_viewer_timezone():
    now = timezone.now()
    creator_today = timezone.localdate(now, timezone=ZoneInfo("UTC"))
    assignee_timezone = next(
        zone
        for zone in ("Pacific/Kiritimati", "Etc/GMT+12")
        if timezone.localdate(now, timezone=ZoneInfo(zone)) != creator_today
    )
    assignee_today = timezone.localdate(now, timezone=ZoneInfo(assignee_timezone))
    creator = UserFactory(timezone="UTC")
    assignee = UserFactory(timezone=assignee_timezone)
    task = Task.objects.create(
        title="Starts in assignee timezone",
        creator=creator,
        assignee=assignee,
        start_date=assignee_today,
    )

    creator_response = _client(creator).get(
        f"{TASKS_URL}?scope=created&time=starting_today"
    )
    assignee_response = _client(assignee).get(
        f"{TASKS_URL}?scope=assigned&time=starting_today"
    )

    assert creator_response.status_code == 200
    assert creator_response.json()["results"] == []
    assert assignee_response.status_code == 200
    assert [
        (item["id"], item["time_state"]) for item in assignee_response.json()["results"]
    ] == [(str(task.id), "starting_today")]


def test_assignee_can_advance_status_and_edit_task_details():
    creator = UserFactory()
    assignee = UserFactory()
    task = Task.objects.create(title="Follow up", creator=creator, assignee=assignee)
    client = _client(assignee)

    response = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.COMPLETED},
        format="json",
    )
    assert response.status_code == 200
    assert response.json()["status"] == Task.Status.COMPLETED
    assert response.json()["can_edit"] is True
    assert response.json()["can_update_status"] is True
    activity = TaskActivity.objects.get()
    assert activity.actor == assignee
    assert activity.event == TaskActivity.Event.STATUS_CHANGED
    assert activity.changes == {
        "status": {"from": Task.Status.TODO, "to": Task.Status.COMPLETED}
    }
    delivery = TaskImDelivery.objects.get(activity=activity)
    assert delivery.recipient == creator
    assert delivery.event == TaskImDelivery.Event.STATUS_CHANGED

    response = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"title": "Changed by assignee"},
        format="json",
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Changed by assignee"

    response = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"priority": Task.Priority.HIGH},
        format="json",
    )
    assert response.status_code == 200
    assert response.json()["priority"] == Task.Priority.HIGH


def test_assignee_cannot_delete_task():
    creator = UserFactory()
    assignee = UserFactory()
    task = Task.objects.create(
        title="Creator-controlled deletion",
        creator=creator,
        assignee=assignee,
    )
    client = _client(assignee)

    response = client.delete(f"{TASKS_URL}{task.id}/")

    assert response.status_code == 403
    assert Task.objects.filter(pk=task.pk).exists()


def test_creator_can_delete_task():
    creator = UserFactory()
    task = Task.objects.create(title="Delete duplicate", creator=creator)

    response = _client(creator).delete(f"{TASKS_URL}{task.id}/")

    assert response.status_code == 204
    assert not Task.objects.filter(pk=task.pk).exists()


def test_deleting_linked_task_clears_action_item_link():
    creator = UserFactory()
    action_item = ActionItem.objects.create(
        room=RoomFactory(users=[(creator, "owner")]),
        content="Publish decisions",
        status=ActionItem.Status.CONFIRMED,
        assignee=creator,
    )
    task = Task.objects.create(
        title=action_item.content,
        creator=creator,
        assignee=creator,
        source_action_item=action_item,
    )
    action_item.task_id = task.id
    action_item.save(update_fields=["task_id", "updated_at"])

    response = _client(creator).delete(f"{TASKS_URL}{task.id}/")

    assert response.status_code == 204
    action_item.refresh_from_db()
    assert action_item.task_id is None


def test_creator_status_change_notifies_other_assignee():
    creator = UserFactory()
    assignee = UserFactory()
    task = Task.objects.create(
        title="Complete duplicate work",
        creator=creator,
        assignee=assignee,
    )

    response = _client(creator).patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.COMPLETED},
        format="json",
    )

    assert response.status_code == 200
    activity = TaskActivity.objects.get(event=TaskActivity.Event.STATUS_CHANGED)
    delivery = TaskImDelivery.objects.get(activity=activity)
    assert delivery.recipient == assignee
    assert delivery.event == TaskImDelivery.Event.STATUS_CHANGED

    reopen_response = _client(creator).patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.TODO},
        format="json",
    )
    assert reopen_response.status_code == 200
    assert reopen_response.json()["status"] == Task.Status.TODO
    assert reopen_response.json()["can_update_status"] is True


def test_creator_reassigns_task_and_visibility_follows_assignee():
    organization = OrganizationFactory()
    creator = UserFactory()
    previous_assignee = UserFactory()
    next_assignee = UserFactory()
    for user in (creator, previous_assignee, next_assignee):
        MembershipFactory(
            organization=organization,
            user=user,
            is_primary=True,
        )
    task = Task.objects.create(
        title="Prepare report",
        creator=creator,
        assignee=previous_assignee,
        due_date="2026-08-25",
    )

    response = _client(creator).patch(
        f"{TASKS_URL}{task.id}/",
        {
            "assignee_id": str(next_assignee.id),
            "due_date": "2026-08-30",
            "priority": Task.Priority.HIGH,
            "status": Task.Status.COMPLETED,
        },
        format="json",
    )

    assert response.status_code == 200
    assert response.json()["assignee"]["id"] == str(next_assignee.id)
    assert response.json()["priority"] == Task.Priority.HIGH
    delivery = TaskImDelivery.objects.get()
    assert delivery.recipient == next_assignee
    assert delivery.event == TaskImDelivery.Event.REASSIGNED
    activity = TaskActivity.objects.get(event=TaskActivity.Event.ASSIGNEE_CHANGED)
    assert activity.actor == creator
    assert activity.event == TaskActivity.Event.ASSIGNEE_CHANGED
    assert activity.changes["assignee"]["from"]["id"] == str(previous_assignee.id)
    assert activity.changes["assignee"]["to"]["id"] == str(next_assignee.id)
    date_activity = TaskActivity.objects.get(event=TaskActivity.Event.DATES_CHANGED)
    assert date_activity.changes["dates"]["due_date"] == {
        "from": "2026-08-25",
        "to": "2026-08-30",
    }
    assert not TaskImDelivery.objects.filter(
        event=TaskImDelivery.Event.DATES_CHANGED
    ).exists()
    assert not TaskImDelivery.objects.filter(
        event=TaskImDelivery.Event.STATUS_CHANGED
    ).exists()
    assert not TaskImDelivery.objects.filter(
        event=TaskImDelivery.Event.PRIORITY_CHANGED
    ).exists()
    assert TaskActivity.objects.filter(
        event=TaskActivity.Event.PRIORITY_CHANGED,
        changes={
            "priority": {
                "from": Task.Priority.MEDIUM,
                "to": Task.Priority.HIGH,
            }
        },
    ).exists()
    assert TaskActivity.objects.filter(
        event=TaskActivity.Event.STATUS_CHANGED,
        changes={"status": {"from": Task.Status.TODO, "to": Task.Status.COMPLETED}},
    ).exists()
    assert _client(previous_assignee).get(f"{TASKS_URL}{task.id}/").status_code == 404
    assert _client(next_assignee).get(f"{TASKS_URL}{task.id}/").status_code == 200


def test_creator_edits_content_and_completion_timestamp():
    creator = UserFactory()
    task = Task.objects.create(title="Draft", creator=creator, assignee=creator)
    client = _client(creator)

    completed = client.patch(
        f"{TASKS_URL}{task.id}/",
        {
            "title": "Final draft",
            "start_date": "2026-08-20",
            "due_date": "2026-08-25",
            "status": Task.Status.COMPLETED,
        },
        format="json",
    )
    assert completed.status_code == 200
    assert completed.json()["title"] == "Final draft"
    assert completed.json()["start_date"] == "2026-08-20"
    assert completed.json()["due_date"] == "2026-08-25"
    assert completed.json()["completed_at"] is not None
    assert list(TaskActivity.objects.values_list("event", flat=True)) == [
        TaskActivity.Event.CONTENT_CHANGED,
        TaskActivity.Event.DATES_CHANGED,
        TaskActivity.Event.STATUS_CHANGED,
    ]

    reopened = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.TODO},
        format="json",
    )
    assert reopened.status_code == 200
    assert reopened.json()["completed_at"] is None
    assert (
        TaskActivity.objects.filter(event=TaskActivity.Event.STATUS_CHANGED).count()
        == 2
    )

    activity_count = TaskActivity.objects.count()
    unchanged = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"title": "Final draft"},
        format="json",
    )
    assert unchanged.status_code == 200
    assert TaskActivity.objects.count() == activity_count
    assert TaskImDelivery.objects.count() == 0


def test_creator_priority_change_records_history_and_notifies_assignee(
    django_capture_on_commit_callbacks,
):
    creator = UserFactory()
    assignee = UserFactory()
    task = Task.objects.create(
        title="Escalate customer issue",
        creator=creator,
        assignee=assignee,
    )

    with (
        mock.patch("core.services.task_notifications._enqueue_delivery") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        changed = _client(creator).patch(
            f"{TASKS_URL}{task.id}/",
            {"priority": Task.Priority.URGENT},
            format="json",
        )
        unchanged = _client(creator).patch(
            f"{TASKS_URL}{task.id}/",
            {"priority": Task.Priority.URGENT},
            format="json",
        )

    assert changed.status_code == 200
    assert changed.json()["priority"] == Task.Priority.URGENT
    assert unchanged.status_code == 200
    activity = TaskActivity.objects.get(event=TaskActivity.Event.PRIORITY_CHANGED)
    assert activity.changes == {
        "priority": {"from": Task.Priority.MEDIUM, "to": Task.Priority.URGENT}
    }
    delivery = TaskImDelivery.objects.get(activity=activity)
    assert delivery.recipient == assignee
    assert delivery.event == TaskImDelivery.Event.PRIORITY_CHANGED
    enqueue.assert_called_once_with(delivery.id)


def test_creator_date_change_notifies_other_assignee(
    django_capture_on_commit_callbacks,
):
    creator = UserFactory()
    assignee = UserFactory()
    task = Task.objects.create(
        title="Customer rollout",
        creator=creator,
        assignee=assignee,
        start_date="2026-08-20",
        due_date="2026-08-25",
    )

    with (
        mock.patch("core.services.task_notifications._enqueue_delivery") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        changed = _client(creator).patch(
            f"{TASKS_URL}{task.id}/",
            {"start_date": "2026-08-22", "due_date": "2026-08-30"},
            format="json",
        )
        unchanged = _client(creator).patch(
            f"{TASKS_URL}{task.id}/",
            {"due_date": "2026-08-30"},
            format="json",
        )

    assert changed.status_code == 200
    assert unchanged.status_code == 200
    activity = TaskActivity.objects.get(event=TaskActivity.Event.DATES_CHANGED)
    assert activity.changes == {
        "dates": {
            "start_date": {"from": "2026-08-20", "to": "2026-08-22"},
            "due_date": {"from": "2026-08-25", "to": "2026-08-30"},
        }
    }
    delivery = TaskImDelivery.objects.get(activity=activity)
    assert delivery.task == task
    assert delivery.recipient == assignee
    assert delivery.event == TaskImDelivery.Event.DATES_CHANGED
    enqueue.assert_called_once_with(delivery.id)


def test_invalid_status_transition_is_rejected():
    user = UserFactory()
    task = Task.objects.create(
        title="Done", creator=user, assignee=user, status=Task.Status.COMPLETED
    )

    response = _client(user).patch(
        f"{TASKS_URL}{task.id}/",
        {"status": "in_progress"},
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


def test_related_users_can_read_task_activities_but_outsider_cannot():
    creator = UserFactory()
    assignee = UserFactory()
    outsider = UserFactory()
    task = Task.objects.create(title="Audited", creator=creator, assignee=assignee)
    created = TaskActivity.objects.create(
        task=task,
        actor=creator,
        event=TaskActivity.Event.CREATED,
    )
    changed = TaskActivity.objects.create(
        task=task,
        actor=assignee,
        event=TaskActivity.Event.STATUS_CHANGED,
        changes={"status": {"from": "todo", "to": "in_progress"}},
    )
    url = f"{TASKS_URL}{task.id}/activities/"

    creator_response = _client(creator).get(url)
    assignee_response = _client(assignee).get(url)
    outsider_response = _client(outsider).get(url)

    assert creator_response.status_code == 200
    assert [entry["id"] for entry in creator_response.json()] == [
        str(changed.id),
        str(created.id),
    ]
    assert creator_response.json()[0]["actor"]["id"] == str(assignee.id)
    assert assignee_response.status_code == 200
    assert outsider_response.status_code == 404


def test_activity_feed_is_paginated_and_only_contains_visible_tasks():
    viewer = UserFactory()
    collaborator = UserFactory()
    outsider = UserFactory()
    visible = Task.objects.create(
        title="Visible task",
        creator=collaborator,
        assignee=viewer,
    )
    private = Task.objects.create(
        title="Private task",
        creator=outsider,
        assignee=outsider,
    )
    older = TaskActivity.objects.create(
        task=visible,
        actor=collaborator,
        event=TaskActivity.Event.CREATED,
    )
    newer = TaskActivity.objects.create(
        task=visible,
        actor=viewer,
        event=TaskActivity.Event.STATUS_CHANGED,
    )
    TaskActivity.objects.create(
        task=private,
        actor=outsider,
        event=TaskActivity.Event.CREATED,
    )

    first_page = _client(viewer).get(f"{TASKS_URL}activity/?page_size=1")
    second_page = _client(viewer).get(f"{TASKS_URL}activity/?page_size=1&page=2")

    assert first_page.status_code == 200
    assert first_page.json()["count"] == 2
    first_entry = first_page.json()["results"][0]
    assert first_entry["id"] == str(newer.id)
    assert first_entry["task_id"] == str(visible.id)
    assert first_entry["task_title"] == "Visible task"
    assert first_entry["actor"]["id"] == str(viewer.id)
    assert first_entry["event"] == TaskActivity.Event.STATUS_CHANGED
    assert first_entry["changes"] == {}
    assert first_page.json()["next"] is not None
    assert [entry["id"] for entry in second_page.json()["results"]] == [str(older.id)]
    assert second_page.json()["next"] is None


def test_task_settings_are_persisted_per_user_and_validated():
    user = UserFactory()
    other = UserFactory()
    url = f"{TASKS_URL}settings/"
    task = Task.objects.create(title="Pending reminder", creator=user, assignee=user)
    delivery = TaskImDelivery.objects.create(
        task=task,
        recipient=user,
        event=TaskImDelivery.Event.DUE_TODAY,
        reference_date=timezone.localdate(),
        next_attempt_at=timezone.now(),
    )

    defaults = _client(user).get(url)
    updated = _client(user).patch(
        url,
        {
            "daily_reminder_enabled": False,
            "overdue_marker_enabled": False,
            "default_reminder_minutes": 1440,
        },
        format="json",
    )
    other_defaults = _client(other).get(url)
    invalid = _client(user).patch(
        url,
        {"default_reminder_minutes": 17},
        format="json",
    )

    assert defaults.status_code == 200
    assert defaults.json() == {
        "daily_reminder_enabled": True,
        "overdue_marker_enabled": True,
        "default_reminder_minutes": 0,
    }
    assert updated.status_code == 200
    assert updated.json() == {
        "daily_reminder_enabled": False,
        "overdue_marker_enabled": False,
        "default_reminder_minutes": 1440,
    }
    assert other_defaults.json() == defaults.json()
    assert invalid.status_code == 400
    assert TaskPreference.objects.get(user=user).daily_reminder_enabled is False
    delivery.refresh_from_db()
    assert delivery.status == TaskImDelivery.Status.SUPERSEDED


def test_task_reminder_preferences_are_private_to_each_assignee():
    creator = UserFactory()
    first = UserFactory()
    second = UserFactory()
    viewer = UserFactory()
    task = Task.objects.create(title="Shared deadline", creator=creator, assignee=first)
    task.assignees.add(first, second)
    task.followers.add(viewer)
    TaskPreference.objects.create(user=first, default_reminder_minutes=1440)
    url = f"{TASKS_URL}{task.id}/reminder/"
    pending = TaskImDelivery.objects.create(
        task=task,
        recipient=first,
        event=TaskImDelivery.Event.DUE_SOON,
        reference_date=timezone.localdate() + timedelta(days=1),
        next_attempt_at=timezone.now(),
    )

    defaults = _client(first).get(url)
    updated = _client(first).patch(
        url,
        {"enabled": False, "reminder_minutes": 4320},
        format="json",
    )
    second_defaults = _client(second).get(url)
    invalid = _client(second).patch(
        url,
        {"reminder_minutes": 60},
        format="json",
    )
    forbidden = _client(viewer).get(url)

    assert defaults.status_code == 200
    assert defaults.json() == {
        "enabled": True,
        "reminder_minutes": None,
        "effective_reminder_minutes": 1440,
        "global_reminders_enabled": True,
    }
    assert updated.status_code == 200
    assert updated.json() == {
        "enabled": False,
        "reminder_minutes": 4320,
        "effective_reminder_minutes": 4320,
        "global_reminders_enabled": True,
    }
    assert second_defaults.json() == {
        "enabled": True,
        "reminder_minutes": None,
        "effective_reminder_minutes": 0,
        "global_reminders_enabled": True,
    }
    assert invalid.status_code == 400
    assert forbidden.status_code == 403
    assert TaskReminderPreference.objects.filter(task=task).count() == 1
    assert TaskReminderPreference.objects.get(task=task, user=first).enabled is False
    pending.refresh_from_db()
    assert pending.status == TaskImDelivery.Status.SUPERSEDED


def test_creator_and_assignee_can_post_and_list_task_comments():
    creator = UserFactory()
    assignee = UserFactory()
    task = Task.objects.create(title="Discuss", creator=creator, assignee=assignee)
    url = f"{TASKS_URL}{task.id}/comments/"

    first = _client(creator).post(
        url,
        {"content": "  Initial context  "},
        format="json",
    )
    second = _client(assignee).post(
        url,
        {"content": "I will follow up."},
        format="json",
    )
    response = _client(creator).get(url)

    assert first.status_code == 201
    assert first.json()["content"] == "Initial context"
    assert first.json()["author"]["id"] == str(creator.id)
    assert second.status_code == 201
    assert response.status_code == 200
    assert [entry["id"] for entry in response.json()] == [
        first.json()["id"],
        second.json()["id"],
    ]
    assert list(TaskComment.objects.values_list("content", flat=True)) == [
        "Initial context",
        "I will follow up.",
    ]
    assert list(
        TaskImDelivery.objects.order_by("created_at").values_list(
            "event", "recipient_id", "comment__content"
        )
    ) == [
        (TaskImDelivery.Event.COMMENTED, assignee.id, "Initial context"),
        (TaskImDelivery.Event.COMMENTED, creator.id, "I will follow up."),
    ]


def test_personal_task_comment_does_not_notify_the_author():
    user = UserFactory()
    task = Task.objects.create(title="Private notes", creator=user, assignee=user)

    response = _client(user).post(
        f"{TASKS_URL}{task.id}/comments/",
        {"content": "Remember the acceptance criteria."},
        format="json",
    )

    assert response.status_code == 201
    assert TaskComment.objects.count() == 1
    assert TaskImDelivery.objects.count() == 0


def test_task_comments_reject_blank_content_and_outsiders():
    creator = UserFactory()
    outsider = UserFactory()
    task = Task.objects.create(title="Private", creator=creator, assignee=creator)
    url = f"{TASKS_URL}{task.id}/comments/"

    blank = _client(creator).post(url, {"content": "   "}, format="json")
    outsider_list = _client(outsider).get(url)
    outsider_post = _client(outsider).post(
        url,
        {"content": "Not allowed"},
        format="json",
    )

    assert blank.status_code == 400
    assert outsider_list.status_code == 404
    assert outsider_post.status_code == 404
    assert TaskComment.objects.count() == 0


def test_task_collaborators_can_attach_and_list_ready_uploads():
    creator = UserFactory()
    assignee = UserFactory()
    outsider = UserFactory()
    task = Task.objects.create(
        title="Prepare evidence",
        creator=creator,
        assignee=assignee,
    )
    file = FileFactory(
        creator=creator,
        type=FileTypeChoices.TASK_ATTACHMENT,
        filename="evidence.pdf",
        mimetype="application/pdf",
        size=2048,
        update_upload_state=FileUploadStateChoices.READY,
    )
    url = f"{TASKS_URL}{task.id}/attachments/"

    created = _client(creator).post(
        url,
        {"file_id": str(file.id)},
        format="json",
    )
    listed = _client(assignee).get(url)
    outsider_response = _client(outsider).get(url)

    assert created.status_code == 201
    assert created.json()["file_id"] == str(file.id)
    assert created.json()["filename"] == "evidence.pdf"
    assert listed.status_code == 200
    assert [entry["id"] for entry in listed.json()] == [created.json()["id"]]
    assert outsider_response.status_code == 404
    attachment = TaskAttachment.objects.get()
    assert attachment.task == task
    assert attachment.file == file
    assert attachment.uploader == creator


@pytest.mark.parametrize(
    "file_overrides",
    [
        {"type": FileTypeChoices.BACKGROUND_IMAGE},
        {"upload_state": FileUploadStateChoices.PENDING},
    ],
)
def test_task_attachment_rejects_wrong_type_or_pending_upload(file_overrides):
    user = UserFactory()
    task = Task.objects.create(title="Private", creator=user, assignee=user)
    defaults = {
        "creator": user,
        "type": FileTypeChoices.TASK_ATTACHMENT,
        "upload_state": FileUploadStateChoices.READY,
    }
    file = FileFactory(**(defaults | file_overrides))

    response = _client(user).post(
        f"{TASKS_URL}{task.id}/attachments/",
        {"file_id": str(file.id)},
        format="json",
    )

    assert response.status_code == 400
    assert TaskAttachment.objects.count() == 0


def test_task_attachment_rejects_upload_owned_by_another_user():
    creator = UserFactory()
    other_user = UserFactory()
    task = Task.objects.create(title="Private", creator=creator, assignee=creator)
    file = FileFactory(
        creator=other_user,
        type=FileTypeChoices.TASK_ATTACHMENT,
        update_upload_state=FileUploadStateChoices.READY,
    )

    response = _client(creator).post(
        f"{TASKS_URL}{task.id}/attachments/",
        {"file_id": str(file.id)},
        format="json",
    )

    assert response.status_code == 400
    assert TaskAttachment.objects.count() == 0


def test_task_attachment_media_access_follows_current_assignee():
    creator = UserFactory()
    former_assignee = UserFactory()
    current_assignee = UserFactory()
    task = Task.objects.create(
        title="Handover",
        creator=creator,
        assignee=former_assignee,
    )
    file = FileFactory(
        creator=creator,
        type=FileTypeChoices.TASK_ATTACHMENT,
        update_upload_state=FileUploadStateChoices.READY,
    )
    TaskAttachment.objects.create(task=task, file=file, uploader=creator)
    original_url = f"http://localhost/media/{file.file_key:s}"

    assert (
        _client(former_assignee)
        .get(
            "/api/v1.0/files/media-auth/",
            HTTP_X_ORIGINAL_URL=original_url,
        )
        .status_code
        == 200
    )

    task.assignee = current_assignee
    task.save(update_fields=["assignee", "updated_at"])

    assert (
        _client(former_assignee)
        .get(
            "/api/v1.0/files/media-auth/",
            HTTP_X_ORIGINAL_URL=original_url,
        )
        .status_code
        == 403
    )
    assert (
        _client(current_assignee)
        .get(
            "/api/v1.0/files/media-auth/",
            HTTP_X_ORIGINAL_URL=original_url,
        )
        .status_code
        == 200
    )


def test_task_attachment_url_and_download_access_follow_current_assignee():
    creator = UserFactory()
    former_assignee = UserFactory()
    current_assignee = UserFactory()
    outsider = UserFactory()
    task = Task.objects.create(
        title="Handover", creator=creator, assignee=former_assignee
    )
    file = FileFactory(
        creator=creator,
        type=FileTypeChoices.TASK_ATTACHMENT,
        storage_bucket="we-task-attachment",
        update_upload_state=FileUploadStateChoices.READY,
    )
    attachment = TaskAttachment.objects.create(task=task, file=file, uploader=creator)
    url = f"{TASKS_URL}{task.id}/attachments/{attachment.id}/download/"

    listed = _client(creator).get(f"{TASKS_URL}{task.id}/attachments/")
    assert listed.status_code == 200
    assert listed.json()[0]["url"] == url

    with mock.patch(
        "core.api.tasks.utils.generate_file_download_url",
        return_value="https://storage.example.test/signed",
    ) as signed:
        assert _client(creator).get(url).status_code == 302
        assert _client(former_assignee).get(url).status_code == 302
        assert _client(outsider).get(url).status_code == 404
        signed.assert_called_with(file)

    task.assignee = current_assignee
    task.save(update_fields=["assignee", "updated_at"])
    with mock.patch(
        "core.api.tasks.utils.generate_file_download_url",
        return_value="https://storage.example.test/signed",
    ):
        assert _client(former_assignee).get(url).status_code == 404
        response = _client(current_assignee).get(url)
        assert response.status_code == 302
        assert response["Location"] == "https://storage.example.test/signed"


def test_current_task_collaborator_removes_attachment_and_queues_bucket_cleanup(
    django_capture_on_commit_callbacks,
):
    creator = UserFactory()
    assignee = UserFactory()
    former_assignee = UserFactory()
    outsider = UserFactory()
    task = Task.objects.create(title="Clean up", creator=creator, assignee=assignee)
    file = FileFactory(
        creator=creator,
        type=FileTypeChoices.TASK_ATTACHMENT,
        filename="obsolete.pdf",
        storage_bucket="we-task-attachment",
        update_upload_state=FileUploadStateChoices.READY,
    )
    attachment = TaskAttachment.objects.create(task=task, file=file, uploader=creator)
    attachment_id = attachment.id
    url = f"{TASKS_URL}{task.id}/attachments/{attachment_id}/"

    with (
        mock.patch("core.api.tasks.process_file_deletion.delay") as deletion,
        django_capture_on_commit_callbacks(execute=True),
    ):
        response = _client(assignee).delete(url)

    assert response.status_code == 204
    assert not TaskAttachment.objects.filter(id=attachment_id).exists()
    file.refresh_from_db()
    assert file.deleted_at is not None
    assert file.hard_deleted_at is not None
    deletion.assert_called_once_with(file.id)
    activity = TaskActivity.objects.get(task=task)
    assert activity.actor == assignee
    assert activity.event == TaskActivity.Event.ATTACHMENT_REMOVED
    assert activity.changes == {
        "attachment": {"id": str(attachment_id), "filename": "obsolete.pdf"}
    }

    task.assignee = former_assignee
    task.save(update_fields=["assignee", "updated_at"])
    assert _client(assignee).delete(url).status_code == 404
    assert _client(outsider).delete(url).status_code == 404


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


def test_task_status_api_syncs_linked_action_item_completion_and_reopen():
    owner = UserFactory()
    assignee = UserFactory()
    action_item = ActionItem.objects.create(
        room=RoomFactory(users=[(owner, "owner"), (assignee, "member")]),
        content="Publish decisions",
        status=ActionItem.Status.CONFIRMED,
        assignee=assignee,
    )
    task = Task.objects.create(
        title=action_item.content,
        creator=owner,
        assignee=assignee,
        source_action_item=action_item,
    )
    action_item.task_id = task.id
    action_item.save(update_fields=["task_id", "updated_at"])
    client = _client(assignee)

    completed = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.COMPLETED},
        format="json",
    )

    assert completed.status_code == 200
    action_item.refresh_from_db()
    completed_activity = TaskActivity.objects.get(
        task=task,
        event=TaskActivity.Event.STATUS_CHANGED,
        changes__status__to=Task.Status.COMPLETED,
    )
    assert action_item.status == ActionItem.Status.COMPLETED
    assert action_item.task_status_sync_activity == completed_activity
    assert completed_activity.changes["source_action_item_sync"]["result"] == (
        "updated"
    )

    reopened = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.TODO},
        format="json",
    )

    assert reopened.status_code == 200
    action_item.refresh_from_db()
    assert action_item.status == ActionItem.Status.CONFIRMED
    assert action_item.task_status_sync_activity is None
