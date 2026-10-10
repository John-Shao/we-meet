"""Real DB/source/template coordination using synthetic features and permissions."""

import json
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

from django.db import IntegrityError, close_old_connections, connection, transaction
from django.db.models import F
from django.utils import timezone

import pytest

from core import models
from core.services import speaker_identity_decisions as decisions
from core.services import speaker_identity_jobs as service
from core.services import voiceprint_candidates as candidates
from core.services import voiceprint_consent as consent
from core.services import voiceprint_sources as sources
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_media_process import MediaError
from core.services.voiceprint_query_producer import ProducedQuery
from core.services.voiceprint_rpc_process import extract as actual_extract
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_voiceprint_candidates import (
    matching_enabled,
    member_profile,
    register,
)
from core.tests.services.test_voiceprint_consent import enabled, org_for
from core.tests.test_services_voiceprint_matching import clips, policy
from core.tests.test_services_voiceprint_quality_process import short_asr
from core.tests.test_services_voiceprint_query_producer import actual_encoder, pipeline
from core.tests.test_services_voiceprint_source_storage import private_s3, proof
from core.tests.test_services_voiceprint_sources import published

pytestmark = pytest.mark.django_db
REAL_SOURCE_AUTHORIZED, REAL_SOURCE_REVALIDATE = sources.authorized, sources.revalidate


@pytest.fixture
def case(published):
    actor, record, source_job, speaker = published
    profile = register(actor)
    return SimpleNamespace(
        actor=actor,
        record=record,
        source_job=source_job,
        speaker=speaker,
        profile=profile,
    )


def enqueue(case, **changes):
    return service.enqueue(
        case.record,
        case.actor,
        **{
            "speaker_id": case.speaker.pk,
            "organization_id": None,
            "user_ids": [case.actor.pk],
            "expected_revision": case.record.revision,
            "request_key": uuid4(),
            **changes,
        },
    )


def ready(lease, **changes):
    query = tuple(
        replace(clip, start_ms=clip.start_ms + 100, end_ms=clip.end_ms + 100)
        for clip in clips()
    )
    return ProducedQuery(
        **{
            "status": "ready",
            "reason": "quality_passed",
            "source_digest": lease.source.fingerprint,
            "clips": query,
            "media_sha256": lease.source.receipt.sha256,
            "speaker_id": lease.speaker_id,
            **changes,
        }
    )


def test_publication_is_separate_from_attribution_and_voiceprint_storage(case):
    job = enqueue(case)
    samples = case.profile.samples.count()
    lease = service.claim(job.pk)
    assert lease and service.authorized(lease)
    assert service.finish(lease, query=ready(lease))
    job.refresh_from_db()
    assert job.status == "succeeded" and job.attempts == 1 and job.lease_token is None
    suggestion = job.suggestion
    assert suggestion.state == "pending" and suggestion.candidate_id == case.actor.pk
    assert suggestion.result == "suggested" and suggestion.clip_count == 3
    assert suggestion.query_intervals == [
        {"start_ms": clip.start_ms, "end_ms": clip.end_ms}
        for clip in ready(lease).clips
    ]
    assert all(
        len(value) == 64
        for value in (
            job.source_generation_digest,
            job.candidate_context_digest,
            job.presentation_digest,
        )
    )
    case.speaker.refresh_from_db()
    case.record.refresh_from_db()
    assert case.speaker.user_id is None and case.speaker.attribution_kind == "none"
    assert case.record.revision == 1 and case.record.identity_decisions.count() == 0
    assert (
        case.profile.samples.count() == samples and case.profile.templates.count() == 1
    )
    assert "vector" not in repr(lease) and str(case.actor.pk) not in str(suggestion)
    assert not service.finish(lease, query=ready(lease))


def test_semantic_context_survives_only_a_display_revision_change(case):
    job = enqueue(case)
    old_source, old_pool, _ = service.context(job)
    models.MeetingRecord.objects.filter(pk=case.record.pk).update(revision=2)
    with pytest.raises(VoiceprintError, match="record_changed"):
        service.context(job)
    source, pool, _ = service.context(job, current_revision=2)
    assert source.generation_digest == old_source.generation_digest
    assert pool.context_digest == old_pool.context_digest
    assert source.fingerprint != old_source.fingerprint
    assert pool.fingerprint != old_pool.fingerprint


@pytest.mark.parametrize(
    "change", ["source", "lifecycle", "candidate", "presentation", "legacy", "expired"]
)
def test_semantic_context_does_not_relax_source_or_identity_guards(case, change):
    job = enqueue(case)
    models.MeetingRecord.objects.filter(pk=case.record.pk).update(revision=2)
    if change == "source":
        models.MeetingOriginalSegment.objects.filter(record=case.record).update(
            payload_hash="b" * 64
        )
    elif change == "lifecycle":
        models.MeetingRecord.objects.filter(pk=case.record.pk).update(
            lifecycle_revision=F("lifecycle_revision") + 1
        )
    elif change == "candidate":
        case.profile.templates.update(revision=F("revision") + 1)
    elif change == "presentation":
        models.MeetingSpeaker.objects.filter(pk=case.speaker.pk).update(
            manual_label="Human", attribution_kind="custom"
        )
    elif change == "expired":
        job.expires_at = timezone.now() - timezone.timedelta(seconds=1)
    else:
        job.source_generation_digest = ""
    with pytest.raises(
        VoiceprintError, match="context_changed|templates_unavailable|identity_expired"
    ) as error:
        service.context(job, current_revision=2)
    assert error.value.status == (503 if change == "candidate" else 409)


@pytest.mark.parametrize("moment", ["queued", "running", "published"])
def test_manual_identity_edit_cancels_target_and_removes_pending_name(case, moment):
    job = enqueue(case)
    lease = service.claim(job.pk) if moment != "queued" else None
    if moment == "published":
        assert service.finish(lease, query=ready(lease))
    decisions.decide(
        case.record,
        case.speaker.pk,
        case.actor,
        action="set_label",
        expected_revision=1,
        label="Human choice",
    )
    job.refresh_from_db()
    assert job.status == "canceled" and job.lease_token is None
    if lease is not None:
        assert not service.authorized(lease)
        assert not service.finish(lease, query=ready(lease))
    if moment == "published":
        suggestion = job.suggestion
        assert suggestion.state == "invalidated" and suggestion.candidate_id is None
        assert suggestion.score is None and suggestion.margin is None
    assert case.record.identity_decisions.count() == 1
    assert case.profile.templates.count() == 1


def test_manual_target_change_without_record_bump_still_blocks_worker(case):
    job = enqueue(case)
    lease = service.claim(job.pk)
    models.MeetingSpeaker.objects.filter(pk=case.speaker.pk).update(
        manual_label="Human", attribution_kind="custom"
    )
    assert not service.authorized(lease)
    assert not service.finish(lease, query=ready(lease))
    assert not models.SpeakerIdentitySuggestion.objects.exists()


def test_retryable_failures_still_consume_submission_budget(case):
    first = enqueue(case)
    models.SpeakerIdentityJob.objects.bulk_create(
        [replace_job(first, request_key=uuid4()) for _ in range(99)]
    )
    models.SpeakerIdentityJob.objects.filter(requester=case.actor).update(
        status="failed",
        retryable=True,
        attempts=1,
    )
    with pytest.raises(VoiceprintError, match="budget_exceeded"):
        enqueue(case)
    assert enqueue(case, request_key=first.request_key).pk == first.pk


def test_expired_jobs_do_not_block_new_submission_before_worker_sweep(case):
    first = enqueue(case)
    models.SpeakerIdentityJob.objects.bulk_create(
        [replace_job(first, request_key=uuid4()) for _ in range(99)]
    )
    models.SpeakerIdentityJob.objects.filter(requester=case.actor).update(
        expires_at=timezone.now() - timezone.timedelta(seconds=1),
    )
    assert enqueue(case).status == "queued"


def replace_job(job, *, request_key):
    # Copy persisted public job fields without running the same submit transaction.
    fields = {
        field.attname: getattr(job, field.attname)
        for field in job._meta.concrete_fields
        if field.name not in {"id", "created_at", "updated_at", "request_key"}
    }
    return models.SpeakerIdentityJob(request_key=request_key, **fields)


def test_unregistered_candidate_deletion_floor_invalidates_frozen_context(published):
    actor, record, _, speaker = published
    case = SimpleNamespace(actor=actor, record=record, speaker=speaker)
    job = enqueue(case)
    models.VoiceprintDeletionJob.objects.create(
        owner_id=actor.pk,
        request_key=uuid4(),
        expected_version=0,
        revoked_generation=1,
    )
    with pytest.raises(VoiceprintError, match="context_changed"):
        service.context(job)


def test_identical_request_replays_but_changed_source_conflicts(case):
    key = uuid4()
    first = enqueue(case, request_key=key)
    assert enqueue(case, request_key=key).pk == first.pk
    models.MeetingOriginalSegment.objects.filter(record=case.record).update(
        payload_hash="b" * 64
    )
    with pytest.raises(VoiceprintError, match="request_changed"):
        enqueue(case, request_key=key)
    assert models.SpeakerIdentityJob.objects.count() == 1


@pytest.mark.parametrize(
    "change", ["speaker", "revision", "candidates", "disabled", "uncalibrated"]
)
def test_invalid_request_never_creates_a_job(case, settings, change):
    parameters = {}
    if change == "speaker":
        parameters["speaker_id"] = uuid4()
    elif change == "revision":
        parameters["expected_revision"] = True
    elif change == "candidates":
        parameters["user_ids"] = [uuid4()]
    elif change == "disabled":
        settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    else:
        Path(settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE).write_text(
            json.dumps(asdict(policy(calibrated=False)))
        )
    with pytest.raises(VoiceprintError):
        enqueue(case, **parameters)
    assert not models.SpeakerIdentityJob.objects.exists()


def test_reclaimed_lease_cannot_be_finished_by_old_worker(case):
    job = enqueue(case)
    old = service.claim(job.pk)
    assert service.claim(job.pk) is None
    models.SpeakerIdentityJob.objects.filter(pk=job.pk).update(
        lease_until=timezone.now() - timezone.timedelta(seconds=1)
    )
    new = service.claim(job.pk)
    assert new and new.token != old.token and not service.authorized(old)
    assert not service.finish(old, query=ready(old))
    assert service.finish(new, query=ready(new))
    job.refresh_from_db()
    assert job.attempts == 2 and models.SpeakerIdentitySuggestion.objects.count() == 1


def test_provider_failure_has_three_attempts_and_never_persists_error_body(case):
    job = enqueue(case)
    for attempt in range(1, 4):
        lease = service.claim(job.pk)
        assert lease
        assert service.finish(
            lease, error=MediaError("secret provider URL/body", retryable=True)
        )
        job.refresh_from_db()
        assert (
            job.attempts == attempt
            and job.error_code == "identity_provider_unavailable"
        )
        assert job.retryable == (attempt < 3)
    assert service.claim(job.pk) is None and not service.pending_ids(100)
    assert not models.SpeakerIdentitySuggestion.objects.exists()


@pytest.mark.parametrize("moment", ["queued", "running", "published"])
def test_revocation_cancels_tasks_and_clears_pending_associations(case, moment):
    job = enqueue(case)
    lease = None
    if moment != "queued":
        lease = service.claim(job.pk)
    if moment == "published":
        assert service.finish(lease, query=ready(lease))
    case.profile.consent.refresh_from_db()
    consent.update_settings(
        case.actor,
        organization_id=None,
        expected_version=case.profile.consent.version,
        changes={"allow_identification": False},
    )
    job.refresh_from_db()
    assert job.status == "canceled" and job.lease_token is None
    assert service.claim(job.pk) is None
    if lease:
        assert not service.authorized(lease) and not service.finish(
            lease, query=ready(lease)
        )
    if moment == "published":
        suggestion = job.suggestion
        assert suggestion.state == "invalidated" and suggestion.candidate_id is None
        assert suggestion.score is None and suggestion.margin is None


@pytest.mark.parametrize(
    "change", ["source", "record", "template", "candidate", "policy", "expired"]
)
def test_context_changes_prevent_publication(case, settings, change):
    job = enqueue(case)
    lease = service.claim(job.pk)
    if change == "source":
        models.MeetingOriginalSegment.objects.filter(record=case.record).update(
            payload_hash="b" * 64
        )
    elif change == "record":
        models.MeetingRecord.objects.filter(pk=case.record.pk).update(
            revision=F("revision") + 1
        )
    elif change == "template":
        case.profile.templates.update(revision=F("revision") + 1)
    elif change == "candidate":
        models.User.objects.filter(pk=case.actor.pk).update(is_active=False)
    elif change == "policy":
        Path(settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE).write_text(
            json.dumps(asdict(policy(threshold_version="synthetic-v2")))
        )
    else:
        models.SpeakerIdentityJob.objects.filter(pk=job.pk).update(
            expires_at=timezone.now() - timezone.timedelta(seconds=1)
        )
    assert not service.finish(lease, query=ready(lease))
    assert not models.SpeakerIdentitySuggestion.objects.exists()


@pytest.mark.parametrize(
    "bad",
    [
        "source",
        "speaker",
        "media",
        "media_type",
        "status_type",
        "reason_type",
        "interval",
        "feature",
        "reason",
    ],
)
def test_invalid_query_evidence_is_not_published(case, bad):
    job = enqueue(case)
    lease = service.claim(job.pk)
    query = ready(lease)
    if bad == "source":
        query = replace(query, source_digest="b" * 64)
    elif bad == "speaker":
        query = replace(query, speaker_id=uuid4())
    elif bad == "media":
        query = replace(query, media_sha256="b" * 64)
    elif bad == "media_type":
        query = replace(query, media_sha256=1)
    elif bad == "status_type":
        query = replace(query, status=["ready"], clips=())
    elif bad == "reason_type":
        query = replace(query, status="unavailable", reason=[], clips=())
    elif bad == "interval":
        query = replace(
            query,
            clips=tuple(
                replace(clip, start_ms=clip.start_ms + 5000, end_ms=clip.end_ms + 5000)
                for clip in query.clips
            ),
        )
    elif bad == "feature":
        query = replace(
            query, clips=tuple(replace(clip, vector=(1.0,)) for clip in query.clips)
        )
    else:
        query = replace(
            query, status="unavailable", reason="untrusted arbitrary text", clips=()
        )
    assert not service.finish(lease, query=query)
    job.refresh_from_db()
    assert job.status == "failed" and not job.retryable
    assert not models.SpeakerIdentitySuggestion.objects.exists()


def test_policy_change_during_scoring_is_checked_again_before_commit(
    case, settings, monkeypatch
):
    job = enqueue(case)
    lease = service.claim(job.pk)
    original = service.matching.match

    def changed(*args, **kwargs):
        result = original(*args, **kwargs)
        Path(settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE).write_text(
            json.dumps(asdict(policy(threshold_version="synthetic-v2")))
        )
        return result

    monkeypatch.setattr(service.matching, "match", changed)
    assert not service.finish(lease, query=ready(lease))
    assert not models.SpeakerIdentitySuggestion.objects.exists()


def test_fast_candidate_check_does_not_decrypt_templates(case, monkeypatch):
    pool = candidates.load_pool(
        case.record,
        case.actor,
        organization_id=None,
        user_ids=[case.actor.pk],
        expected_revision=1,
    )
    monkeypatch.setattr(
        candidates, "load_keyring", lambda: pytest.fail("Fast polling must not decrypt")
    )
    assert candidates.authorized(pool)
    case.profile.templates.update(status="paused")
    assert not candidates.authorized(pool)


def test_revoking_nonwinning_candidate_invalidates_the_entire_pending_pool(case):
    organization, _ = org_for(case.actor)
    register(case.actor, organization)
    other, profile = member_profile(organization, angle=math.pi / 2)
    job = enqueue(
        case, organization_id=organization.pk, user_ids=[case.actor.pk, other.pk]
    )
    lease = service.claim(job.pk)
    assert service.finish(lease, query=ready(lease))
    assert job.suggestion.candidate_id == case.actor.pk
    profile.consent.refresh_from_db()
    consent.update_settings(
        other,
        organization_id=organization.pk,
        expected_version=profile.consent.version,
        changes={"allow_identification": False},
    )
    suggestion = models.SpeakerIdentitySuggestion.objects.get(job=job)
    assert suggestion.state == "invalidated" and suggestion.candidate_id is None


def test_explicit_org_policy_version_invalidates_fast_gate_on_personal_record(case):
    organization, _ = org_for(case.actor)
    register(case.actor, organization)
    job = enqueue(case, organization_id=organization.pk)
    lease = service.claim(job.pk)
    assert service.authorized(lease)
    models.Organization.objects.filter(pk=organization.pk).update(
        settings={"voiceprint": {"enabled": True, "version": 2}}
    )
    assert not service.authorized(lease)


def test_unavailable_keys_retry_before_audio_and_recover_with_current_context(
    case, settings
):
    job = enqueue(case)
    path = Path(settings.MEETING_VOICEPRINT_KEYRING_FILE)
    keyring = path.read_bytes()
    path.write_bytes(b"invalid synthetic keyring")
    assert service.claim(job.pk) is None
    job.refresh_from_db()
    assert job.status == "failed" and job.retryable and job.attempts == 1
    path.write_bytes(keyring)
    lease = service.claim(job.pk)
    assert lease and service.authorized(lease)


def test_queue_scan_is_ordered_bounded_and_rejects_boolean_limit(case):
    first, second = enqueue(case), enqueue(case)
    assert service.pending_ids(1) == [first.pk]
    assert service.pending_ids(2) == [first.pk, second.pk]
    with pytest.raises(VoiceprintError):
        service.pending_ids(True)


def test_disabled_worker_does_not_require_provider_configuration(settings):
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    assert (
        service.process_one(
            uuid4(),
            media_config=None,
            storage_config=None,
            encoder_config=None,
            quality_config=None,
        )
        == "skipped"
    )


def test_requester_budget_stops_new_jobs_but_allows_identical_replay(case):
    job = enqueue(case)
    fields = {
        field.attname: getattr(job, field.attname)
        for field in job._meta.concrete_fields
        if field.name not in {"id", "created_at", "updated_at", "request_key"}
    }
    models.SpeakerIdentityJob.objects.bulk_create(
        [models.SpeakerIdentityJob(**fields, request_key=uuid4()) for _ in range(99)]
    )
    assert enqueue(case, request_key=job.request_key).pk == job.pk
    with pytest.raises(VoiceprintError, match="budget_exceeded"):
        enqueue(case)


def test_source_deletion_removes_job_and_suggestion_without_voiceprint_enrollment(case):
    job = enqueue(case)
    lease = service.claim(job.pk)
    assert service.finish(lease, query=ready(lease))
    case.record.delete()
    assert not models.SpeakerIdentityJob.objects.filter(pk=job.pk).exists()
    assert not models.SpeakerIdentitySuggestion.objects.exists()
    assert models.VoiceprintProfile.objects.filter(pk=case.profile.pk).exists()


def test_expiry_and_exhausted_lease_are_terminal(case):
    job = enqueue(case)
    models.SpeakerIdentityJob.objects.filter(pk=job.pk).update(
        expires_at=timezone.now() - timezone.timedelta(seconds=1)
    )
    assert service.claim(job.pk) is None
    job.refresh_from_db()
    assert job.status == "expired"
    other = enqueue(case)
    models.SpeakerIdentityJob.objects.filter(pk=other.pk).update(
        status="running", attempts=3, lease_until=None
    )
    assert service.claim(other.pk) is None
    other.refresh_from_db()
    assert other.status == "failed" and not other.retryable


def test_database_limits_and_request_uniqueness(case):
    job = enqueue(case)
    fields = {
        field.attname: getattr(job, field.attname)
        for field in job._meta.concrete_fields
        if field.name not in {"id", "created_at", "updated_at"}
    }
    with pytest.raises(IntegrityError), transaction.atomic():
        models.SpeakerIdentityJob.objects.bulk_create(
            [models.SpeakerIdentityJob(**fields)]
        )
    with pytest.raises(IntegrityError), transaction.atomic():
        models.SpeakerIdentityJob.objects.filter(pk=job.pk).update(attempts=4)
    lease = service.claim(job.pk)
    assert service.finish(lease, query=ready(lease))
    with pytest.raises(IntegrityError), transaction.atomic():
        models.SpeakerIdentitySuggestion.objects.filter(job=job).update(score=2)
    with pytest.raises(IntegrityError), transaction.atomic():
        models.SpeakerIdentitySuggestion.objects.filter(job=job).update(clip_count=13)


@pytest.mark.django_db(transaction=True)
def test_two_workers_cannot_claim_the_same_live_lease(case):
    job = enqueue(case)

    def worker():
        close_old_connections()
        try:
            return service.claim(job.pk)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as workers:
        leases = list(workers.map(lambda _: worker(), range(2)))
    assert sum(lease is not None for lease in leases) == 1
    job.refresh_from_db()
    assert job.status == "running" and job.attempts == 1


def test_no_templates_finishes_without_reading_audio_or_calling_providers(
    published, monkeypatch
):
    actor, record, source_job, speaker = published
    case = SimpleNamespace(
        actor=actor, record=record, source_job=source_job, speaker=speaker
    )
    job = enqueue(case)
    monkeypatch.setattr(
        service.producer,
        "produce",
        lambda *args, **kwargs: pytest.fail(
            "No authorized template must not incur provider calls"
        ),
    )
    assert (
        service.process_one(
            job.pk,
            **{
                name: mock.Mock()
                for name in (
                    "media_config",
                    "storage_config",
                    "encoder_config",
                    "quality_config",
                )
            },
        )
        == "succeeded"
    )
    suggestion = models.SpeakerIdentitySuggestion.objects.get(job=job)
    assert (
        suggestion.result == "unavailable"
        and suggestion.reason == "no_authorized_templates"
    )
    assert suggestion.candidate_id is None


def test_registration_between_claim_and_empty_pool_finish_reports_canceled(
    published, monkeypatch
):
    actor, record, source_job, speaker = published
    case = SimpleNamespace(
        actor=actor, record=record, source_job=source_job, speaker=speaker
    )
    job = enqueue(case)
    original = service.finish

    def changed(lease, **kwargs):
        register(actor)
        return original(lease, **kwargs)

    monkeypatch.setattr(service, "finish", changed)
    assert (
        service.process_one(
            job.pk,
            **{
                name: mock.Mock()
                for name in (
                    "media_config",
                    "storage_config",
                    "encoder_config",
                    "quality_config",
                )
            },
        )
        == "canceled"
    )
    assert not models.SpeakerIdentitySuggestion.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_provider_is_called_outside_transaction_and_retry_class_is_preserved(
    case, monkeypatch
):
    job = enqueue(case)

    def fail(*args, **kwargs):
        assert not connection.in_atomic_block and kwargs["authorized"]()
        raise MediaError("secret diagnostic", retryable=True)

    monkeypatch.setattr(service.producer, "produce", fail)
    assert (
        service.process_one(
            job.pk,
            **{
                name: mock.Mock()
                for name in (
                    "media_config",
                    "storage_config",
                    "encoder_config",
                    "quality_config",
                )
            },
        )
        == "failed"
    )
    job.refresh_from_db()
    assert job.retryable and job.error_code == "identity_provider_unavailable"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("entry", ["internal", "public"])
def test_actual_qwen_private_source_to_persisted_database_result(  # noqa: PLR0913 -- Actual DB, decoder, model and private HTTP fixtures.
    case, pipeline, actual_encoder, short_asr, private_s3, monkeypatch, entry
):
    monkeypatch.setattr(sources, "authorized", REAL_SOURCE_AUTHORIZED)
    monkeypatch.setattr(sources, "revalidate", REAL_SOURCE_REVALIDATE)
    source_proof = proof(private_s3, kind="content_sha256")
    case.source_job.size = source_proof.size
    case.source_job.checksum = source_proof.sha256
    case.source_job.configuration["_identity_source"] = source_proof.payload()
    case.source_job.save()
    short_asr.duration = 3800
    encoded = []
    extract = service.producer.query.encoder_process.extract

    def encode(wav, **kwargs):
        assert not connection.in_atomic_block
        result = actual_extract(wav, **kwargs)
        encoded.append(result)
        return result

    monkeypatch.setattr(service.producer.query.encoder_process, "extract", encode)
    url = f"/api/v1.0/meeting-records/{case.record.pk}/speaker-identification/"
    if entry == "public":
        response = client_for(case.actor).post(
            url,
            {
                "request_key": str(uuid4()),
                "expected_revision": case.record.revision,
                "organization_id": None,
                "user_ids": [str(case.actor.pk)],
            },
            format="json",
        )
        assert response.status_code == 202, response.data
        job = models.SpeakerIdentityJob.objects.get(
            pk=response.data["request"]["jobs"][0]["id"]
        )
    else:
        job = enqueue(case)
    assert (
        service.process_one(
            job.pk,
            media_config=pipeline.kwargs["media_config"],
            storage_config=private_s3.config,
            encoder_config=actual_encoder,
            quality_config=short_asr.config,
        )
        == "succeeded"
    )
    assert len(encoded) == 3 and short_asr.requests == 3
    suggestion = models.SpeakerIdentitySuggestion.objects.get(job=job)
    assert suggestion.result in {"suggested", "unknown", "mixed_speaker", "ambiguous"}
    if entry == "public":
        response = client_for(case.actor).get(url)
        assert response.status_code == 200
        assert response.data["request"]["jobs"][0]["suggestion"]["id"] == str(
            suggestion.pk
        )
        assert not response.data["request"]["processing"]
    case.speaker.refresh_from_db()
    assert case.speaker.user_id is None and case.record.identity_decisions.count() == 0
    assert case.profile.samples.count() == 3
    assert all(
        not path.exists() and not path.parent.exists() for path in pipeline.decoded
    )
