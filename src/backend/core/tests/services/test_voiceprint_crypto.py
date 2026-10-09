"""Ciphertext integrity, namespace binding and explicit operator key rotation."""

import base64
import copy
import json
import os
from types import SimpleNamespace
from uuid import uuid4

import pytest

from core.services.voiceprint_crypto import Keyring, VoiceprintCryptoError, load_keyring


def config(**extra):
    return {
        "active": "current",
        "keys": {"current": base64.b64encode(os.urandom(32)).decode()},
        **extra,
    }


def profile(ring):
    row = SimpleNamespace(
        pk=uuid4(),
        generation=1,
        feature_space="fixed-qwen-space",
        consent=SimpleNamespace(user_id=uuid4(), organization_id=uuid4()),
    )
    row.encrypted_key = ring.create_profile_key(row)
    return row


def test_envelopes_hide_plaintext_randomize_nonce_and_round_trip():
    ring = Keyring(config())
    row = profile(ring)
    identifier = uuid4()
    clear = b"synthetic private fixture, not a human voiceprint"
    first = ring.encrypt(row, clear, kind="audio", object_id=identifier)
    second = ring.encrypt(row, clear, kind="audio", object_id=identifier)
    assert first != second and clear not in first and clear not in second
    assert ring.decrypt(row, first, kind="audio", object_id=identifier) == clear
    assert (
        ring.decrypt(row, memoryview(first), kind="audio", object_id=identifier)
        == clear
    )
    assert clear.decode() not in repr(ring)


@pytest.mark.parametrize(
    "change",
    ["profile", "owner", "organization", "generation", "space", "kind", "object"],
)
def test_ciphertexts_are_bound_to_scope_generation_model_purpose_and_object(change):
    ring = Keyring(config())
    row = profile(ring)
    identifier = uuid4()
    encrypted = ring.encrypt(
        row, b"synthetic payload", kind="embedding", object_id=identifier
    )
    altered = copy.deepcopy(row)
    kind = "embedding"
    target = identifier
    if change == "profile":
        altered.pk = uuid4()
    elif change == "owner":
        altered.consent.user_id = uuid4()
    elif change == "organization":
        altered.consent.organization_id = None
    elif change == "generation":
        altered.generation += 1
    elif change == "space":
        altered.feature_space = "other-model"
    elif change == "kind":
        kind = "template"
    else:
        target = uuid4()
    with pytest.raises(VoiceprintCryptoError):
        ring.decrypt(altered, encrypted, kind=kind, object_id=target)


def test_tampered_truncated_oversized_or_untyped_ciphertext_fails_closed():
    ring = Keyring(config())
    row = profile(ring)
    identifier = uuid4()
    encrypted = ring.encrypt(row, b"fixture", kind="audio", object_id=identifier)
    for value in [
        encrypted[:-1],
        encrypted[:-1] + bytes([encrypted[-1] ^ 1]),
        b"",
        b"x" * 484128,
        100,
    ]:
        with pytest.raises(
            VoiceprintCryptoError, match="voiceprint_ciphertext_invalid"
        ):
            ring.decrypt(row, value, kind="audio", object_id=identifier)
    row.encrypted_key = b""
    with pytest.raises(VoiceprintCryptoError, match="voiceprint_key_unavailable"):
        ring.profile_key(row)


def test_rotation_reads_old_key_ids_and_new_profiles_use_active_key():
    first = config()
    before = Keyring(first)
    old = profile(before)
    previous = before.profile_key(old)
    second = {
        "active": "next",
        "keys": {**first["keys"], "next": base64.b64encode(os.urandom(32)).decode()},
    }
    after = Keyring(second)
    assert after.profile_key(old) == previous
    new = profile(after)
    assert new.encrypted_key[1:5] == b"next"
    removed = Keyring({"active": "next", "keys": {"next": second["keys"]["next"]}})
    with pytest.raises(VoiceprintCryptoError, match="voiceprint_key_unavailable"):
        removed.profile_key(old)


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        {"active": "missing", "keys": {}},
        {"active": "bad", "keys": {"bad": "not-base64"}},
        {"active": "short", "keys": {"short": base64.b64encode(b"x" * 16).decode()}},
        {"active": "bad id", "keys": {"bad id": base64.b64encode(b"x" * 32).decode()}},
    ],
)
def test_invalid_operator_keyring_is_rejected_without_echoing_contents(value):
    with pytest.raises(VoiceprintCryptoError, match="voiceprint_keyring_invalid"):
        Keyring(value)


def test_keyring_file_is_required_bounded_and_does_not_use_django_secret(
    settings, tmp_path
):
    settings.MEETING_VOICEPRINT_KEYRING_FILE = ""
    settings.SECRET_KEY = "fixture-django-secret-must-never-wrap-biometric-data"
    with pytest.raises(VoiceprintCryptoError, match="voiceprint_key_unavailable"):
        load_keyring()
    path = tmp_path / "keyring.json"
    path.write_text(json.dumps(config()))
    settings.MEETING_VOICEPRINT_KEYRING_FILE = str(path)
    assert isinstance(load_keyring(), Keyring)
    path.write_text("x" * 8193)
    with pytest.raises(VoiceprintCryptoError, match="voiceprint_key_unavailable"):
        load_keyring()
