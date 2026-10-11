"""Validate private files offline without blocking erasure or disabled stages."""

import base64
import io
import json
import sys
from unittest.mock import Mock

from django.core.management import call_command
from django.core.management.base import CommandError

import pytest

from core.management.commands import run_voiceprint_worker as command
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_encoder import FEATURE_SPACE
from core.services.voiceprint_matching import SCORE_POLICY
from core.services.voiceprint_quality import API_PATH


@pytest.fixture
def configuration(settings, tmp_path):
    settings.CELERY_ENABLED = True
    settings.CELERY_TASK_ALWAYS_EAGER = False
    settings.MEETING_VOICEPRINT_ENABLED = True
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = True
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = True
    files = {
        "KEYRING": {
            "active": "fixture",
            "keys": {"fixture": base64.b64encode(b"k" * 32).decode()},
        },
        "ENCODER_CONFIG": {
            "url": "http://127.0.0.1:12345",
            "api_token": "a" * 32,
            "permit_key": base64.b64encode(b"p" * 32).decode(),
            "ca_bundle": True,
        },
        "QUALITY_CONFIG": {
            "url": "http://127.0.0.1:12346" + API_PATH,
            "api_key": "q" * 32,
            "ca_bundle": True,
        },
        "MEDIA_CONFIG": {"ffmpeg": sys.executable, "ffprobe": sys.executable},
        "THRESHOLD_CONFIG": {
            "threshold_version": "synthetic-fixture",
            "feature_space": FEATURE_SPACE,
            "score_policy": SCORE_POLICY,
            "accept": 0.9,
            "margin": 0.1,
            "min_pair_cosine": 0.8,
            "min_query_clips": 3,
            "min_query_speech_ms": 9000,
            "max_candidates": 50,
            "max_device_groups": 5,
            "calibration_sha256": "f" * 64,
            "calibrated": True,
        },
    }
    paths = {}
    for name, content in files.items():
        path = tmp_path / (name.lower() + ".json")
        path.write_text(json.dumps(content), encoding="utf-8")
        setattr(settings, "MEETING_VOICEPRINT_" + name + "_FILE", str(path))
        paths[name] = path
    return paths


@pytest.mark.parametrize("role", ["api", "control", "processing", "identity"])
def test_valid_private_files_are_checked_without_network_or_database(
    configuration, role, monkeypatch
):
    def network_forbidden(*_args, **_kwargs):
        pytest.fail("Startup validation must not make a provider request")

    monkeypatch.setattr("requests.sessions.Session.request", network_forbidden)
    output = io.StringIO()
    call_command("run_voiceprint_worker", role=role, check=True, stdout=output)
    assert json.loads(output.getvalue()) == {"role": role, "status": "ready"}


@pytest.mark.parametrize("role", ["api", "processing", "identity"])
def test_disabled_master_does_not_require_private_files(settings, role, monkeypatch):
    settings.CELERY_ENABLED = True
    settings.CELERY_TASK_ALWAYS_EAGER = False
    settings.MEETING_VOICEPRINT_ENABLED = False
    monkeypatch.setattr(
        command, "load_keyring", lambda: pytest.fail("Disabled feature read a keyring")
    )
    command.validate(role)


def test_control_queue_remains_available_with_broken_biometric_configuration(
    configuration,
):
    for path in configuration.values():
        path.unlink()
    command.validate("control")
    with pytest.raises(CommandError, match="private_configuration_invalid"):
        command.validate("processing")


def test_bad_matching_policy_does_not_disable_processing_or_erasure(configuration):
    configuration["THRESHOLD_CONFIG"].write_text("not a policy; private diagnostic")
    command.validate("processing")
    command.validate("control")
    for role in ("api", "identity"):
        with pytest.raises(CommandError, match="private_configuration_invalid"):
            command.validate(role)


def test_unneeded_matching_or_quality_files_are_not_read(configuration, settings):
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = False
    for name in ("THRESHOLD_CONFIG", "MEDIA_CONFIG", "QUALITY_CONFIG"):
        configuration[name].unlink()
    for role in ("api", "identity", "processing"):
        command.validate(role)


def test_capture_diarization_queue_does_not_depend_on_disabled_matching_files(
    configuration, settings
):
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    for path in configuration.values():
        path.unlink()
    command.validate("identity")
    with pytest.raises(CommandError, match="private_configuration_invalid"):
        command.validate("api")


@pytest.mark.parametrize("role", ["control", "processing", "identity"])
@pytest.mark.parametrize("eager", [False, True])
def test_consumers_require_real_async_celery(configuration, settings, role, eager):
    settings.CELERY_ENABLED = eager
    settings.CELERY_TASK_ALWAYS_EAGER = eager
    with pytest.raises(CommandError, match="async_configuration_required"):
        command.validate(role)


@pytest.mark.parametrize("role,queue", list(command.QUEUES.items()))
def test_fixed_prefork_entrypoint_is_bound_to_only_its_role(
    configuration, role, queue, monkeypatch
):
    executable = "/fixture/image/bin/celery"
    execv = Mock()
    monkeypatch.setattr(
        command.shutil, "which", lambda name: executable if name == "celery" else None
    )
    monkeypatch.setattr(command.os, "execv", execv)
    call_command("run_voiceprint_worker", role=role)
    path, argv = execv.call_args.args
    assert path == executable and argv[argv.index("-Q") + 1] == queue
    assert "--pool=prefork" in argv and "--concurrency=1" in argv
    assert "--prefetch-multiplier=1" in argv
    assert "--max-tasks-per-child=100" in argv
    assert not any(str(path) in json.dumps(argv) for path in configuration.values())


def test_private_errors_do_not_disclose_exception_or_paths(configuration, monkeypatch):
    def private_failure():
        raise VoiceprintError("sensitive-key-contents-and-path")

    monkeypatch.setattr(command, "load_keyring", private_failure)
    with pytest.raises(CommandError) as error:
        command.validate("processing")
    assert str(error.value) == "voiceprint_worker_private_configuration_invalid"


def test_invalid_role_or_missing_executable_cannot_start_consumer(
    configuration, monkeypatch
):
    with pytest.raises(CommandError, match="role_invalid"):
        command.validate("arbitrary-queue")
    with pytest.raises(CommandError, match="role_invalid"):
        call_command("run_voiceprint_worker", role="api")
    monkeypatch.setattr(command.shutil, "which", lambda _name: None)
    with pytest.raises(CommandError, match="executable_unavailable"):
        call_command("run_voiceprint_worker", role="control")
