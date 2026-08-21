"""API coverage for the minimal standalone task module."""

from datetime import timedelta
from unittest import mock
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
    TaskImDelivery,
)

pytestmark = pytest.mark.django_db

TASKS_URL = "/api/v1.0/tasks/"


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


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
    assert payload["assignee"]["id"] == str(user.id)
    assert payload["status"] == Task.Status.TODO
    assert payload["start_date"] == "2026-08-20"
    assert payload["due_date"] == "2026-08-31"
    assert payload["source_room_id"] is None
    assert payload["source_room_name"] is None
    assert payload["can_edit"] is True
    assert payload["can_update_status"] is True
    task = Task.objects.get()
    assert task.creator == user
    assert task.assignee == user
    assert task.start_date.isoformat() == "2026-08-20"
    assert task.due_date.isoformat() == "2026-08-31"
    activity = TaskActivity.objects.get()
    assert activity.task == task
    assert activity.actor == user
    assert activity.event == TaskActivity.Event.CREATED
    assert TaskImDelivery.objects.count() == 0


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


def test_parent_collaborators_create_and_manage_first_level_subtasks():
    organization = OrganizationFactory()
    creator = UserFactory()
    parent_assignee = UserFactory()
    child_assignee = UserFactory()
    outsider = UserFactory()
    for user in (creator, parent_assignee, child_assignee):
        MembershipFactory(
            organization=organization,
            user=user,
            is_primary=True,
        )
    parent = Task.objects.create(
        title="Prepare launch",
        creator=creator,
        assignee=parent_assignee,
    )

    create_response = _client(creator).post(
        f"{TASKS_URL}{parent.id}/subtasks/",
        {
            "title": "Review launch checklist",
            "assignee_id": str(child_assignee.id),
            "start_date": "2026-08-24",
            "due_date": "2026-08-28",
        },
        format="json",
    )

    assert create_response.status_code == 201
    payload = create_response.json()
    assert payload["parent_id"] == str(parent.id)
    assert payload["subtask_count"] == 0
    assert payload["completed_subtask_count"] == 0
    child = Task.objects.get(parent=parent)
    assert child.creator == creator
    assert child.assignee == child_assignee
    assert TaskActivity.objects.get(task=child).event == TaskActivity.Event.CREATED
    delivery = TaskImDelivery.objects.get(task=child)
    assert delivery.recipient == child_assignee
    assert delivery.event == TaskImDelivery.Event.ASSIGNED

    inherited_visibility = _client(parent_assignee).get(
        f"{TASKS_URL}{parent.id}/subtasks/"
    )
    assert inherited_visibility.status_code == 200
    assert inherited_visibility.json()[0]["id"] == str(child.id)
    assert inherited_visibility.json()[0]["can_update_status"] is True

    status_response = _client(parent_assignee).patch(
        f"{TASKS_URL}{child.id}/",
        {"status": Task.Status.COMPLETED},
        format="json",
    )
    assert status_response.status_code == 200
    assert status_response.json()["status"] == Task.Status.COMPLETED

    parent_response = _client(creator).get(f"{TASKS_URL}{parent.id}/")
    assert parent_response.status_code == 200
    assert parent_response.json()["subtask_count"] == 1
    assert parent_response.json()["completed_subtask_count"] == 1

    top_level_response = _client(creator).get(f"{TASKS_URL}?scope=all")
    assert top_level_response.status_code == 200
    assert [item["id"] for item in top_level_response.json()["results"]] == [
        str(parent.id)
    ]
    assert _client(outsider).get(f"{TASKS_URL}{parent.id}/subtasks/").status_code == 404


def test_subtask_cannot_have_nested_subtasks():
    user = UserFactory()
    parent = Task.objects.create(title="Parent", creator=user, assignee=user)
    child = Task.objects.create(
        title="Child",
        creator=user,
        assignee=user,
        parent=parent,
    )

    response = _client(user).post(
        f"{TASKS_URL}{child.id}/subtasks/",
        {"title": "Nested child"},
        format="json",
    )

    assert response.status_code == 400
    assert "parent" in response.json()
    assert Task.objects.count() == 2


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


def test_task_time_filter_uses_current_assignee_timezone():
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

    response = _client(creator).get(f"{TASKS_URL}?scope=created&time=starting_today")

    assert response.status_code == 200
    assert [
        (item["id"], item["time_state"]) for item in response.json()["results"]
    ] == [(str(task.id), "starting_today")]


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
    activity = TaskActivity.objects.get()
    assert activity.actor == assignee
    assert activity.event == TaskActivity.Event.STATUS_CHANGED
    assert activity.changes == {
        "status": {"from": Task.Status.TODO, "to": Task.Status.IN_PROGRESS}
    }
    delivery = TaskImDelivery.objects.get(activity=activity)
    assert delivery.recipient == creator
    assert delivery.event == TaskImDelivery.Event.STATUS_CHANGED

    response = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"title": "Changed by assignee"},
        format="json",
    )
    assert response.status_code == 403

    response = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"assignee_id": str(creator.id)},
        format="json",
    )
    assert response.status_code == 403


def test_assignee_cannot_cancel_or_reopen_canceled_task():
    creator = UserFactory()
    assignee = UserFactory()
    task = Task.objects.create(
        title="Creator-controlled cancellation",
        creator=creator,
        assignee=assignee,
    )
    client = _client(assignee)

    cancel_response = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.CANCELED},
        format="json",
    )

    assert cancel_response.status_code == 403
    task.refresh_from_db()
    assert task.status == Task.Status.TODO
    assert not TaskActivity.objects.filter(task=task).exists()

    task.status = Task.Status.CANCELED
    task.save(update_fields=["status", "updated_at"])
    reopen_response = client.patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.TODO},
        format="json",
    )

    assert reopen_response.status_code == 403
    task.refresh_from_db()
    assert task.status == Task.Status.CANCELED
    assert not TaskActivity.objects.filter(task=task).exists()
    detail_response = client.get(f"{TASKS_URL}{task.id}/")
    assert detail_response.status_code == 200
    assert detail_response.json()["can_update_status"] is False


def test_creator_status_change_notifies_other_assignee():
    creator = UserFactory()
    assignee = UserFactory()
    task = Task.objects.create(
        title="Cancel duplicate work",
        creator=creator,
        assignee=assignee,
    )

    response = _client(creator).patch(
        f"{TASKS_URL}{task.id}/",
        {"status": Task.Status.CANCELED},
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
            "status": Task.Status.IN_PROGRESS,
        },
        format="json",
    )

    assert response.status_code == 200
    assert response.json()["assignee"]["id"] == str(next_assignee.id)
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
    assert TaskActivity.objects.filter(
        event=TaskActivity.Event.STATUS_CHANGED,
        changes={"status": {"from": Task.Status.TODO, "to": Task.Status.IN_PROGRESS}},
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
