"""Confirmed summary actions create one authorized task and retain deletion receipts."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from django.db import close_old_connections

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
    review.refresh_from_db()
    assert review.content["action_items"][0]["text"] == "Human follow-up"
    assert service.convert(record.pk, user, key, data) == (link, False)
    with pytest.raises(RecordConflict):
        service.convert(record.pk, user, key, {**data, "title": "Changed"})


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
