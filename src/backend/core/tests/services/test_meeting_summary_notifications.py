"""Frozen recipients and atomic completion intents; no IM calls during generation."""

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.db import close_old_connections

import pytest

from core import models
from core.factories import UserFactory
from core.services import meeting_summary_notifications as service
from core.tests.services.test_meeting_records import audio_note, client_for
from core.tests.services.test_meeting_summary_review import fixture

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings, monkeypatch):
    monkeypatch.setattr(service, "_dispatch", lambda _: False)
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = True
    settings.CELERY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "notification-test-only"
    settings.JUSI_IM_CONFIGURATION = {
        "api_url": "https://im.invalid",
        "admin_hmac_secret": "isolated-im-hmac-secret-not-production",
    }
    settings.APPLICATION_BASE_URL = "https://meet.invalid"


def test_final_publication_records_one_private_intent_without_network():
    with patch("requests.request") as network:
        user, record, _, version = fixture()
        row = record.summary_notifications.get()
        assert row.summary_id == version.pk and row.recipient_id == user.pk
        assert row.status == "queued" and row.body == "" and row.bot_uid is None
        assert version.notification_event.recipient_ids == [str(user.pk)]
        network.assert_not_called()
        assert service.record_completion(version)[0].pk == row.pk
        assert record.summary_notifications.count() == 1


def test_disabled_notifications_do_not_backfill_old_completions(settings):
    settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = False
    _, record, _, version = fixture()
    assert not record.summary_notifications.exists()
    assert not models.MeetingSummaryNotificationEvent.objects.filter(
        summary=version
    ).exists()
    settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = True
    # Merely reading current status does not create old notices.
    assert not record.summary_notifications.exists()


@pytest.mark.parametrize("stage", ["realtime", "quick"])
def test_provisional_versions_do_not_emit_completion(stage, settings):
    settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = False
    _, record, _, version = fixture()
    settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = True
    version.stage = stage
    assert service.record_completion(version) == []
    assert not record.summary_notifications.exists()


def test_missing_im_config_does_not_erase_successful_summary_or_notification(settings):
    settings.JUSI_IM_CONFIGURATION = {}
    _, record, _, version = fixture()
    assert record.summary_versions.filter(pk=version.pk).exists()
    assert record.summary_notifications.get().status == "queued"
    assert not service.available()


def test_later_membership_changes_never_expand_a_captured_recipient_set():
    owner, record, _, version = fixture()
    other = UserFactory()
    models.ResourceAccess.objects.create(
        resource=record.meeting_session.room, user=other, role=models.RoleChoices.OWNER
    )
    service.record_completion(version)
    assert list(
        record.summary_notifications.values_list("recipient_id", flat=True)
    ) == [owner.pk]


def test_empty_recipient_selection_is_also_frozen(settings):
    settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = False
    user, record, _, version = fixture()
    models.User.objects.filter(pk=user.pk).update(is_active=False)
    settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = True
    assert service.record_completion(version) == []
    assert version.notification_event.recipient_ids == []
    models.User.objects.filter(pk=user.pk).update(is_active=True)
    assert service.record_completion(version) == []


def test_native_recipients_do_not_include_shared_readers_or_speaker_labels():
    owner, reader = UserFactory(), UserFactory()
    record = audio_note(owner)
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    assert [user.pk for user in service.recipient_candidates(record, reader.pk)] == [
        owner.pk
    ]


def test_card_metadata_is_frozen_and_does_not_embed_summary_or_original_text():
    user, record, _, version = fixture()
    row = record.summary_notifications.get()
    old_title = row.source_metadata["title"]
    record.title = "Later title"
    record.save(update_fields=["title"])
    body = service.build_body(row, "https://meet.invalid")
    card = json.loads(body)
    assert old_title in card["plain"] and "Later title" not in body
    assert version.content["overview"] not in body
    assert f"?summary={version.pk}" in body and "/docs/" not in body
    assert "recipient_sub" not in body and user.sub not in body
    row.source_metadata = {**row.source_metadata, "title": "tampered"}
    with pytest.raises(ValidationError):
        row.save()


def test_prepared_payload_and_destination_cannot_be_overwritten():
    _, record, _, _ = fixture()
    row = record.summary_notifications.get()
    row.api_url = "https://im.invalid"
    row.body = service.build_body(row, "https://meet.invalid")
    row.body_hash = service.body_hash(row.body)
    row.bot_uid = uuid.uuid4()
    row.conversation_id = uuid.uuid4()
    row.save()
    row.conversation_id = uuid.uuid4()
    with pytest.raises(ValidationError):
        row.save()
    row.refresh_from_db()
    row.body = "changed"
    with pytest.raises(ValidationError):
        row.save()


def test_status_is_private_and_does_not_grant_summary_access():
    owner, record, _, _ = fixture()
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    path = f"/api/v1.0/meeting-records/{record.pk}/summary-notifications/"
    response = client_for(owner).get(path)
    assert response.status_code == 200, response.data
    assert len(response.data["results"]) == 1 and response.data["future_recipients"][0][
        "id"
    ] == str(owner.pk)
    assert "body" not in response.data["results"][0]
    shared = client_for(reader).get(path)
    assert shared.data["results"] == [] and "future_recipients" not in shared.data
    models.MeetingRecordAccess.objects.filter(record=record, user=reader).delete()
    assert client_for(reader).get(path).status_code == 404


@pytest.mark.django_db(transaction=True)
def test_concurrent_completion_replays_do_not_duplicate_intents(settings):
    settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = False
    _, record, _, version = fixture()
    settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = True

    def save():
        close_old_connections()
        try:
            return service.record_completion(version)[0].pk
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(lambda _: save(), range(2)))
    assert ids[0] == ids[1] and record.summary_notifications.count() == 1
