"""Versioned Fernet envelopes for reversible provider OAuth credentials."""

from __future__ import annotations

from django.conf import settings

from cryptography.fernet import Fernet, InvalidToken


class CalendarCredentialError(Exception):
    pass


def _keys() -> list[str]:
    cfg = getattr(settings, "EXTERNAL_CALENDAR_CONFIGURATION", None) or {}
    keys = [str(value).strip() for value in cfg.get("token_keys", []) if str(value).strip()]
    if not keys:
        raise CalendarCredentialError("external calendar token_keys are not configured")
    return keys


def encrypt(value: str) -> str:
    if not value:
        return ""
    key = _keys()[0]
    try:
        token = Fernet(key.encode("ascii")).encrypt(value.encode("utf-8")).decode("ascii")
    except (ValueError, TypeError) as exc:
        raise CalendarCredentialError("invalid primary calendar encryption key") from exc
    return f"v1:{token}"


def decrypt(envelope: str) -> str:
    if not envelope:
        return ""
    if not envelope.startswith("v1:"):
        raise CalendarCredentialError("unsupported credential envelope")
    token = envelope[3:].encode("ascii")
    for key in _keys():
        try:
            return Fernet(key.encode("ascii")).decrypt(token).decode("utf-8")
        except (InvalidToken, ValueError, TypeError):
            continue
    raise CalendarCredentialError("credential cannot be decrypted with configured keys")
