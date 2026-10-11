"""Human revisions disclose identity drift while retaining their own source and edits."""

import copy
import uuid
from unittest.mock import patch

import pytest

from core import models
from core.api.meeting_summary_review import SummaryHistoryView
from core.factories import UserFactory
from core.services import meeting_summary_review, speaker_identity_decisions
from core.services.summary_identity_state import read_state
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_review import fixture, generated, payload
from core.tests.services.test_summary_identity_history import enabled, source

pytestmark = pytest.mark.django_db


def test_human_current_history_and_saved_receipts_keep_frozen_source_after_identity_change(
    settings,
):
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    owner, record, _, speaker = source()
    base = generated(record)
    review, _, _ = meeting_summary_review.save_review(
        record.pk, owner, uuid.uuid4(), payload(base)
    )
    original = copy.deepcopy(review.content)
    path = f"/api/v1.0/meeting-records/{record.pk}/human-summary/"
    client = client_for(owner)
    assert not client.get(path).data["current"]["identity_updated"]
    speaker_identity_decisions.decide(
        record, speaker.pk, owner, action="set_label", label="新身份"
    )
    for url in (path, f"{path}history/{review.pk}/"):
        response = client.get(url)
        assert response.status_code == 200
        row = response.data["current"] if url == path else response.data
        assert row["identity_updated"] and row["content"] == original
        assert row["input_snapshot_id"] == str(base.input_snapshot_id)
    request = payload(base, revision=1)
    request["content"]["overview"] = "保留人工明确修改"
    response = client.post(path, {"key": str(uuid.uuid4()), **request}, format="json")
    assert response.status_code == 200, response.data
    assert response.data["saved"]["identity_updated"]
    assert response.data["current"]["content"]["overview"] == "保留人工明确修改"
    newer = generated(record, regenerate=True)
    replacement = payload(newer, revision=2, replace=True)
    response = client.post(
        path, {"key": str(uuid.uuid4()), **replacement}, format="json"
    )
    assert response.status_code == 200
    assert not response.data["current"]["identity_updated"]
    assert client.get(f"{path}history/{review.pk}/").data["identity_updated"]
    review.refresh_from_db()
    assert review.content == original and review.base_summary_id == base.pk


def test_read_only_human_notice_does_not_disclose_new_name_or_accept_forged_metadata(
    settings,
):
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    owner, record, _, speaker = source()
    base = generated(record)
    review, _, _ = meeting_summary_review.save_review(
        record.pk, owner, uuid.uuid4(), payload(base)
    )
    speaker_identity_decisions.decide(
        record, speaker.pk, owner, action="set_label", label="新私有身份"
    )
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    path = f"/api/v1.0/meeting-records/{record.pk}/human-summary/"
    response = client_for(reader).get(path)
    assert (
        response.data["current"]["identity_updated"] and not response.data["can_edit"]
    )
    assert "新私有身份" not in str(response.data)
    forged = {
        "key": str(uuid.uuid4()),
        **payload(base, revision=1),
        "identity_updated": False,
    }
    assert client_for(owner).post(path, forged, format="json").status_code == 400
    assert record.summary_reviews.count() == 1
    assert (
        client_for(reader)
        .get(
            f"/api/v1.0/meeting-records/{record.pk}/transcript-versions/{base.input_snapshot_id}/"
        )
        .status_code
        == 403
    )


@pytest.mark.parametrize("kind", ["current", "history", "ai"])
def test_permission_revoked_during_identity_metadata_read_discards_summary(
    kind, settings
):
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    owner, record, _, base = fixture()
    review, _, _ = meeting_summary_review.save_review(
        record.pk, owner, uuid.uuid4(), payload(base)
    )
    reader = UserFactory()
    grant = models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    root = f"/api/v1.0/meeting-records/{record.pk}/"
    route = (
        "summary-versions/"
        if kind == "ai"
        else "human-summary/"
        if kind == "current"
        else f"human-summary/history/{review.pk}/"
    )
    target = (
        "core.api.meeting_records.summary_identity_state"
        if kind == "ai"
        else "core.api.meeting_summary_review.read_state"
    )

    def revoke(record):
        state = read_state(record)
        grant.delete()
        return state

    with patch(target, side_effect=revoke):
        response = client_for(reader).get(root + route)
    assert response.status_code == 404
    assert "content" not in response.data and "current" not in response.data
    assert response["Cache-Control"] == "private, no-store"


def test_write_receipt_is_discarded_if_access_is_revoked_after_authorized_save(
    settings,
):
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    owner, record, _, base = fixture()

    def revoke(record):
        state = read_state(record)
        models.ResourceAccess.objects.filter(
            resource=record.meeting_session.room, user=owner
        ).delete()
        return state

    with patch("core.api.meeting_summary_review.read_state", side_effect=revoke):
        response = client_for(owner).post(
            f"/api/v1.0/meeting-records/{record.pk}/human-summary/",
            {"key": str(uuid.uuid4()), **payload(base)},
            format="json",
        )
    assert response.status_code == 404 and "current" not in response.data
    assert (
        record.summary_reviews.count() == 1
    )  # The save was authorized; its receipt is now private.


@pytest.mark.parametrize("history", [False, True])
def test_permission_revoked_during_human_serialization_discards_materialized_body(
    history, settings
):
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    owner, record, _, base = fixture()
    review, _, _ = meeting_summary_review.save_review(
        record.pk, owner, uuid.uuid4(), payload(base)
    )
    reader = UserFactory()
    grant = models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    serialize = meeting_summary_review.serialize

    def revoke(*args, **kwargs):
        result = serialize(*args, **kwargs)
        grant.delete()
        return result

    path = f"/api/v1.0/meeting-records/{record.pk}/human-summary/"
    if history:
        path += f"history/{review.pk}/"
    with patch.object(meeting_summary_review, "serialize", side_effect=revoke):
        response = client_for(reader).get(path)
    assert response.status_code == 404 and "content" not in response.data


def test_history_index_rechecks_access_after_materializing_headers(settings):
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    owner, record, _, base = fixture()
    meeting_summary_review.save_review(record.pk, owner, uuid.uuid4(), payload(base))
    reader = UserFactory()
    grant = models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    authorize = SummaryHistoryView.record
    calls = 0

    def recheck(view, request, record_id):
        nonlocal calls
        calls += 1
        if calls == 2:
            grant.delete()
        return authorize(view, request, record_id)

    with patch.object(SummaryHistoryView, "record", recheck):
        response = client_for(reader).get(
            f"/api/v1.0/meeting-records/{record.pk}/human-summary/history/"
        )
    assert response.status_code == 404 and "results" not in response.data
    assert response["Cache-Control"] == "private, no-store"
