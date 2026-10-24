"""Confirmed summary actions create one authorized task and retain deletion receipts."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from django.db import close_old_connections, connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

import pytest

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services import meeting_summary_review
from core.services import meeting_summary_tasks as service
from core.services.meeting_records import RecordConflict
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_review import fixture, payload

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    settings.MEETING_SUMMARY_TASKS_ENABLED = True
    settings.DASHSCOPE_API_KEY = "test-provider-key"
    settings.CELERY_TASK_ALWAYS_EAGER = False


def setup():
    user, record, _, base = fixture()
    review, _, _ = meeting_summary_review.save_review(
        record.pk, user, uuid.uuid4(), payload(base)
    )
    data = {
        "review_id": str(review.pk),
        "action_index": 0,
        "title": "Confirmed task",
        "assignee_id": str(user.pk),
        "due_date": "2026-10-01",
    }
    return user, record, review, data


def make_linked_task(*, record, review, user, title, action_index, **fields):
    task = models.Task.objects.create(
        title=title,
        creator=user,
        organization_id=record.organization_id,
        assignee=user,
        **fields,
    )
    models.MeetingSummaryTaskLink.objects.create(
        record=record,
        review=review,
        action_index=action_index,
        action_hash=uuid.uuid4().hex,
        task=task,
        author=user,
        key=uuid.uuid4(),
        request_hash=uuid.uuid4().hex,
        confirmed={"title": title},
    )
    return task


def test_explicit_conversion_and_replay_leave_source_unchanged():
    user, record, review, data = setup()
    key = uuid.uuid4()
    link, created = service.convert(record.pk, user, key, data)
    assert created and models.Task.objects.count() == 1
    assert link.task.title == "Confirmed task" and link.task.assignee == user
    assert str(link.task.due_date) == "2026-10-01"
    assert link.task.assignees.filter(pk=user.pk).exists()
    assert link.task.organization_id == record.organization_id
    assert link.task.activities.count() == 1
    assert not models.TaskImDelivery.objects.exists()  # Self-assignment stays silent.
    api = client_for(user)
    task = api.get(f"/api/v1.0/tasks/{link.task_id}/").json()
    assert task["source_record_id"] == str(record.pk)
    assert task["source_record_title"] == record.title
    assert task["source_record_trashed"] is False
    assert task["source_room_id"] is None
    models.MeetingRecord.objects.filter(pk=record.pk).update(title="")
    assert (
        api.get(f"/api/v1.0/tasks/{link.task_id}/").json()["source_record_title"]
        == record.meeting_session.room.name
    )
    review.refresh_from_db()
    assert review.content["action_items"][0]["text"] == "Human follow-up"
    assert service.convert(record.pk, user, key, data) == (link, False)
    with pytest.raises(RecordConflict):
        service.convert(record.pk, user, key, {**data, "title": "Changed"})


def test_source_record_trashed_flag_follows_the_record_lifecycle():
    user, record, review, data = setup()
    link, _ = service.convert(record.pk, user, uuid.uuid4(), data)
    api = client_for(user)
    url = f"/api/v1.0/tasks/{link.task_id}/"
    assert api.get(url).json()["source_record_trashed"] is False

    models.MeetingRecord.objects.filter(pk=record.pk).update(deleted_at=timezone.now())
    task = api.get(url).json()
    assert task["source_record_id"] == str(record.pk)
    assert task["source_record_title"] == record.title
    assert task["source_record_trashed"] is True

    models.MeetingRecord.objects.filter(pk=record.pk).update(deleted_at=None)
    assert api.get(url).json()["source_record_trashed"] is False


def test_task_list_source_backlink_queries_are_bounded():
    user, record, review, data = setup()
    link, _ = service.convert(record.pk, user, uuid.uuid4(), data)
    unlinked_ids = {
        str(
            models.Task.objects.create(
                title=f"Unlinked task {index}",
                creator=user,
                organization_id=record.organization_id,
                assignee=user,
            ).pk
        )
        for index in range(3)
    }
    api = client_for(user)
    assert api.get("/api/v1.0/tasks/").status_code == 200

    with CaptureQueriesContext(connection) as one:
        response = api.get("/api/v1.0/tasks/")
    assert response.status_code == 200
    assert {row["id"] for row in response.json()["results"]} == {
        str(link.task_id),
        *unlinked_ids,
    }

    linked_ids = {str(link.task_id)}
    for index in range(5):
        task = make_linked_task(
            record=record,
            review=review,
            user=user,
            title=f"Linked task {index}",
            action_index=index + 1,
        )
        linked_ids.add(str(task.pk))

    with CaptureQueriesContext(connection) as many:
        response = api.get("/api/v1.0/tasks/")
    assert response.status_code == 200
    assert {row["id"] for row in response.json()["results"]} == {
        *linked_ids,
        *unlinked_ids,
    }
    assert len(many) == len(one)


def test_subtask_reorder_source_backlink_queries_are_bounded():
    user, record, review, _ = setup()
    parent = models.Task.objects.create(
        title="Parent",
        creator=user,
        organization_id=record.organization_id,
        assignee=user,
    )
    first = make_linked_task(
        record=record,
        review=review,
        user=user,
        title="First linked child",
        action_index=0,
        parent=parent,
        position=0,
    )
    api = client_for(user)
    url = f"/api/v1.0/tasks/{parent.pk}/subtasks/reorder/"

    with CaptureQueriesContext(connection) as one:
        response = api.post(url, {"task_ids": [str(first.pk)]}, format="json")
    assert response.status_code == 200
    assert [row["id"] for row in response.json()] == [str(first.pk)]

    for index in range(1, 6):
        make_linked_task(
            record=record,
            review=review,
            user=user,
            title=f"Linked child {index}",
            action_index=index,
            parent=parent,
            position=index,
        )
    children = models.Task.objects.filter(parent=parent).order_by(
        "position", "created_at"
    )
    ordered_ids = [str(child.pk) for child in children]

    with CaptureQueriesContext(connection) as many:
        response = api.post(url, {"task_ids": ordered_ids}, format="json")
    assert response.status_code == 200
    assert [row["id"] for row in response.json()] == ordered_ids

    def backlink_queries(captured):
        return [
            query["sql"]
            for query in captured.captured_queries
            if "meetingsummarytasklink" in query["sql"].lower()
        ]

    assert len(backlink_queries(one)) == len(backlink_queries(many))


def test_same_action_across_revisions_reuses_task_and_deleted_task_is_not_recreated():
    user, record, review, data = setup()
    link, _ = service.convert(record.pk, user, uuid.uuid4(), data)
    next_payload = {
        "base_summary_id": str(review.base_summary_id),
        "expected_revision": 1,
        "replace_base": False,
        "content": review.content,
    }
    latest, _, _ = meeting_summary_review.save_review(
        record.pk, user, uuid.uuid4(), next_payload
    )
    next_data = {**data, "review_id": str(latest.pk), "title": "Do not overwrite"}
    key = uuid.uuid4()
    reused, created = service.convert(record.pk, user, key, next_data)
    assert reused.pk == link.pk and not created
    link.task.refresh_from_db()
    assert link.task.title == "Confirmed task"
    with pytest.raises(RecordConflict):
        service.convert(
            record.pk, user, key, {**next_data, "title": "different intent"}
        )
    link.task.delete()
    receipt, created = service.convert(record.pk, user, uuid.uuid4(), next_data)
    assert not created and receipt.task_id is None
    assert not models.Task.objects.exists()
    action = (
        client_for(user)
        .get(f"/api/v1.0/meeting-records/{record.pk}/summary-tasks/")
        .json()["actions"][0]
    )
    assert action["task_id"] is None
    assert action["deleted"] is True


def test_stale_revision_foreign_owner_and_disabled_writes_are_rejected(settings):
    user, record, _, data = setup()
    with pytest.raises(RecordConflict):
        service.convert(
            record.pk, user, uuid.uuid4(), {**data, "review_id": str(uuid.uuid4())}
        )
    with pytest.raises(ValueError):
        service.convert(
            record.pk,
            user,
            uuid.uuid4(),
            {**data, "assignee_id": str(UserFactory().pk)},
        )
    settings.MEETING_SUMMARY_TASKS_ENABLED = False
    with pytest.raises(PermissionError):
        service.convert(record.pk, user, uuid.uuid4(), data)
    assert not models.Task.objects.exists()


def test_api_candidates_conversion_status_and_revoked_replay():
    user, record, _, data = setup()
    api = client_for(user)
    url = f"/api/v1.0/meeting-records/{record.pk}/summary-tasks/"
    response = api.get(url)
    assert response.status_code == 200
    assert response.json()["can_convert"]
    assert str(user.pk) in {row["id"] for row in response.json()["assignees"]}
    request = {**data, "key": str(uuid.uuid4())}
    assert api.post(url, request, format="json").status_code == 200
    status = api.get(url).json()["actions"][0]
    assert status["task_id"] and status["status"] == "todo"
    assert (
        api.post(url, {**request, "unexpected": True}, format="json").status_code == 400
    )
    models.ResourceAccess.objects.filter(
        resource_id=record.meeting_session.room_id, user=user
    ).delete()
    assert api.post(url, request, format="json").status_code == 404


def test_organization_directory_and_task_content_access_are_separate():
    user, record, _, data = setup()
    organization = OrganizationFactory()
    MembershipFactory(user=user, organization=organization, is_primary=True)
    colleague = MembershipFactory(organization=organization, is_primary=True).user
    outsider = MembershipFactory().user
    models.MeetingRecord.objects.filter(pk=record.pk).update(organization=organization)
    models.Room.objects.filter(pk=record.meeting_session.room_id).update(
        organization=organization
    )
    record.refresh_from_db()
    api = client_for(user)
    url = f"/api/v1.0/meeting-records/{record.pk}/summary-tasks/"
    response = api.get(url)
    assert response.status_code == 200
    candidates = {row["id"] for row in response.json()["assignees"]}
    assert str(colleague.pk) in candidates and str(outsider.pk) not in candidates
    assert client_for(colleague).get(url).status_code == 404
    link, _ = service.convert(
        record.pk, user, uuid.uuid4(), {**data, "assignee_id": str(colleague.pk)}
    )
    assert link.task.organization_id == organization.pk
    assert service.serialize(link, colleague)["task_id"] == str(link.task_id)
    assert service.serialize(link, outsider)["task_id"] is None
    colleague_api = client_for(colleague)
    colleague_task = colleague_api.get(f"/api/v1.0/tasks/{link.task_id}/").json()
    assert colleague_task["source_record_id"] == str(record.pk)
    assert colleague_task["source_record_title"] == record.title
    assert (
        colleague_api.get(f"/api/v1.0/meeting-records/{record.pk}/").status_code == 404
    )
    assert link.task.source_action_item_id is None and link.task.description == ""
    # Changing task completion is reflected without editing the reviewed minutes.
    link.task.status = models.Task.Status.COMPLETED
    link.task.save()
    assert service.serialize(link, user)["status"] == "completed"
    assert client_for(colleague).get(url).status_code == 404


@pytest.mark.django_db(transaction=True)
def test_concurrent_different_keys_create_one_task():
    user, record, _, data = setup()
    barrier = Barrier(2)

    def run():
        close_old_connections()
        try:
            barrier.wait()
            link, created = service.convert(record.pk, user, uuid.uuid4(), data)
            return link.pk, created
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: run(), range(2)))
    assert len({result[0] for result in results}) == 1
    assert sum(result[1] for result in results) == 1
    assert models.Task.objects.count() == 1
