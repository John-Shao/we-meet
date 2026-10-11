"""Short-lived, payload- and model-bound grants from the authorized job backend."""

import hashlib
import time
from uuid import UUID

import jwt

from voiceprint.spec import MAX_BODY_BYTES

CLAIMS = {
    "iss",
    "aud",
    "sub",
    "jti",
    "iat",
    "nbf",
    "exp",
    "scope",
    "sha256",
    "bytes",
    "space",
}
MAX_PERMIT_SECONDS = 120


class PermitRejected(ValueError):
    pass


def validate_permit(token: str, key: bytes, space: str) -> dict:
    if not token or len(token) > 4096:
        raise PermitRejected("permit_invalid")
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["HS256"],
            issuer="we-meet",
            audience="voiceprint-encoder",
            options={"require": sorted(CLAIMS), "strict_aud": True},
        )
        if set(claims) != CLAIMS or claims["scope"] != "embedding":
            raise ValueError
        if (
            str(UUID(claims["sub"])) != claims["sub"]
            or str(UUID(claims["jti"])) != claims["jti"]
        ):
            raise ValueError
        if any(
            type(claims[name]) is not int for name in ("iat", "nbf", "exp", "bytes")
        ):
            raise ValueError
        if (
            claims["nbf"] != claims["iat"]
            or not 0 < claims["exp"] - claims["iat"] <= MAX_PERMIT_SECONDS
        ):
            raise ValueError
        if not 1 <= claims["bytes"] <= MAX_BODY_BYTES or claims["space"] != space:
            raise ValueError
        digest = claims["sha256"]
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(c not in "0123456789abcdef" for c in digest)
        ):
            raise ValueError
    except (
        jwt.InvalidTokenError,
        ValueError,
        TypeError,
        AttributeError,
        RecursionError,
        OverflowError,
    ) as error:
        raise PermitRejected("permit_invalid") from error
    return claims


def validate_payload(claims: dict, body: bytes):
    if (
        len(body) != claims["bytes"]
        or hashlib.sha256(body).hexdigest() != claims["sha256"]
    ):
        raise PermitRejected("permit_payload_mismatch")


class UsedPermits:
    """Bounded in-process replay barrier, not a replacement for backend lease checks."""

    def __init__(self, capacity: int = 1024):
        self.capacity = capacity
        self.used: dict[str, int] = {}

    def reserve(self, claims: dict):
        now = time.time()
        self.used = {
            key: expires for key, expires in self.used.items() if expires > now
        }
        if claims["jti"] in self.used:
            raise PermitRejected("permit_replayed")
        if len(self.used) >= self.capacity:
            raise PermitRejected("permit_capacity_exceeded")
        self.used[claims["jti"]] = claims["exp"]
