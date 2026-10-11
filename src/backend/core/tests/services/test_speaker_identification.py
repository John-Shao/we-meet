"""Public batch privacy and atomic human confirmation with real DB/crypto proofs."""

import json
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

from django.core.cache import cache
from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import MembershipFactory, UserFactory
from core.services import speaker_identification as service
from core.services import speaker_identity_jobs as jobs
from core.services import voiceprint_consent as consent
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_speaker_identity_jobs import (
    case,
    enabled,
    matching_enabled,
    org_for,
    published,
    ready,
    register,
)
from core.tests.services.test_transcript_corrections import captured_segment
from core.tests.test_services_voiceprint_matching import vector

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/meeting-records/{}/speaker-identification/"
DECISION = "/api/v1.0/meeting-records/{}/speakers/{}/identity-decision/"


@pytest.fixture(autouse=True)
def throttle_isolation():
    cache.clear()


def submit(case, **changes):
    return client_for(case.actor).post(
        URL.format(case.record.pk),
        {
            "request_key": str(uuid4()),
            "expected_revision": case.record.revision,
            "organization_id": None,
            "user_ids": [str(case.actor.pk)],
            **changes,
        },
        format="json",
    )


def second_speaker(case):
    speaker = models.MeetingSpeaker.objects.create(
        record=case.record,
        capture_session=case.source_job.capture,
        source_track_id="uploaded-file",
        source_key="1",
        label="Speaker 1",
        identity_type="diarized",
    )
    for i in range(3):
        models.MeetingOriginalSegment.objects.create(
            record=case.record,
            capture_session=case.source_job.capture,
            speaker=speaker,
            ingest_id=uuid4(),
            source_track_id="uploaded-file",
            source_sequence=i + 4,
            start_ms=i * 10000 + 5000,
            end_ms=i * 10000 + 9000,
            text="synthetic",
            payload_hash="b" * 64,
        )
    case.source_job.configuration["_published"]["segment_count"] = 6
    case.source_job.save(update_fields=["configuration"])
    return speaker


def publish(case, **changes):
    response = submit(case, **changes)
    assert response.status_code == 202, response.data
    batch = models.SpeakerIdentityRequest.objects.get(pk=response.data["request"]["id"])
    for job in batch.jobs.order_by("pk"):
        lease = jobs.claim(job.pk)
        query = ready(lease)
        if job.speaker_id != case.speaker.pk:
            query = replace(
                query,
                clips=tuple(
                    replace(
                        clip, start_ms=clip.start_ms + 5000, end_ms=clip.end_ms + 5000
                    )
                    for clip in query.clips
                ),
            )
        assert jobs.finish(lease, query=query)
    return batch


def decide(
    case,
    suggestion,
    action="confirm_suggestion",
    *,
    actor=None,
    revision=None,
    **changes,
):
    case.record.refresh_from_db()
    return client_for(actor or case.actor).post(
        DECISION.format(case.record.pk, suggestion.job.speaker_id),
        {
            "action": action,
            "suggestion_id": str(suggestion.pk),
            "expected_revision": case.record.revision if revision is None else revision,
            **changes,
        },
        format="json",
    )


def test_batch_submit_read_confirm_and_export_remain_separate_from_bank(case):
    batch = publish(case)
    response = client_for(case.actor).get(
        URL.format(case.record.pk), {"request_key": str(batch.request_key)}
    )
    assert (
        response.status_code == 200 and response["Cache-Control"] == "private, no-store"
    )
    card = response.data["request"]["jobs"][0]["suggestion"]
    assert card["can_confirm"] and card["candidate"]["id"] == str(case.actor.pk)
    forbidden = {
        "score",
        "margin",
        "vector",
        "embedding",
        "email",
        "requested_users",
        "source_digest",
        "lease_token",
        "audio_sha256",
    }
    assert not any(f'"{field}"' in json.dumps(response.data) for field in forbidden)
    assert len(card["query_intervals"]) == 3
    before = case.profile.samples.count(), case.profile.templates.count()
    suggestion = batch.jobs.get().suggestion
    assert decide(case, suggestion).status_code == 200
    case.speaker.refresh_from_db()
    assert (
        case.speaker.user_id == case.actor.pk
        and case.speaker.attribution_kind == "member"
    )
    assert (
        case.speaker.identity_type == "diarized" and case.speaker.label == "Speaker 0"
    )
    audit = case.record.identity_decisions.get()
    assert audit.action == "confirm_suggestion" and audit.suggestion_id == suggestion.pk
    assert before == (case.profile.samples.count(), case.profile.templates.count())
    export = client_for(case.actor).get(
        f"/api/v1.0/meeting-records/{case.record.pk}/transcript-export/", {"as": "txt"}
    )
    assert export.status_code == 200
    assert case.speaker.display_name in b"".join(export.streaming_content).decode(
        "utf-8"
    )
    assert decide(case, suggestion).status_code == 200
    assert case.record.identity_decisions.count() == 1


def test_two_completed_speakers_can_be_confirmed_sequentially(case):
    second_speaker(case)
    batch = publish(case)
    suggestions = [job.suggestion for job in batch.jobs.order_by("pk")]
    assert decide(case, suggestions[0]).status_code == 200
    response = client_for(case.actor).get(URL.format(case.record.pk))
    remaining = [
        row["suggestion"]
        for row in response.data["request"]["jobs"]
        if row["suggestion"]["state"] == "pending"
    ]
    assert len(remaining) == 1 and remaining[0]["can_confirm"]
    assert decide(case, suggestions[1]).status_code == 200
    case.record.refresh_from_db()
    assert case.record.revision == 3 and case.record.identity_decisions.count() == 2


def test_multiple_registered_identities_match_and_confirm_within_one_batch(case):
    second = second_speaker(case)
    organization, _ = org_for(case.actor)
    register(case.actor, organization)
    other = MembershipFactory(organization=organization).user
    register(other, organization, angle=math.pi / 2)
    response = submit(
        case,
        organization_id=str(organization.pk),
        user_ids=[str(case.actor.pk), str(other.pk)],
    )
    assert response.status_code == 202, response.data
    batch = models.SpeakerIdentityRequest.objects.get(pk=response.data["request"]["id"])
    for job in batch.jobs.order_by("pk"):
        lease = jobs.claim(job.pk)
        query = ready(lease)
        if job.speaker_id == second.pk:
            query = replace(
                query,
                clips=tuple(
                    replace(
                        clip,
                        start_ms=clip.start_ms + 5000,
                        end_ms=clip.end_ms + 5000,
                        vector=vector(math.pi / 2),
                    )
                    for clip in query.clips
                ),
            )
        assert jobs.finish(lease, query=query)
    cards = (
        client_for(case.actor).get(URL.format(case.record.pk)).data["request"]["jobs"]
    )
    matches = {row["speaker_id"]: row["suggestion"]["candidate"]["id"] for row in cards}
    assert matches == {
        str(case.speaker.pk): str(case.actor.pk),
        str(second.pk): str(other.pk),
    }
    for job in batch.jobs.order_by("pk"):
        assert decide(case, job.suggestion).status_code == 200
    case.speaker.refresh_from_db()
    second.refresh_from_db()
    assert case.speaker.user_id == case.actor.pk and second.user_id == other.pk
    assert case.record.identity_decisions.count() == 2


def test_partial_batch_cannot_advance_revision_while_other_targets_are_processing(case):
    second_speaker(case)
    response = submit(case)
    batch = models.SpeakerIdentityRequest.objects.get(pk=response.data["request"]["id"])
    first = batch.jobs.get(speaker=case.speaker)
    lease = jobs.claim(first.pk)
    assert jobs.finish(lease, query=ready(lease))
    state = client_for(case.actor).get(URL.format(case.record.pk)).data["request"]
    assert state["processing"]
    card = next(row["suggestion"] for row in state["jobs"] if row["suggestion"])
    assert not card["can_confirm"]
    for action in ("confirm_suggestion", "reject_suggestion"):
        result = decide(case, first.suggestion, action)
        assert (
            result.status_code == 409
            and result.data["code"] == "voiceprint_identity_request_processing"
        )
    first.suggestion.refresh_from_db()
    assert (
        first.suggestion.state == "pending"
        and not case.record.identity_decisions.exists()
    )
    other = batch.jobs.exclude(pk=first.pk).get()
    other_lease = jobs.claim(other.pk)
    query = ready(other_lease)
    query = replace(
        query,
        clips=tuple(
            replace(clip, start_ms=clip.start_ms + 5000, end_ms=clip.end_ms + 5000)
            for clip in query.clips
        ),
    )
    assert jobs.finish(other_lease, query=query)
    assert decide(case, first.suggestion).status_code == 200
    assert decide(case, other.suggestion).status_code == 200


def test_default_batch_skips_manual_choice_and_explicit_selection_protects_it(case):
    second = second_speaker(case)
    result = client_for(case.actor).post(
        DECISION.format(case.record.pk, case.speaker.pk),
        {"action": "set_label", "label": "Human", "expected_revision": 1},
        format="json",
    )
    assert result.status_code == 200
    case.record.refresh_from_db()
    assert submit(case, speaker_ids=[str(case.speaker.pk)]).status_code == 409
    response = submit(case)
    assert response.status_code == 202
    assert [row["speaker_id"] for row in response.data["request"]["jobs"]] == [
        str(second.pk)
    ]


def test_read_revalidates_pool_once_per_batch_and_clears_stale_pending_names(
    case, monkeypatch
):
    second_speaker(case)
    batch = publish(case)
    original = jobs.candidates.load_pool
    calls = []

    def counted(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(jobs.candidates, "load_pool", counted)
    assert client_for(case.actor).get(URL.format(case.record.pk)).status_code == 200
    assert len(calls) == 1
    models.MeetingOriginalSegment.objects.filter(record=case.record).update(
        payload_hash="c" * 64
    )
    response = client_for(case.actor).get(URL.format(case.record.pk))
    assert all(
        row["suggestion"]["candidate"] is None
        and row["suggestion"]["state"] == "invalidated"
        for row in response.data["request"]["jobs"]
    )
    assert not models.SpeakerIdentitySuggestion.objects.filter(
        job__batch=batch, candidate__isnull=False
    ).exists()


def test_policy_file_failure_is_recoverable_and_never_exposes_candidate(case, settings):
    batch = publish(case)
    suggestion = batch.jobs.get().suggestion
    path = Path(settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE)
    original = path.read_bytes()
    path.unlink()
    response = client_for(case.actor).get(URL.format(case.record.pk))
    card = response.data["request"]["jobs"][0]["suggestion"]
    assert card["candidate"] is None and card["verification_unavailable"]
    assert decide(case, suggestion).status_code == 503
    suggestion.refresh_from_db()
    assert suggestion.state == "pending"
    path.write_bytes(original)
    assert decide(case, suggestion).status_code == 200


def test_disabled_submission_does_not_read_calibration_configuration(
    case, settings, monkeypatch
):
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    monkeypatch.setattr(
        jobs,
        "policy",
        lambda: pytest.fail("Disabled matching must not read private configuration"),
    )
    response = submit(case)
    assert (
        response.status_code == 503
        and response.data["code"] == "voiceprint_matching_disabled"
    )
    assert not models.SpeakerIdentityRequest.objects.exists()


def test_read_expires_a_queued_job_before_the_worker_sweep(case):
    response = submit(case)
    job_id = response.data["request"]["jobs"][0]["id"]
    models.SpeakerIdentityJob.objects.filter(pk=job_id).update(
        expires_at=timezone.now() - timezone.timedelta(seconds=1),
    )
    response = client_for(case.actor).get(URL.format(case.record.pk))
    assert response.status_code == 200
    assert response.data["request"]["jobs"][0]["status"] == "expired"
    assert not response.data["request"]["processing"]


def test_source_deletion_cascades_batch_history_and_preserves_independent_bank(case):
    batch = publish(case)
    assert decide(case, batch.jobs.get().suggestion).status_code == 200
    batch_id = batch.pk
    case.record.delete()
    assert not models.SpeakerIdentityRequest.objects.filter(pk=batch_id).exists()
    assert not models.SpeakerIdentityJob.objects.exists()
    assert not models.SpeakerIdentitySuggestion.objects.exists()
    assert not models.SpeakerIdentityDecision.objects.exists()
    case.profile.refresh_from_db()
    assert case.profile.samples.count() == 3 and case.profile.templates.count() == 1


def test_reject_is_audited_clears_candidate_and_does_not_name_or_enroll(case):
    batch = publish(case)
    suggestion = batch.jobs.get().suggestion
    before = case.profile.samples.count()
    assert decide(case, suggestion, "reject_suggestion").status_code == 200
    suggestion.refresh_from_db()
    case.speaker.refresh_from_db()
    assert suggestion.state == "rejected" and suggestion.candidate_id is None
    assert suggestion.score is None and suggestion.margin is None
    assert case.speaker.user_id is None and case.profile.samples.count() == before
    assert case.record.identity_decisions.get().action == "reject_suggestion"
    assert decide(case, suggestion, "reject_suggestion").status_code == 200
    assert decide(case, suggestion).status_code == 409


@pytest.mark.parametrize(
    "changes",
    [
        {"organization_id": "missing"},
        {"expected_revision": True},
        {"expected_revision": "1"},
        {"expected_revision": 1.0},
        {"user_ids": []},
        {"user_ids": [str(uuid4())] * 51},
        {"speaker_ids": []},
        {"audio_url": "https://invalid.test"},
        {"label": "Fake"},
    ],
)
def test_invalid_submission_never_creates_a_request(case, changes):
    assert submit(case, **changes).status_code == 400
    assert not models.SpeakerIdentityRequest.objects.exists()


def test_scope_is_explicit_duplicates_and_out_of_record_targets_are_rejected(case):
    assert submit(case, user_ids=[str(case.actor.pk)] * 2).status_code == 400
    assert submit(case, speaker_ids=[str(uuid4())]).status_code == 404
    assert submit(case, speaker_ids=[str(case.speaker.pk)] * 2).status_code == 400
    body = {
        "request_key": str(uuid4()),
        "expected_revision": 1,
        "user_ids": [str(case.actor.pk)],
    }
    assert (
        client_for(case.actor)
        .post(URL.format(case.record.pk), body, format="json")
        .status_code
        == 400
    )


def test_batch_replay_conflicts_when_target_set_changes_and_is_atomic_at_budget(case):
    second = second_speaker(case)
    key = str(uuid4())
    one = submit(case, request_key=key, speaker_ids=[str(case.speaker.pk)])
    assert one.status_code == 202
    assert (
        submit(case, request_key=key, speaker_ids=[str(case.speaker.pk)]).data
        == one.data
    )
    assert (
        submit(case, request_key=key, speaker_ids=[str(second.pk)]).status_code == 409
    )
    job = models.SpeakerIdentityJob.objects.get()
    fields = {
        field.attname: getattr(job, field.attname)
        for field in job._meta.concrete_fields
        if field.name not in {"id", "created_at", "updated_at", "request_key", "batch"}
    }
    models.SpeakerIdentityJob.objects.bulk_create(
        [models.SpeakerIdentityJob(**fields, request_key=uuid4()) for _ in range(98)]
    )
    assert submit(case).status_code == 429
    assert models.SpeakerIdentityRequest.objects.count() == 1
    assert models.SpeakerIdentityJob.objects.count() == 99


@pytest.mark.parametrize("role,media", [("reader", True), ("editor", False)])
def test_read_only_and_editor_without_media_cannot_see_or_control_suggestions(
    case, role, media
):
    batch = publish(case)
    viewer = UserFactory()
    models.MeetingCollaborator.objects.create(
        record=case.record, scope="record", user=viewer, role=role, media=media
    )
    client = client_for(viewer)
    assert client.get(URL.format(case.record.pk)).status_code == 404
    assert (
        client.delete(
            URL.format(case.record.pk),
            {"request_key": str(batch.request_key), "expected_revision": 1},
            format="json",
        ).status_code
        == 404
    )
    assert decide(case, batch.jobs.get().suggestion, actor=viewer).status_code == 404


def test_personal_bank_is_not_visible_to_another_media_editor(case):
    batch = publish(case)
    viewer = UserFactory()
    models.MeetingCollaborator.objects.create(
        record=case.record, scope="record", user=viewer, role="editor", media=True
    )
    client = client_for(viewer)
    assert client.get(URL.format(case.record.pk)).data["request"] is None
    assert (
        client.get(
            URL.format(case.record.pk), {"request_key": str(batch.request_key)}
        ).status_code
        == 404
    )
    assert decide(case, batch.jobs.get().suggestion, actor=viewer).status_code == 404


def test_shared_org_bank_can_be_confirmed_only_by_current_org_media_editor(case):
    organization, _ = org_for(case.actor)
    register(case.actor, organization)
    batch = publish(case, organization_id=str(organization.pk))
    viewer = MembershipFactory(organization=organization).user
    grant = models.MeetingCollaborator.objects.create(
        record=case.record, scope="record", user=viewer, role="editor", media=True
    )
    assert (
        client_for(viewer)
        .get(URL.format(case.record.pk))
        .data["request"]["jobs"][0]["suggestion"]["can_confirm"]
    )
    assert decide(case, batch.jobs.get().suggestion, actor=viewer).status_code == 200
    assert case.record.identity_decisions.get().actor_id == viewer.pk
    models.Membership.objects.filter(user=viewer, organization=organization).update(
        status="left"
    )
    assert client_for(viewer).get(URL.format(case.record.pk)).data["request"] is None


@pytest.mark.parametrize(
    "change",
    ["source", "lifecycle", "target", "actor", "expired", "candidate", "missing_proof"],
)
def test_stale_confirmation_never_changes_final_identity_and_commits_invalidation(
    case, change
):
    batch = publish(case)
    job = batch.jobs.get()
    suggestion = job.suggestion
    if change == "source":
        models.MeetingOriginalSegment.objects.filter(record=case.record).update(
            payload_hash="c" * 64
        )
    elif change == "lifecycle":
        models.MeetingRecord.objects.filter(pk=case.record.pk).update(
            lifecycle_revision=2
        )
    elif change == "target":
        models.MeetingSpeaker.objects.filter(pk=case.speaker.pk).update(
            manual_label="Human", attribution_kind="custom"
        )
    elif change == "actor":
        models.User.objects.filter(pk=case.actor.pk).update(is_active=False)
    elif change == "expired":
        models.SpeakerIdentityJob.objects.filter(pk=job.pk).update(
            expires_at=timezone.now() - timezone.timedelta(seconds=1)
        )
    elif change == "candidate":
        models.VoiceprintConsent.objects.filter(pk=case.profile.consent_id).update(
            allow_identification=False
        )
    else:
        models.SpeakerIdentityJob.objects.filter(pk=job.pk).update(
            presentation_digest=""
        )
    response = decide(case, suggestion)
    assert response.status_code in {403, 409}
    case.speaker.refresh_from_db()
    assert case.speaker.user_id is None and not case.record.identity_decisions.exists()
    if change != "actor":
        suggestion.refresh_from_db()
        assert suggestion.state == "invalidated" and suggestion.candidate_id is None


def test_temporary_key_failure_hides_candidate_and_preserves_recoverable_suggestion(
    case, settings
):
    batch = publish(case)
    suggestion = batch.jobs.get().suggestion
    path = Path(settings.MEETING_VOICEPRINT_KEYRING_FILE)
    previous = path.read_bytes()
    path.write_bytes(b"synthetic unavailable keyring")
    response = client_for(case.actor).get(URL.format(case.record.pk))
    card = response.data["request"]["jobs"][0]["suggestion"]
    assert (
        card["candidate"] is None
        and not card["can_confirm"]
        and card["verification_unavailable"]
    )
    assert decide(case, suggestion).status_code == 503
    suggestion.refresh_from_db()
    assert suggestion.state == "pending"
    path.write_bytes(previous)
    assert decide(case, suggestion).status_code == 200


def test_cancel_disables_running_lease_without_asr_or_source_changes(case, settings):
    response = submit(case)
    batch = models.SpeakerIdentityRequest.objects.get(pk=response.data["request"]["id"])
    job = batch.jobs.get()
    lease = jobs.claim(job.pk)
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    client = client_for(case.actor)
    data = {"request_key": str(batch.request_key), "expected_revision": 1}
    assert (
        client.delete(URL.format(case.record.pk), data, format="json").status_code
        == 200
    )
    assert (
        client.delete(URL.format(case.record.pk), data, format="json").status_code
        == 200
    )
    assert not jobs.authorized(lease) and not jobs.finish(lease, query=ready(lease))
    case.record.refresh_from_db()
    case.source_job.refresh_from_db()
    assert case.record.revision == 1 and case.source_job.status == "succeeded"


@pytest.mark.parametrize(
    "changes",
    [
        {"user_id": str(uuid4())},
        {"label": "Fake"},
        {"score": 1},
        {"contact_ref": "fake"},
    ],
)
def test_confirmation_payload_cannot_forge_candidate_or_score(case, changes):
    batch = publish(case)
    assert decide(case, batch.jobs.get().suggestion, **changes).status_code == 400
    assert not case.record.identity_decisions.exists()


def test_manual_edit_stale_revision_and_account_header_protect_confirmation(case):
    batch = publish(case)
    suggestion = batch.jobs.get().suggestion
    url = DECISION.format(case.record.pk, case.speaker.pk)
    data = {
        "action": "confirm_suggestion",
        "suggestion_id": str(suggestion.pk),
        "expected_revision": 1,
    }
    assert (
        client_for(case.actor)
        .post(url, data, format="json", HTTP_X_VOICEPRINT_OWNER=str(uuid4()))
        .status_code
        == 401
    )
    assert decide(case, suggestion, revision=2).status_code == 409
    assert (
        client_for(case.actor)
        .post(
            url,
            {"action": "set_label", "label": "Human", "expected_revision": 1},
            format="json",
        )
        .status_code
        == 200
    )
    assert decide(case, suggestion).status_code == 409
    case.speaker.refresh_from_db()
    assert case.speaker.manual_label == "Human"


@pytest.mark.django_db(transaction=True)
def test_concurrent_confirmation_creates_one_audit(case):
    batch = publish(case)
    suggestion = batch.jobs.get().suggestion

    def worker():
        close_old_connections()
        try:
            return decide(case, suggestion, revision=1).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: worker(), range(2)))
    assert sorted(results) == [200, 409] and case.record.identity_decisions.count() == 1
