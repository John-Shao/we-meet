"""Owner APIs exercise the real admission service and private audio response."""

from uuid import uuid4

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import UserFactory
from core.services import voiceprint_consent as consent
from core.services.voiceprint_crypto import load_keyring
from core.services.voiceprint_enrollment import enrollment_snapshot
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_voiceprint_enrollment import (
    actor,
    begin,
    enabled,
    ready,
    upload,
    wav,
)

pytestmark = pytest.mark.django_db
BASE = "/api/v1.0/voiceprint/"


def start(actor, **changes):
    return client_for(actor).post(
        BASE + "enrollments/",
        {
            "organization_id": None,
            "expected_version": 1,
            "request_key": str(uuid4()),
            "locale": "en",
            **changes,
        },
        format="json",
    )


def put(actor, enrollment, *, slot=0, body=None, **headers):
    token = enrollment_snapshot(enrollment)["upload_token"]
    return client_for(actor).put(
        BASE + f"enrollments/{enrollment.pk}/clips/{slot}/",
        body if body is not None else wav(),
        content_type="audio/wav",
        **{"HTTP_X_VOICEPRINT_UPLOAD_TOKEN": token, **headers},
    )


def test_start_upload_poll_list_listen_reject_real_api(actor):
    response = start(actor, locale="zh-CN")
    assert response.status_code == 201
    assert response["Cache-Control"] == "private, no-store"
    assert len(response.data["upload_token"]) == 43
    enrollment = models.VoiceprintEnrollment.objects.get(pk=response.data["id"])
    response = put(actor, enrollment)
    assert response.status_code == 202
    assert (
        response.data["status"] == "pending" and response.data["confirmable"] is False
    )
    sample = models.VoiceprintSample.objects.get(pk=response.data["id"])
    assert sample.encoding_job.status == "queued"
    assert (
        client_for(actor).get(BASE + f"enrollments/{enrollment.pk}/").status_code == 200
    )
    page = client_for(actor).get(BASE + "samples/")
    assert page.data["results"] == [response.data]
    assert page.data["next_offset"] is None
    audio = client_for(actor).get(BASE + f"samples/{sample.pk}/audio/")
    assert audio.status_code == 200 and audio.content == wav()
    assert audio["Content-Type"] == "audio/wav"
    assert audio["Cache-Control"] == "private, no-store"
    assert audio["X-Content-Type-Options"] == "nosniff"
    result = client_for(actor).post(
        BASE + f"samples/{sample.pk}/decision/",
        {"expected_version": 1, "accepted": False},
        format="json",
    )
    assert result.status_code == 200 and result.data["status"] == "rejected"
    assert result.data["audio_available"] is False
    assert (
        client_for(actor).get(BASE + f"samples/{sample.pk}/audio/").status_code == 410
    )


@pytest.mark.parametrize(
    "fields",
    [
        {"expected_version": True},
        {"expected_version": "1"},
        {"locale": "bad"},
        {"owner_id": str(uuid4())},
        {"profile_id": str(uuid4())},
        {"quality": {"speech_checked": True}},
    ],
)
def test_client_cannot_coerce_grants_or_submit_another_identity(actor, fields):
    assert start(actor, **fields).status_code == 400
    assert not models.VoiceprintEnrollment.objects.exists()


def test_start_is_default_off_and_missing_key_is_sanitized(actor, settings):
    settings.MEETING_VOICEPRINT_ENABLED = False
    assert start(actor).status_code == 403
    settings.MEETING_VOICEPRINT_ENABLED = True
    settings.MEETING_VOICEPRINT_KEYRING_FILE = "missing-private-keyring"
    response = start(actor)
    assert response.status_code == 503 and response.data == {
        "code": "voiceprint_key_unavailable"
    }
    assert not models.VoiceprintEnrollment.objects.exists()


def test_primary_authentication_and_owner_are_required(actor):
    enrollment = begin(actor)
    sample = upload(actor, enrollment)
    other = UserFactory()
    for suffix in [f"enrollments/{enrollment.pk}/", f"samples/{sample.pk}/audio/"]:
        assert APIClient().get(BASE + suffix).status_code in (401, 403)
        assert client_for(other).get(BASE + suffix).status_code == 404
    assert client_for(other).get(BASE + "samples/").data["results"] == []
    assert put(other, enrollment).status_code == 404


@pytest.mark.parametrize(
    "headers",
    [
        {"HTTP_X_VOICEPRINT_UPLOAD_TOKEN": ""},
        {"HTTP_X_VOICEPRINT_UPLOAD_TOKEN": "x" * 43},
        {"CONTENT_LENGTH": "999999"},
        {"CONTENT_LENGTH": "-1"},
        {"CONTENT_LENGTH": "bad"},
    ],
)
def test_invalid_upload_headers_cannot_admit_audio(actor, headers):
    response = put(actor, begin(actor), **headers)
    assert response.status_code in (403, 413)
    assert response["Cache-Control"] == "private, no-store"
    assert not models.VoiceprintSample.objects.exists()


def test_upload_rejects_urls_multipart_and_malformed_media(actor):
    enrollment = begin(actor)
    response = client_for(actor).put(
        BASE + f"enrollments/{enrollment.pk}/clips/0/",
        {"url": "https://example.invalid/audio"},
        format="json",
    )
    assert response.status_code == 415
    assert put(actor, enrollment, body=b"bad WAV").status_code == 422
    assert put(actor, enrollment, slot=6).status_code == 400
    assert not models.VoiceprintEncodingJob.objects.exists()


def test_permission_revocation_invalidates_poll_upload_and_listen(actor):
    enrollment = begin(actor)
    sample = upload(actor, enrollment)
    consent.update_settings(
        actor,
        organization_id=None,
        expected_version=1,
        changes={"allow_enrollment": False},
    )
    poll = client_for(actor).get(BASE + f"enrollments/{enrollment.pk}/")
    assert poll.data["status"] == "canceled" and poll.data["upload_token"] is None
    assert put(actor, enrollment, slot=1, body=wav(121)).status_code == 403
    assert (
        client_for(actor).get(BASE + f"samples/{sample.pk}/audio/").status_code == 403
    )
    assert (
        client_for(actor).get(BASE + "samples/").data["results"][0]["audio_available"]
        is False
    )


def test_confirmation_checks_quality_and_strict_payload(actor):
    sample = upload(actor, begin(actor))
    url = BASE + f"samples/{sample.pk}/decision/"
    assert (
        client_for(actor)
        .post(url, {"expected_version": 1, "accepted": True}, format="json")
        .status_code
        == 409
    )
    assert (
        client_for(actor)
        .post(url, {"expected_version": 1, "accepted": "true"}, format="json")
        .status_code
        == 400
    )
    ready(sample)
    assert (
        client_for(actor)
        .post(url, {"expected_version": 1, "accepted": True}, format="json")
        .status_code
        == 200
    )
    assert sample.profile.templates.count() == 0


def test_metadata_list_never_loads_private_payloads(actor, monkeypatch):
    sample = ready(upload(actor, begin(actor)))

    def forbidden(_sample):
        raise AssertionError("Metadata must not load a biometric blob")

    monkeypatch.setattr(models.VoiceprintSample, "encrypted_audio", property(forbidden))
    monkeypatch.setattr(
        models.VoiceprintSample, "encrypted_embedding", property(forbidden)
    )
    response = client_for(actor).get(BASE + "samples/")
    assert response.status_code == 200 and response.data["results"][0]["id"] == str(
        sample.pk
    )
    assert response.data["results"][0]["confirmable"] is True
    assert "quality" not in response.data["results"][0]


def test_expired_and_tampered_audio_stay_private(actor):
    sample = upload(actor, begin(actor))
    url = BASE + f"samples/{sample.pk}/audio/"
    models.VoiceprintSample.objects.filter(pk=sample.pk).update(
        encrypted_audio=b"invalid ciphertext"
    )
    response = client_for(actor).get(url)
    assert response.status_code == 503 and response.data == {
        "code": "voiceprint_key_unavailable"
    }
    sample.encrypted_audio = load_keyring().encrypt(
        sample.profile, wav(), kind="audio", object_id=sample.pk
    )
    sample.expires_at = timezone.now()
    sample.save()
    assert client_for(actor).get(url).status_code == 410


@pytest.mark.parametrize("allow_enrollment", [True, False])
def test_accumulation_alone_cannot_confirm_call_candidate(actor, allow_enrollment):
    sample = ready(upload(actor, begin(actor)))
    consent.update_settings(
        actor,
        organization_id=None,
        expected_version=1,
        changes={"allow_accumulation": True, "allow_enrollment": allow_enrollment},
    )
    # Technical fixture for the upcoming trusted call producer; clients cannot
    # create call samples or claim quality through the registration endpoint.
    models.VoiceprintSample.objects.filter(pk=sample.pk).update(
        source_type="call", enrollment=None, consent_version=2, status="ready"
    )
    page = client_for(actor).get(BASE + "samples/").data
    assert page["results"][0]["confirmable"] is allow_enrollment
    response = client_for(actor).post(
        BASE + f"samples/{sample.pk}/decision/",
        {"expected_version": 2, "accepted": True},
        format="json",
    )
    assert response.status_code == (200 if allow_enrollment else 403)
