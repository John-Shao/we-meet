"""Notification links read an exact immutable version, within fresh record access."""

import uuid

import pytest

from core import models
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_review import fixture, generated

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED = False
    settings.DASHSCOPE_API_KEY = "isolated-link-test"


def test_exact_old_version_is_not_replaced_by_latest_or_first_page():
    user, record, _, old = fixture()
    latest = generated(record, regenerate=True)
    client = client_for(user)
    path = f"/api/v1.0/meeting-records/{record.pk}/summary-versions/"
    first = client.get(path, {"page_size": 1})
    assert first.status_code == 200
    assert first.data["results"][0]["id"] == str(latest.pk)
    pinned = client.get(path, {"version_id": str(old.pk), "page_size": 1})
    assert pinned.status_code == 200
    assert [row["id"] for row in pinned.data["results"]] == [str(old.pk)]
    assert pinned.data["results"][0]["input_snapshot_id"] == str(old.input_snapshot_id)
    assert not pinned.data["results"][0]["is_current"]
    assert pinned.data["next_cursor"] is None


def test_foreign_and_missing_versions_never_fall_back_to_latest():
    user, record, _, _ = fixture()
    _, _, _, foreign = fixture()
    path = f"/api/v1.0/meeting-records/{record.pk}/summary-versions/"
    for version_id in [foreign.pk, uuid.uuid4()]:
        response = client_for(user).get(path, {"version_id": str(version_id)})
        assert response.status_code == 404


@pytest.mark.parametrize(
    "query", ["version_id=", "version_id=bad", "version_id=bad&version_id=other"]
)
def test_malformed_selectors_do_not_become_unpinned_reads(query):
    user, record, _, _ = fixture()
    response = client_for(user).get(
        f"/api/v1.0/meeting-records/{record.pk}/summary-versions/?{query}"
    )
    assert response.status_code == 400


def test_pinned_version_rechecks_permissions_and_rejects_cursor():
    user, record, _, version = fixture()
    path = f"/api/v1.0/meeting-records/{record.pk}/summary-versions/"
    client = client_for(user)
    assert (
        client.get(path, {"version_id": str(version.pk), "cursor": "old"}).status_code
        == 400
    )
    models.ResourceAccess.objects.filter(
        resource=record.meeting_session.room, user=user
    ).delete()
    assert client.get(path, {"version_id": str(version.pk)}).status_code == 404
