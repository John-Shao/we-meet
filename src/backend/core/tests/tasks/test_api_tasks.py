"""API coverage for the minimal standalone task module."""

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
    )

    response = _client(creator).patch(
        f"{TASKS_URL}{task.id}/",
        {"assignee_id": str(next_assignee.id)},
        format="json",
    )

    assert response.status_code == 200
    assert response.json()["assignee"]["id"] == str(next_assignee.id)
    delivery = TaskImDelivery.objects.get()
    assert delivery.recipient == next_assignee
    assert delivery.event == TaskImDelivery.Event.REASSIGNED
    activity = TaskActivity.objects.get()
    assert activity.actor == creator
    assert activity.event == TaskActivity.Event.ASSIGNEE_CHANGED
    assert activity.changes["assignee"]["from"]["id"] == str(previous_assignee.id)
    assert activity.changes["assignee"]["to"]["id"] == str(next_assignee.id)
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
