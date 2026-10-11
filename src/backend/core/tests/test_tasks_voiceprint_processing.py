"""Run real scheduled batches against DB leases and local synthetic quality IO."""

import base64
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone

import pytest
from billiard.exceptions import SoftTimeLimitExceeded

from core import models
from core.factories import UserFactory
from core.management.commands import identify_speakers as identity_command
from core.management.commands import process_voiceprints as encoder_command
from core.services import recording_identity_preflight as preflight
from core.services import voiceprint_consent as consent
from core.services import voiceprint_jobs as jobs
from core.services import voiceprint_rpc_process as rpc
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_encoder import EncoderError, decode_result
from core.tasks import voiceprint_processing as tasks
from core.tests.services.test_voiceprint_consent import profile_for
from core.tests.services.test_voiceprint_enrollment import (
    actor,
    begin,
    enabled,
    upload,
    wav,
)
from core.tests.services.test_voiceprint_quality_jobs import candidate
from core.tests.services.test_voiceprint_templates import contributions
from core.tests.test_services_voiceprint_encoder import output
from core.tests.test_services_voiceprint_quality_process import short_asr

from meet.settings import Base

pytestmark = pytest.mark.django_db


@pytest.fixture
def encoder_config(settings, tmp_path):
    path = tmp_path / "encoder.json"
    path.write_text(
        json.dumps(
            {
                "url": "http://127.0.0.1:12345",
                "api_token": "a" * 32,
                "permit_key": base64.b64encode(b"b" * 32).decode(),
                "ca_bundle": True,
            }
        )
    )
    settings.MEETING_VOICEPRINT_ENCODER_CONFIG_FILE = str(path)


def accept(body, *, authorized, **_context):
    assert authorized()
    digest = hashlib.sha256(body).hexdigest()
    return decode_result({**output(), "input_sha256": digest}, digest)


@pytest.mark.parametrize(
    "work",
    [
        tasks.encode_voiceprints,
        tasks.check_voiceprint_quality,
        tasks.build_voiceprint_templates,
        tasks.identify_speakers,
    ],
)
def test_disabled_scheduled_work_does_not_read_configs_or_query_private_data(
    work, settings, django_assert_num_queries
):
    settings.MEETING_VOICEPRINT_ENABLED = False
    with django_assert_num_queries(0):
        assert work()["enabled"] is False


@pytest.mark.parametrize(
    ("work", "flag"),
    [
        (tasks.check_voiceprint_quality, "MEETING_VOICEPRINT_QUALITY_ENABLED"),
        (tasks.build_voiceprint_templates, "MEETING_VOICEPRINT_TEMPLATES_ENABLED"),
        (tasks.identify_speakers, "MEETING_VOICEPRINT_MATCHING_ENABLED"),
    ],
)
def test_stage_switches_remain_independent(
    work, flag, settings, django_assert_num_queries
):
    setattr(settings, flag, False)
    with django_assert_num_queries(0):
        assert work()["enabled"] is False


def test_each_encode_tick_selects_one_current_job_and_never_returns_identifiers(
    actor, encoder_config, monkeypatch
):
    registration = begin(actor)
    samples = [
        upload(actor, registration, slot=slot, audio=wav(120 + slot)) for slot in (0, 1)
    ]
    monkeypatch.setattr(rpc, "extract", accept)
    first = tasks.encode_voiceprints()
    assert first["succeeded"] == 1
    assert models.VoiceprintEncodingJob.objects.filter(status="queued").count() == 1
    assert tasks.encode_voiceprints()["succeeded"] == 1
    assert models.VoiceprintEncodingJob.objects.filter(status="succeeded").count() == 2
    assert all(str(sample.pk) not in json.dumps(first) for sample in samples)
    assert str(actor.pk) not in json.dumps(first)
    assert tasks.encode_voiceprints()["succeeded"] == 0


def test_fresh_tick_recovers_expired_lease_and_rejects_its_previous_owner(
    actor, encoder_config, monkeypatch
):
    sample = upload(actor, begin(actor))
    old = jobs.claim(sample.encoding_job.pk)
    models.VoiceprintEncodingJob.objects.filter(pk=old.job_id).update(
        lease_until=timezone.now()
    )
    monkeypatch.setattr(rpc, "extract", accept)
    assert tasks.encode_voiceprints()["succeeded"] == 1
    sample.encoding_job.refresh_from_db()
    assert sample.encoding_job.attempts == 2 and not jobs.authorized(old)
    assert not jobs.finish(old, result=accept(old.wav, authorized=lambda: True))


def test_live_lease_is_not_replayed_by_a_periodic_tick(
    actor, encoder_config, monkeypatch
):
    sample = upload(actor, begin(actor))
    old = jobs.claim(sample.encoding_job.pk)
    monkeypatch.setattr(
        rpc, "extract", lambda *_a, **_k: pytest.fail("live lease replayed")
    )
    assert tasks.encode_voiceprints()["succeeded"] == 0
    sample.encoding_job.refresh_from_db()
    assert sample.encoding_job.attempts == 1 and jobs.authorized(old)


def test_revoke_during_tick_cannot_publish_an_embedding(
    actor, encoder_config, monkeypatch
):
    sample = upload(actor, begin(actor))

    def revoke(body, **context):
        result = accept(body, **context)
        consent.update_settings(
            actor,
            organization_id=None,
            expected_version=1,
            changes={"allow_enrollment": False},
        )
        return result

    monkeypatch.setattr(rpc, "extract", revoke)
    tasks.encode_voiceprints()
    sample.refresh_from_db()
    assert not sample.encrypted_embedding
    assert sample.encoding_job.status == "canceled"


def test_quality_tick_backfills_one_job_and_uses_local_http_without_owner_confirmation(
    actor, short_asr, settings, tmp_path
):
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = True
    settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED = True
    sample = candidate(actor)
    second = candidate(actor, sample.enrollment, slot=1)
    sample.quality_job.delete()
    short_asr.prompt = sample.enrollment.challenges[0]
    path = tmp_path / "quality.json"
    path.write_text(json.dumps(short_asr.config.payload()))
    settings.MEETING_VOICEPRINT_QUALITY_CONFIG_FILE = str(path)
    result = tasks.check_voiceprint_quality()
    assert result["admitted"] == 1 and result["succeeded"] == 1
    assert short_asr.requests == 1
    assert models.VoiceprintQualityJob.objects.filter(status="queued").count() == 1
    assert sample.enrollment.profile.templates.count() == 0
    tasks.build_voiceprint_templates()
    assert sample.enrollment.profile.templates.filter(status="active").count() == 0
    assert not models.VoiceprintSampleDecision.objects.filter(
        sample__in=[sample, second]
    ).exists()


def test_template_ticks_build_only_confirmed_contributions_and_rotate_profiles(
    settings,
):
    settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED = True
    profiles = [profile_for(UserFactory(), identify=True) for _ in range(2)]
    for profile in profiles:
        contributions(profile)
    assert tasks.build_voiceprint_templates()["built"] == 1
    assert models.VoiceprintTemplate.objects.filter(status="active").count() == 1
    assert tasks.build_voiceprint_templates()["built"] == 1
    assert all(consent.profile_ready(profile) for profile in profiles)


def test_configuration_and_unexpected_failures_do_not_log_private_details(
    settings, monkeypatch, caplog
):
    def invalid(_path):
        raise EncoderError("private credential and file path")

    monkeypatch.setattr(encoder_command, "load_configuration", invalid)
    assert tasks.encode_voiceprints() == {"status": "configuration_unavailable"}
    assert "private credential" not in caplog.text

    monkeypatch.setattr(encoder_command, "load_configuration", lambda _path: object())

    def database_error(_limit):
        raise RuntimeError("private credential and file path")

    monkeypatch.setattr(encoder_command, "pending_ids", database_error)
    assert tasks.encode_voiceprints() == {"status": "unavailable"}
    assert "private credential" not in caplog.text
    settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED = False
    assert tasks.build_voiceprint_templates()["enabled"] is False


def test_identity_command_uses_private_media_file_without_cli_paths(
    encoder_config, short_asr, settings, tmp_path, monkeypatch
):
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = True
    media_path, quality_path = tmp_path / "media.json", tmp_path / "quality.json"
    media_path.write_text(
        json.dumps({"ffmpeg": sys.executable, "ffprobe": sys.executable})
    )
    quality_path.write_text(json.dumps(short_asr.config.payload()))
    settings.MEETING_VOICEPRINT_MEDIA_CONFIG_FILE = str(media_path)
    settings.MEETING_VOICEPRINT_QUALITY_CONFIG_FILE = str(quality_path)
    identifier, calls = uuid4(), []
    monkeypatch.setattr(identity_command, "pending_ids", lambda _limit: [identifier])
    monkeypatch.setattr(identity_command, "from_storage", lambda _storage: object())

    def process(job_id, **config):
        assert job_id == identifier
        assert config["media_config"].ffmpeg == sys.executable
        calls.append(job_id)
        return "succeeded"

    monkeypatch.setattr(identity_command, "process_one", process)
    assert tasks.identify_speakers()["succeeded"] == 1 and calls == [identifier]
    with pytest.raises(CommandError, match="identity_configuration_invalid"):
        call_command("identify_speakers", ffmpeg=sys.executable)


def test_periodic_jobs_have_fresh_bounded_messages_and_separate_processing_queues(
    settings,
):
    for name in (
        "process-voiceprint-batches",
        "identify-speakers",
    ):
        item = Base.celery_beat_entries[name]
        assert item["schedule"] == 15.0 and item["options"]["expires"] == 30
        assert not item.get("args") and not item.get("kwargs")
        expected = (
            "voiceprint-identity"
            if name == "identify-speakers"
            else "voiceprint-processing"
        )
        assert item["options"]["queue"] == expected
    assert (
        settings.CELERY_BEAT_SCHEDULE["maintain-voiceprints"]["options"]["queue"]
        == "voiceprint"
    )


def test_coordinator_progresses_other_stages_when_encoder_configuration_is_missing(
    actor, short_asr, settings, tmp_path
):
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = True
    settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED = True
    sample = candidate(actor)
    models.VoiceprintProfile.objects.filter(pk=sample.profile_id).update(
        template_checked_at=timezone.now()
    )
    confirmed = profile_for(UserFactory(), identify=True)
    contributions(confirmed)
    short_asr.prompt = sample.enrollment.challenges[0]
    path = tmp_path / "quality.json"
    path.write_text(json.dumps(short_asr.config.payload()))
    settings.MEETING_VOICEPRINT_QUALITY_CONFIG_FILE = str(path)
    result = tasks.process_voiceprint_batches()
    assert result["templates"]["built"] == 1 and consent.profile_ready(confirmed)
    assert result["quality"]["succeeded"] == 1 and short_asr.requests == 1
    assert result["encoding"] == {"status": "configuration_unavailable"}
    sample.refresh_from_db()
    assert sample.quality_job.status == "succeeded" and sample.confirmed_at is None


def test_coordinator_does_not_begin_native_work_after_its_budget_is_consumed(
    actor, short_asr, settings, monkeypatch
):
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = True
    sample = candidate(actor)
    clock = iter((0, 0, 65, 65))
    monkeypatch.setattr(tasks, "monotonic", lambda: next(clock))
    result = tasks.process_voiceprint_batches()
    assert result["quality"] == result["encoding"] == {"status": "budget_exhausted"}
    assert short_asr.requests == 0
    sample.quality_job.refresh_from_db()
    assert sample.quality_job.status == "queued" and sample.quality_job.attempts == 0


def test_soft_deadline_propagates_instead_of_starting_another_stage(monkeypatch):
    def stop(*_args, **_kwargs):
        raise SoftTimeLimitExceeded

    monkeypatch.setattr(tasks, "call_command", stop)
    with pytest.raises(SoftTimeLimitExceeded):
        tasks.process_voiceprint_batches()


def test_rotated_media_configuration_cannot_bypass_the_read_size_limit(
    settings, tmp_path, monkeypatch
):
    path = tmp_path / "media.json"
    path.write_text(
        json.dumps({"ffmpeg": sys.executable, "ffprobe": sys.executable}) + " " * 9000
    )
    settings.MEETING_VOICEPRINT_MEDIA_CONFIG_FILE = str(path)
    original_stat = Path.stat

    def previous_file_size(current, *args, **kwargs):
        # Simulate a rotation between size inspection and opening the newer file.
        if current == path:
            return SimpleNamespace(st_size=100)
        return original_stat(current, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", previous_file_size)
    with pytest.raises(
        VoiceprintError, match="voiceprint_media_configuration_unavailable"
    ):
        preflight.media_config()
