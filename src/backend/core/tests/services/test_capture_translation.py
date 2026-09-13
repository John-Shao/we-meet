"""Standalone translation exact-source controls and durable, non-billable receipts."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

from django.core.exceptions import ValidationError
from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import capture_translation as service
from core.tests.services.test_capture_audio import recording
from core.tests.services.test_meeting_captures import ROOT, command
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_AUDIO_ENABLED = True
    settings.MEETING_CAPTURE_TRANSLATION_ENABLED = True
    settings.MEETING_CAPTURE_TRANSLATION_URL = "wss://translation.invalid/capture"
    settings.MEETING_CAPTURE_TRANSLATION_REGION = "cn-beijing"
    settings.AGENT_INTERNAL_API_TOKEN = "isolated-agent"


def payload(capture, **overrides):
    capture.refresh_from_db()
    return {
        "key": str(uuid.uuid4()),
        "device_id": capture.device_id,
        "operation": "start",
        "expected_revision": capture.revision,
        "expected_run_id": None,
        "configuration": {
            "source_language": "zh",
            "target_language": "en",
            "mode": "simultaneous",
            "audio": False,
            "save_translations": False,
        },
        **overrides,
    }


def send(user, body, capture, data):
    return client_for(user).post(
        f"{ROOT}{capture.pk}/translation/",
        data,
        format="json",
        HTTP_X_CAPTURE_LEASE=body["lease_key"],
    )


def read(user, capture):
    return client_for(user).get(f"{ROOT}{capture.pk}/translation/")


def test_reservation_replay_keeps_original_result_and_never_creates_original_text(
    settings,
):
    user, body, capture = recording()
    data = payload(capture)
    first = send(user, body, capture, data)
    assert first.status_code == 202, first.data
    assert first.data["command"]["result"]["status"] == "starting"
    assert first.data["current"]["source"]["capture_id"] == str(capture.pk)
    run = models.CaptureTranslationRun.objects.get()
    assert run.worker_id is None and run.begun_at is None
    run.status, run.ended_at = "incomplete", timezone.now()
    run.save()
    settings.MEETING_CAPTURE_TRANSLATION_ENABLED = False
    replay = send(user, body, capture, data)
    assert replay.status_code == 200
    assert replay.data["command"] == first.data["command"]
    assert replay.data["current"]["current"]["status"] == "incomplete"
    assert not models.MeetingOriginalSegment.objects.exists()
    assert "no-store" in replay["Cache-Control"]
    assert body["lease_key"] not in str(first.data)
    assert run.source_lease_hash not in str(first.data)


@pytest.mark.parametrize("change", ["device", "lease", "owner", "inactive", "foreign"])
def test_source_authority_required_even_for_replay(change):
    user, body, capture = recording()
    data = payload(capture)
    assert send(user, body, capture, data).status_code == 202
    if change == "device":
        data["device_id"] = "other"
    elif change == "lease":
        body["lease_key"] = str(uuid.uuid4())
    elif change == "owner":
        models.MeetingRecord.objects.filter(pk=capture.record_id).update(
            owner=UserFactory()
        )
    elif change == "inactive":
        models.User.objects.filter(pk=user.pk).update(is_active=False)
    else:
        user = UserFactory()
    assert send(user, body, capture, data).status_code in (401, 403, 404)
    assert models.CaptureTranslationRun.objects.count() == 1


@pytest.mark.parametrize(
    "url",
    [
        "",
        "ws://local/capture",
        "https://translation.invalid",
        "wss://u:p@translation.invalid",
        "wss://translation.invalid?token=x",
        "wss://translation.invalid#x",
        "wss://translation.invalid:bad",
    ],
)
def test_invalid_gateway_prevents_new_reservations(settings, url):
    user, body, capture = recording()
    settings.MEETING_CAPTURE_TRANSLATION_URL = url
    state = read(user, capture)
    assert state.status_code == 200 and not state.data["available"]
    assert send(user, body, capture, payload(capture)).status_code == 409
    assert not models.CaptureTranslationRun.objects.exists()


def test_stop_unclaimed_is_terminal_and_available_during_roll_back(settings):
    user, body, capture = recording()
    first = send(user, body, capture, payload(capture))
    run_id = first.data["command"]["result"]["id"]
    settings.MEETING_CAPTURE_TRANSLATION_ENABLED = False
    stop = payload(
        capture, operation="stop", expected_run_id=run_id, configuration=None
    )
    stopped = send(user, body, capture, stop)
    assert stopped.status_code == 202, stopped.data
    assert stopped.data["command"]["result"]["status"] == "stopped"
    assert send(user, body, capture, stop).data["command"] == stopped.data["command"]
    capture.refresh_from_db()
    assert capture.status == "recording"


def test_expired_run_reconciles_and_old_stop_cannot_stop_replacement():
    user, body, capture = recording()
    send(user, body, capture, payload(capture))
    old = models.CaptureTranslationRun.objects.get()
    old.deadline = timezone.now() - timedelta(seconds=1)
    old.save()
    expired = read(user, capture).data
    assert expired["current"]["status"] == "incomplete"
    assert expired["can_start"]
    next_result = send(
        user, body, capture, payload(capture, expected_run_id=str(old.pk))
    )
    assert next_result.status_code == 202, next_result.data
    assert next_result.data["command"]["result"]["generation"] == 2
    stale = send(
        user,
        body,
        capture,
        payload(
            capture, operation="stop", expected_run_id=str(old.pk), configuration=None
        ),
    )
    assert stale.status_code == 409


def test_pause_resume_invalidates_source_revision_even_when_recording_again():
    user, body, capture = recording()
    send(user, body, capture, payload(capture))
    assert command(user, body, capture, "pause").status_code == 200
    assert command(user, body, capture, "resume").status_code == 200
    state = read(user, capture).data
    assert state["current"]["status"] == "incomplete"
    assert state["current"]["error_code"] == "source_changed"
    assert state["can_start"]


@pytest.mark.parametrize(
    "case",
    [
        "same_language",
        "model",
        "missing_audio",
        "missing_save",
        "bad_mode",
        "missing_cas",
        "extra",
    ],
)
def test_configuration_and_explicit_consents_are_strict(case):
    user, body, capture = recording()
    data = payload(capture)
    config = data["configuration"]
    if case == "same_language":
        config["target_language"] = "zh"
    elif case == "model":
        config["model"] = "other"
    elif case == "missing_audio":
        del config["audio"]
    elif case == "missing_save":
        del config["save_translations"]
    elif case == "bad_mode":
        config["mode"] = "continuous_other"
    elif case == "missing_cas":
        del data["expected_run_id"]
    else:
        data["record_id"] = str(capture.record_id)
    assert send(user, body, capture, data).status_code == 400
    assert not models.CaptureTranslationRun.objects.exists()


def test_configuration_and_receipts_immutable():
    user, body, capture = recording()
    send(user, body, capture, payload(capture))
    run = models.CaptureTranslationRun.objects.get()
    run.configuration["audio"] = True
    with pytest.raises(ValidationError):
        run.save()
    receipt = models.CaptureTranslationCommand.objects.get()
    receipt.result["status"] = "translating"
    with pytest.raises(ValidationError):
        receipt.save()


@pytest.mark.django_db(transaction=True)
def test_concurrent_distinct_starts_only_reserve_one_attempt():
    user, body, capture = recording()
    barrier = Barrier(2)
    data = [payload(capture), payload(capture)]

    def start(item):
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            return send(user, body, capture, item).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(start, data))
    assert sorted(results) == [202, 409]
    assert models.CaptureTranslationRun.objects.count() == 1
