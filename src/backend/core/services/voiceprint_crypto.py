"""AES-GCM envelopes with scope/object binding and a separately mounted keyring.

Only ciphertext is persisted. The keyring is an operator-managed reference
backend, not a claim of deployed KMS or backup cryptographic erasure.
"""

import base64
import binascii
import json
import os
import re
from pathlib import Path

from django.conf import settings

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAX_CLEAR_BYTES = 484096
KEY_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


class VoiceprintCryptoError(ValueError):
    pass


def scope_aad(profile, *, kind, object_id=None):
    """Changing owner, scope, generation, model or purpose invalidates ciphertext."""
    if kind not in {
        "key",
        "audio",
        "embedding",
        "template",
        "enrollment",
        "call-permit",
    }:
        raise VoiceprintCryptoError("voiceprint_context_invalid")
    return json.dumps(
        {
            "v": 1,
            "profile": str(profile.pk),
            "owner": str(profile.consent.user_id),
            "organization": str(profile.consent.organization_id or "personal"),
            "generation": profile.generation,
            "space": profile.feature_space,
            "kind": kind,
            "object": str(object_id or profile.pk),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


def seal(key, plaintext, aad):
    if not isinstance(plaintext, bytes) or not 1 <= len(plaintext) <= MAX_CLEAR_BYTES:
        raise VoiceprintCryptoError("voiceprint_plaintext_invalid")
    nonce = os.urandom(12)
    return b"VP1" + nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def unseal(key, ciphertext, aad):
    if (
        not isinstance(ciphertext, (bytes, bytearray, memoryview))
        or not 31 < len(ciphertext) <= MAX_CLEAR_BYTES + 31
    ):
        raise VoiceprintCryptoError("voiceprint_ciphertext_invalid")
    value = bytes(ciphertext)
    if not 31 < len(value) <= MAX_CLEAR_BYTES + 31 or value[:3] != b"VP1":
        raise VoiceprintCryptoError("voiceprint_ciphertext_invalid")
    try:
        return AESGCM(key).decrypt(value[3:15], value[15:], aad)
    except (InvalidTag, ValueError):
        raise VoiceprintCryptoError("voiceprint_ciphertext_invalid") from None


class Keyring:
    def __init__(self, value):
        if (
            not isinstance(value, dict)
            or set(value) != {"active", "keys"}
            or not isinstance(value["keys"], dict)
            or not 1 <= len(value["keys"]) <= 8
            or not isinstance(value["active"], str)
            or value["active"] not in value["keys"]
        ):
            raise VoiceprintCryptoError("voiceprint_keyring_invalid")
        self._keys = {}
        for identifier, encoded in value["keys"].items():
            try:
                if not isinstance(identifier, str) or not KEY_ID.fullmatch(identifier):
                    raise ValueError
                if not isinstance(encoded, str) or len(encoded) != 44:
                    raise ValueError
                key = base64.b64decode(encoded, validate=True)
                if len(key) != 32:
                    raise ValueError
            except (ValueError, binascii.Error):
                raise VoiceprintCryptoError("voiceprint_keyring_invalid") from None
            self._keys[identifier] = key
        self._active = value["active"]

    def create_profile_key(self, profile):
        key = os.urandom(32)
        identifier = self._active.encode()
        envelope = seal(self._keys[self._active], key, scope_aad(profile, kind="key"))
        return bytes([len(identifier)]) + identifier + envelope

    def profile_key(self, profile):
        if (
            not isinstance(profile.encrypted_key, (bytes, bytearray, memoryview))
            or not 32 <= len(profile.encrypted_key) <= 256
        ):
            raise VoiceprintCryptoError("voiceprint_key_unavailable")
        value = bytes(profile.encrypted_key)
        try:
            length = value[0]
            if not 1 <= length <= 32:
                raise ValueError
            identifier = value[1 : 1 + length].decode("ascii")
            key = self._keys[identifier]
            data_key = unseal(key, value[1 + length :], scope_aad(profile, kind="key"))
            if len(data_key) != 32:
                raise ValueError
            return data_key
        except (IndexError, KeyError, UnicodeError, ValueError):
            raise VoiceprintCryptoError("voiceprint_key_unavailable") from None

    def encrypt(self, profile, plaintext, *, kind, object_id):
        return seal(
            self.profile_key(profile),
            plaintext,
            scope_aad(profile, kind=kind, object_id=object_id),
        )

    def decrypt(self, profile, ciphertext, *, kind, object_id):
        return unseal(
            self.profile_key(profile),
            ciphertext,
            scope_aad(profile, kind=kind, object_id=object_id),
        )


def load_keyring():
    try:
        path = Path(settings.MEETING_VOICEPRINT_KEYRING_FILE)
        if not path.is_file() or path.stat().st_size > 8192:
            raise ValueError
        with path.open("rb") as stream:
            encoded = stream.read(8193)
        if len(encoded) > 8192:
            raise ValueError
        value = json.loads(encoded)
        return Keyring(value)
    except (OSError, ValueError, RecursionError):
        raise VoiceprintCryptoError("voiceprint_key_unavailable") from None
