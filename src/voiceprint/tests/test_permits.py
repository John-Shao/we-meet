import hashlib
import hmac
import time
from uuid import uuid4

import jwt
import pytest
from jwt.utils import base64url_encode

from voiceprint.permits import (
    PermitRejected,
    UsedPermits,
    validate_payload,
    validate_permit,
)

KEY = b"test-signing-key-with-at-least-32-bytes"
SPACE = "fixture-qwen-space"


def claims(body=b"pcm", **changes):
    now = int(time.time())
    value = {
        "iss": "we-meet",
        "aud": "voiceprint-encoder",
        "sub": str(uuid4()),
        "jti": str(uuid4()),
        "iat": now,
        "nbf": now,
        "exp": now + 120,
        "scope": "embedding",
        "sha256": hashlib.sha256(body).hexdigest(),
        "bytes": len(body),
        "space": SPACE,
    }
    return {**value, **changes}


def grant(body=b"pcm", **changes):
    return jwt.encode(claims(body, **changes), KEY, algorithm="HS256")


def test_requires_payload_and_model_bound_grants():
    permit = validate_permit(grant(), KEY, SPACE)
    validate_payload(permit, b"pcm")
    with pytest.raises(PermitRejected, match="permit_payload_mismatch"):
        validate_payload(permit, b"xyz")
    with pytest.raises(PermitRejected, match="permit_invalid"):
        validate_permit(grant(), KEY, "different model space")


@pytest.mark.parametrize(
    "changes",
    [
        {"aud": "other"},
        {"aud": ["voiceprint-encoder", "other"]},
        {"iss": "other"},
        {"scope": "download"},
        {"sub": "person-id"},
        {"jti": "not-a-lease"},
        {"bytes": True},
        {"bytes": -1},
        {"bytes": 99999999},
        {"sha256": "not-a-hash"},
        {"exp": int(time.time()) - 1},
        {"exp": int(time.time()) + 3600},
        {"iat": True},
        {"unused_url": "http://untrusted.invalid/audio"},
    ],
)
def test_rejects_invalid_expired_overbroad_or_ambiguous_grants(changes):
    with pytest.raises(PermitRejected, match="permit_invalid"):
        validate_permit(grant(**changes), KEY, SPACE)


def test_rejects_unsigned_wrong_key_and_oversized_tokens():
    for token in (
        jwt.encode(claims(), None, algorithm="none"),
        jwt.encode(claims(), b"other-test-key-of-at-least-32-bytes", algorithm="HS256"),
        "x" * 4097,
    ):
        with pytest.raises(PermitRejected):
            validate_permit(token, KEY, SPACE)


def test_replay_barrier_is_bounded_and_expired_entries_are_reclaimed():
    used = UsedPermits(capacity=1)
    first = claims()
    used.reserve(first)
    with pytest.raises(PermitRejected, match="permit_replayed"):
        used.reserve(first)
    with pytest.raises(PermitRejected, match="permit_capacity_exceeded"):
        used.reserve(claims())
    used.used[first["jti"]] = 0
    used.reserve(claims())
    assert len(used.used) == 1


def test_nested_signed_payload_is_sanitized_instead_of_crashing_decoder():
    header = base64url_encode(b'{"alg":"HS256","typ":"JWT"}')
    payload = base64url_encode(b"[" * 1100 + b"0" + b"]" * 1100)
    message = header + b"." + payload
    signature = base64url_encode(hmac.digest(KEY, message, "sha256"))
    token = (message + b"." + signature).decode()
    assert len(token) < 4096
    with pytest.raises(PermitRejected, match="permit_invalid"):
        validate_permit(token, KEY, SPACE)
