"""ASR task observations are source-scoped and cannot promote coverage claims."""

from unittest.mock import patch

import pytest

from core import models
from core.factories import UserFactory
from core.services.asr_observations import snapshot_asr_status, validate_observation
from core.services.meeting_records import RecordConflict
from core.services.meeting_summary_versions import (
    execute_summary_job,
    prepare_summary_job,
)
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_versions import output
from core.tests.services.test_transcript_delivery import (
    control,
    enabled,
    end_session,
    setup_delivery,
)
from core.tests.test_api_agent_internal import _post

pytestmark = pytest.mark.django_db


def report(**overrides):
    return {
        "schema_version": 1,
        "provider": "qwen",
        "model": "qwen-audio-3.0-asr-flash-streaming",
        "streams_started": 1,
        "streams_finished": 1,
        "tasks_started": 2,
        "tasks_finished": 2,
        "input_samples": 32000,
        "final_sentences": 1,
        "billed_seconds": 2.0,
        "errors": [],
        **overrides,
    }


def test_sealed_report_replays_and_never_promotes_full_coverage(settings, enabled):
    client, session, identity, payload = setup_delivery(settings)
    assert _post(client, payload).status_code == 201
    data = {
        "action": "finish",
        "final_sequence": 1,
        "outcome": "complete",
        "source_report": report(),
    }
    assert control(client, identity, **data).status_code == 200
    assert control(client, identity, **data).status_code == 200
    assert (
        control(
            client, identity, **{**data, "source_report": report(input_samples=16000)}
        ).status_code
        == 409
    )
    assert (
        control(
            client, identity, action="finish", final_sequence=1, outcome="complete"
        ).status_code
        == 409
    )
    record = end_session(session)
    job = prepare_summary_job(record.pk)
    assert snapshot_asr_status(job.input_snapshot.delivery) == "finished"
    assert job.input_snapshot.delivery["streams"][0]["source_report"] == report()
    with patch("core.services.meeting_summary_versions.LLMClient") as provider:
        provider.return_value.chat.return_value = output(job)
        version = execute_summary_job(job.pk, attempt=1)
    assert version is not None
    job.refresh_from_db()
    assert job.status == "partial" and job.result["coverage_status"] == "unverified"


@pytest.mark.parametrize(
    "changes",
    [
        {"streams_finished": 2},
        {"tasks_finished": 3},
        {"input_samples": -1},
        {"streams_started": True},
        {"billed_seconds": float("inf")},
        {"errors": ["upstream-secret"]},
        {"api_key": "secret"},
        {"tasks_started": 0, "tasks_finished": 0},
    ],
)
def test_invalid_report_is_rejected_without_exposing_content(changes):
    with pytest.raises(RecordConflict, match="Invalid ASR observation manifest"):
        validate_observation(report(**changes))


def test_failed_or_open_source_cannot_seal_as_complete(settings, enabled):
    client, _, identity, payload = setup_delivery(settings)
    assert _post(client, payload).status_code == 201
    incomplete = report(tasks_finished=1, errors=["asr_stream_failed"])
    data = {"action": "finish", "final_sequence": 1, "source_report": incomplete}
    assert control(client, identity, **data, outcome="complete").status_code == 409
    assert control(client, identity, **data, outcome="incomplete").status_code == 200
    assert (
        models.TranscriptDelivery.objects.get(pk=identity["delivery_id"]).source_report
        == incomplete
    )


def test_material_scope_and_empty_legacy_reports(settings, enabled):
    client, session, identity, payload = setup_delivery(settings)
    assert _post(client, payload).status_code == 201
    assert (
        control(
            client,
            identity,
            action="finish",
            final_sequence=1,
            outcome="complete",
            source_report=report(),
        ).status_code
        == 200
    )
    record = end_session(session)
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    response = client_for(reader).get(
        f"/api/v1.0/meeting-records/{record.pk}/source-status/"
    )
    assert response.status_code == 200
    row = response.data["results"][0]
    assert row["asr_status"] == "finished"
    assert row["coverage_status"] == "unverified"
    assert row["source_scope"] == "agent_observed_audio"
    assert payload["text"] not in str(response.data)
    assert response["Cache-Control"] == "private, no-store"
    assert (
        client_for(UserFactory())
        .get(f"/api/v1.0/meeting-records/{record.pk}/source-status/")
        .status_code
        == 404
    )
    assert snapshot_asr_status({}) == "unverified"
    assert (
        snapshot_asr_status({"streams": [{"source_report": report()}, {}]})
        == "unverified"
    )
    assert (
        snapshot_asr_status(
            {
                "streams": [
                    {
                        "source_report": report(
                            tasks_started=0,
                            tasks_finished=0,
                            input_samples=0,
                            final_sentences=0,
                            billed_seconds=0.0,
                        )
                    }
                ]
            }
        )
        == "no_audio_observed"
    )


def test_invalid_wire_report_and_false_sentence_count(settings, enabled):
    client, _, identity, payload = setup_delivery(settings)
    assert _post(client, payload).status_code == 201
    assert (
        control(client, identity, action="begin", source_report=report()).status_code
        == 400
    )
    response = control(
        client,
        identity,
        action="finish",
        final_sequence=1,
        outcome="complete",
        source_report=report(api_key="do-not-return"),
    )
    assert response.status_code == 409 and "do-not-return" not in str(response.data)
    assert (
        control(
            client,
            identity,
            action="finish",
            final_sequence=1,
            outcome="complete",
            source_report=report(final_sentences=0),
        ).status_code
        == 409
    )
