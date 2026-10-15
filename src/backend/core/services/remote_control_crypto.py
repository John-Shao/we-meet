"""Restricted canonical consent signatures and purpose-separated lease tokens.

A verified self-supplied public key proves possession, not native attestation or
human consent. The desktop must additionally match its own local consent record.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any
from uuid import uuid4

import jwt
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

AUDIENCE = "we-meet.remote-control.v1"
PURPOSES = frozenset({"prepare", "approve", "resume", "lease"})
MAX_SAFE_INTEGER = 2**53 - 1


class InvalidProof(ValueError):
    """A bounded, non-secret error suitable for mapping to an API response."""


def encode64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def decode64(value: str, length: int) -> bytes:
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"[A-Za-z0-9_-]+", value)
        or len(value) > length * 2
    ):
        raise InvalidProof("invalid_encoding")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise InvalidProof("invalid_encoding") from exc
    if len(decoded) != length or encode64(decoded) != value:
        raise InvalidProof("invalid_encoding")
    return decoded


def _check_text(value: str) -> None:
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise InvalidProof("invalid_unicode") from exc
    if len(encoded) > 4096:
        raise InvalidProof("invalid_payload")


def canonical(value: Any) -> bytes:
    """JCS-compatible restricted domain: ASCII object keys, no floats.

    Consent and lease binding schemas contain only integers, strings, booleans,
    null, objects and bounded arrays. Floating point input coordinates use the
    separate signed native binary packet, not this serializer.
    """

    def check(item: Any, depth: int = 0) -> None:
        if depth > 8:
            raise InvalidProof("invalid_payload")
        if item is None or type(item) is bool:
            return
        if type(item) is int:
            if abs(item) > MAX_SAFE_INTEGER:
                raise InvalidProof("invalid_integer")
            return
        if isinstance(item, str):
            _check_text(item)
            return
        if isinstance(item, dict):
            if len(item) > 64:
                raise InvalidProof("invalid_payload")
            for key, entry in item.items():
                if not isinstance(key, str) or not re.fullmatch(
                    r"[A-Za-z][A-Za-z0-9_]{0,63}", key
                ):
                    raise InvalidProof("invalid_key")
                check(entry, depth + 1)
            return
        if isinstance(item, list) and len(item) <= 64:
            for entry in item:
                check(entry, depth + 1)
            return
        raise InvalidProof("invalid_payload")

    check(value)
    result = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    if len(result) > 8192:
        raise InvalidProof("invalid_payload")
    return result


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def public_key(jwk: dict) -> ec.EllipticCurvePublicKey:
    if (
        not isinstance(jwk, dict)
        or set(jwk) != {"kty", "crv", "x", "y"}
        or jwk.get("kty") != "EC"
        or jwk.get("crv") != "P-256"
    ):
        raise InvalidProof("invalid_public_key")
    try:
        return ec.EllipticCurvePublicNumbers(
            int.from_bytes(decode64(jwk["x"], 32), "big"),
            int.from_bytes(decode64(jwk["y"], 32), "big"),
            ec.SECP256R1(),
        ).public_key()
    except (ValueError, TypeError) as exc:
        raise InvalidProof("invalid_public_key") from exc


def verify_consent(jwk: dict, expected: dict, signature: str) -> None:
    # Callers assemble expected from the locked database row and server challenge;
    # never verify an arbitrary client-supplied body and then use other fields.
    if (
        type(expected.get("v")) is not int
        or expected["v"] != 1
        or expected.get("purpose") not in PURPOSES
        or expected.get("audience") != AUDIENCE
    ):
        raise InvalidProof("invalid_purpose")
    raw = decode64(signature, 64)
    der = encode_dss_signature(
        int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")
    )
    try:
        public_key(jwk).verify(der, canonical(expected), ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as exc:
        raise InvalidProof("invalid_signature") from exc


def signing_key(pem: str | bytes) -> ec.EllipticCurvePrivateKey:
    try:
        key = serialization.load_pem_private_key(
            pem.encode() if isinstance(pem, str) else pem, password=None
        )
    except (ValueError, TypeError) as exc:
        raise InvalidProof("signing_key_unavailable") from exc
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(
        key.curve, ec.SECP256R1
    ):
        raise InvalidProof("signing_key_unavailable")
    return key


def issue_lease(
    binding: dict, *, pem: str | bytes, kid: str, issued_at: int, expires_at: int
) -> str:
    if (
        not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", kid)
        or type(issued_at) is not int
        or type(expires_at) is not int
    ):
        raise InvalidProof("invalid_lease")
    if not 0 < expires_at - issued_at <= 15:
        raise InvalidProof("invalid_lease")
    canonical(binding)
    # Binding is nested so even a caller mistake cannot override aud/exp/iat.
    return jwt.encode(
        {
            "aud": AUDIENCE,
            "iat": issued_at,
            "exp": expires_at,
            "jti": str(uuid4()),
            "v": 1,
            "binding": binding,
        },
        signing_key(pem),
        algorithm="ES256",
        headers={"kid": kid, "typ": "JWT"},
    )
