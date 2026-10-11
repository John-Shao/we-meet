"""Shared immutable minutes never preview a newer version or widen read access."""

import uuid
from unittest.mock import patch

import pytest

from core import models
from core.factories import UserFactory
from core.services import meeting_summary_review, speaker_identity_decisions
from core.services.summary_identity_state import read_state
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_review import generated, payload
from core.tests.services.test_summary_identity_history import enabled, source

pytestmark = pytest.mark.django_db


@pytest.fixture
def shared(settings):
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    owner, record, _, speaker = source()
    old = generated(record)
    human, _, _ = meeting_summary_review.save_review(
        record.pk, owner, uuid.uuid4(), payload(old)
    )
    speaker_identity_decisions.decide(
        record, speaker.pk, owner, action="set_label", label="New private identity"
    )
    latest = generated(record, regenerate=True)
    request = payload(latest, revision=1, replace=True)
    request["content"]["overview"] = "Latest human minutes"
    current, _, _ = meeting_summary_review.save_review(
        record.pk, owner, uuid.uuid4(), request
    )
    reader = UserFactory()
    grant = models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    return record, old, human, current, reader, grant


@pytest.mark.parametrize("kind", ["summary_id", "human_id"])
def test_shared_history_preview_preserves_exact_old_identity_and_never_reads_latest(
    shared, kind
):
    record, old, human, current, reader, _ = shared
    version = old if kind == "summary_id" else human
    path = f"/api/v1.0/meeting-records/{record.pk}/collaboration/minutes/preview/"
    client = client_for(reader)
    with patch("core.services.meeting_summary_versions.LLMClient") as provider:
        response = client.get(path, {kind: str(version.pk)})
        provider.assert_not_called()
    assert response.status_code == 200, response.data
    assert response.data[kind] == str(version.pk)
    assert response.data["excerpt"] == version.content["overview"][:800]
    assert response.data["identity_updated"]
    assert response.data["role"] == "reader" and response.data["media_url"] is None
    assert "New private identity" not in str(response.data)
    assert response["Cache-Control"] == "private, no-store"
    assert client.get(path).data["excerpt"] == current.content["overview"]
    assert (
        client.get(path, {"human_id": str(current.pk)}).data["identity_updated"]
        is False
    )
    assert (
        client.get(
            f"/api/v1.0/meeting-records/{record.pk}/speaker-identification/"
        ).status_code
        == 404
    )
    assert (
        client.get(
            f"/api/v1.0/meeting-records/{record.pk}/transcript-versions/{old.input_snapshot_id}/"
        ).status_code
        == 403
    )


@pytest.mark.parametrize("kind", ["summary_id", "human_id"])
def test_foreign_and_missing_shared_version_never_falls_back(shared, kind):
    record, old, human, _, reader, _ = shared
    other_owner, other_record, _, _ = source()
    foreign = generated(other_record)
    if kind == "human_id":
        foreign, _, _ = meeting_summary_review.save_review(
            other_record.pk, other_owner, uuid.uuid4(), payload(foreign)
        )
    path = f"/api/v1.0/meeting-records/{record.pk}/collaboration/minutes/preview/"
    client = client_for(reader)
    for version_id in (foreign.pk, uuid.uuid4()):
        response = client.get(path, {kind: str(version_id)})
        assert response.status_code == 404 and "excerpt" not in response.data


@pytest.mark.parametrize(
    "query",
    [
        "summary_id=",
        "human_id=bad",
        "summary_id=bad&summary_id=other",
        "human_id=bad&human_id=other",
        "summary_id=bad&human_id=other",
    ],
)
def test_invalid_shared_selectors_are_rejected_instead_of_opening_current(
    shared, query
):
    record, _, _, _, reader, _ = shared
    response = client_for(reader).get(
        f"/api/v1.0/meeting-records/{record.pk}/collaboration/minutes/preview/?{query}"
    )
    assert response.status_code == 400 and "excerpt" not in response.data
    assert response["Cache-Control"] == "private, no-store"


@pytest.mark.parametrize("kind", ["summary_id", "human_id"])
def test_shared_preview_drops_body_if_read_access_is_revoked_mid_request(shared, kind):
    record, old, human, _, reader, grant = shared

    def revoke(record):
        state = read_state(record)
        grant.delete()
        return state

    version = old if kind == "summary_id" else human
    with patch("core.api.meeting_collaboration.read_state", side_effect=revoke):
        response = client_for(reader).get(
            f"/api/v1.0/meeting-records/{record.pk}/collaboration/minutes/preview/",
            {kind: str(version.pk)},
        )
    assert response.status_code == 404 and "excerpt" not in response.data
    assert response["Cache-Control"] == "private, no-store"


@pytest.mark.parametrize("kind", ["summary_id", "human_id"])
def test_minutes_version_cannot_be_used_as_record_preview(shared, kind):
    record, old, human, _, _, _ = shared
    version = old if kind == "summary_id" else human
    response = client_for(record.owner).get(
        f"/api/v1.0/meeting-records/{record.pk}/collaboration/record/preview/",
        {kind: str(version.pk)},
    )
    assert response.status_code == 400 and "excerpt" not in response.data
