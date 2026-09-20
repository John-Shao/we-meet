"""Frozen preview/intent, source deduplication and independent document permissions."""

import copy
import uuid
from concurrent.futures import ThreadPoolExecutor

from django.core.exceptions import ValidationError
from django.db import close_old_connections

import pytest

from core import models
from core.factories import UserFactory
from core.services import meeting_summary_exports as service
from core.services import meeting_summary_review
from core.services.meeting_records import RecordConflict
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_review import fixture, payload

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings, monkeypatch):
    monkeypatch.setattr(service, "_dispatch", lambda _: False)
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    settings.MEETING_SUMMARY_EXPORT_ENABLED = True
    settings.CELERY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "export-test-only"
    settings.DOCS_CONFIGURATION = {
        "api_url": "https://docs.invalid",
        "server_to_server_token": "export-docs-test-only",
    }


def selection(summary, *, language="en", human=False):
    return {
        "source_kind": "human" if human else "ai",
        "source_id": str(summary.pk),
        "language": language,
    }


def path(record):
    return f"/api/v1.0/meeting-records/{record.pk}/document-exports/"


def history_fixture():
    owner, record, _, summary = fixture()
    for index in range(13):
        review, _, _ = meeting_summary_review.save_review(
            record.pk, owner, uuid.uuid4(), payload(summary, revision=index)
        )
        export_request(record.pk, owner, uuid.uuid4(), selection(review, human=True))
    # Same timestamp deliberately exercises the UUID tie-breaker.
    record.document_exports.update(created_at=record.origin_at)
    return owner, record, summary


def test_history_pages_all_receipts_with_stable_ties_and_new_insert():
    owner, record, summary = history_fixture()
    client = client_for(owner)
    expected = [
        str(pk)
        for pk in record.document_exports.order_by("-created_at", "-id").values_list(
            "pk", flat=True
        )
    ]
    first = client.get(path(record)).json()
    assert len(first["results"]) == 10
    assert first["next_cursor"]
    export_request(record.pk, owner, uuid.uuid4(), selection(summary))
    second = client.get(path(record), {"cursor": first["next_cursor"]}).json()
    assert [row["id"] for row in first["results"] + second["results"]] == expected
    assert second["next_cursor"] is None


def test_history_cursor_is_bound_to_reader_record_and_selection():
    owner, record, summary = history_fixture()
    client = client_for(owner)
    token = client.get(path(record)).json()["next_cursor"]
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    assert client_for(reader).get(path(record)).json()["results"] == []
    assert client_for(reader).get(path(record), {"cursor": token}).status_code == 400
    other = models.MeetingRecord.objects.create(
        owner=owner, source_type="upload", title="Other", origin_at=record.origin_at
    )
    assert client.get(path(other), {"cursor": token}).status_code == 400
    assert (
        client.get(path(record), {"cursor": token, **selection(summary)}).status_code
        == 400
    )


@pytest.mark.parametrize("cursor", ["", "not-a-signed-cursor", "a" * 2049])
def test_history_rejects_malformed_cursor(cursor):
    owner, record, _, _ = fixture()
    assert client_for(owner).get(path(record), {"cursor": cursor}).status_code == 400


def test_history_rechecks_visibility_for_later_pages():
    owner, record, _ = history_fixture()
    client = client_for(owner)
    token = client.get(path(record)).json()["next_cursor"]
    models.ResourceAccess.objects.filter(
        user=owner, resource=record.meeting_session.room
    ).delete()
    assert client.get(path(record), {"cursor": token}).status_code == 404


def test_preview_and_persisted_copy_use_same_selected_version_without_external_calls():
    owner, record, _, summary = fixture()
    choice = selection(summary)
    client = client_for(owner)
    preview = client.get(path(record) + "preview/", choice)
    assert preview.status_code == 200, preview.data
    assert "sub" not in preview.data
    key = uuid.uuid4()
    choice = {**choice, "expected_hash": preview.data["payload_hash"]}
    response = client.post(
        path(record), choice, format="json", HTTP_IDEMPOTENCY_KEY=str(key)
    )
    assert response.status_code == 202, response.data
    export = record.document_exports.get()
    assert export.status == "queued" and export.summary_id == summary.pk
    assert export.payload["content"] == preview.data["markdown"]
    assert export.payload["sub"] == owner.sub
    assert export.payload_hash == service.digest(export.payload)
    assert export.api_url == "https://docs.invalid"
    assert "export-docs-test-only" not in str(export.payload)
    assert "payload" not in response.data["export"]
    assert response["Cache-Control"] == "private, no-store"
    repeated = client.post(
        path(record), choice, format="json", HTTP_IDEMPOTENCY_KEY=str(key)
    )
    assert repeated.data["replayed"] is True
    assert repeated.data["export"]["id"] == response.data["export"]["id"]


def test_new_browser_key_deduplicates_source_but_same_key_cannot_change_source():
    owner, record, _, summary = fixture()
    key = uuid.uuid4()
    first, _ = export_request(record.pk, owner, key, selection(summary))
    second, _ = export_request(record.pk, owner, uuid.uuid4(), selection(summary))
    assert first.pk == second.pk
    assert first.requests.count() == 2
    with pytest.raises(RecordConflict):
        export_request(record.pk, owner, key, selection(summary, language="zh"))
    translated, _ = export_request(
        record.pk, owner, uuid.uuid4(), selection(summary, language="zh")
    )
    assert translated.pk != first.pk


def test_review_export_does_not_follow_later_human_edits_or_mutate_ai():
    owner, record, _, summary = fixture()
    original = copy.deepcopy(summary.content)
    first, _, _ = meeting_summary_review.save_review(
        record.pk, owner, uuid.uuid4(), payload(summary)
    )
    export, _ = export_request(
        record.pk, owner, uuid.uuid4(), selection(first, human=True)
    )
    second_payload = payload(summary, revision=1)
    second_payload["content"]["overview"] = "Later correction"
    meeting_summary_review.save_review(record.pk, owner, uuid.uuid4(), second_payload)
    export.refresh_from_db()
    assert "Human correction" in export.payload["content"]
    assert "Later correction" not in export.payload["content"]
    assert export.review_id == first.pk
    summary.refresh_from_db()
    assert summary.content == original
    export.payload["content"] = "overwritten"
    with pytest.raises(ValidationError):
        export.save()


def test_shared_readers_cannot_export_or_preview_and_never_see_others_receipts():
    owner, record, _, summary = fixture()
    export_request(record.pk, owner, uuid.uuid4(), selection(summary))
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    client = client_for(reader)
    assert client.get(path(record)).data == {
        "available": False,
        "results": [],
        "next_cursor": None,
    }
    assert client.get(path(record) + "preview/", selection(summary)).status_code == 403
    assert (
        client.post(
            path(record),
            {**selection(summary), "expected_hash": "0" * 64},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        ).status_code
        == 403
    )


def test_cross_record_or_forged_rendered_content_cannot_be_exported():
    owner, record, _, summary = fixture()
    other, other_record, _, foreign = fixture()
    client = client_for(owner)
    assert client.get(path(record) + "preview/", selection(foreign)).status_code == 409
    assert (
        client.post(
            path(record),
            {**selection(summary), "content": "forged"},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        ).status_code
        == 400
    )
    assert not record.document_exports.exists()
    assert client_for(other).get(path(record)).status_code == 404
    assert client.get(path(other_record)).status_code == 404


def test_feature_off_blocks_new_exports_but_keeps_existing_receipt_readable(settings):
    owner, record, _, summary = fixture()
    key = uuid.uuid4()
    saved, _ = export_request(record.pk, owner, key, selection(summary))
    settings.MEETING_SUMMARY_EXPORT_ENABLED = False
    response = client_for(owner).get(path(record))
    assert response.data["available"] is False
    assert response.data["results"][0]["id"] == str(saved.pk)
    assert export_request(record.pk, owner, key, selection(summary))[1] is True
    with pytest.raises(PermissionError):
        export_request(record.pk, owner, uuid.uuid4(), selection(summary))
    settings.MEETING_RECORDS_ENABLED = False
    assert client_for(owner).get(path(record)).status_code == 404


def test_markdown_preview_keeps_user_content_literal_without_media_or_raw_html():
    owner, record, _, summary = fixture()
    data = payload(summary)
    data["content"]["overview"] = (
        "![image](https://external.invalid/tracker)\n<script>alert(1)</script>\n# Fake heading"
    )
    review, _, _ = meeting_summary_review.save_review(
        record.pk, owner, uuid.uuid4(), data
    )
    _, _, rendered = service.render_payload(
        record, owner, selection(review, human=True)
    )
    assert "<script>" not in rendered["content"]
    assert "![image](" not in rendered["content"]
    assert "\\# Fake heading" in rendered["content"]
    assert "Human revision 1" in rendered["content"]


@pytest.mark.django_db(transaction=True)
def test_concurrent_distinct_intents_share_one_source_export():
    owner, record, _, summary = fixture()

    def create():
        close_old_connections()
        try:
            return export_request(record.pk, owner, uuid.uuid4(), selection(summary))[
                0
            ].pk
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: create(), range(2)))
    assert results[0] == results[1]
    assert record.document_exports.count() == 1


def export_request(record_id, user, key, choice):
    record = models.MeetingRecord.objects.get(pk=record_id)
    _, _, rendered = service.render_payload(record, user, choice)
    return service.request_export(
        record_id, user, key, choice, service.digest(rendered)
    )


def test_preview_change_requires_review_before_creating_a_document():
    owner, record, _, summary = fixture()
    choice = selection(summary)
    _, _, preview = service.render_payload(record, owner, choice)
    expected = service.digest(preview)
    record.title = "Renamed after preview"
    record.save(update_fields=["title"])
    with pytest.raises(RecordConflict):
        service.request_export(record.pk, owner, uuid.uuid4(), choice, expected)
    assert not record.document_exports.exists()


def test_document_link_is_hidden_if_docs_origin_changes(settings):
    owner, record, _, summary = fixture()
    export, _ = export_request(record.pk, owner, uuid.uuid4(), selection(summary))
    export.status = "ready"
    export.document_id = uuid.uuid4()
    export.save(update_fields=["status", "document_id"])
    assert service.serialize(export)["can_open"] is True
    settings.DOCS_CONFIGURATION = {
        **settings.DOCS_CONFIGURATION,
        "api_url": "https://other.invalid",
    }
    assert service.serialize(export)["can_open"] is False
