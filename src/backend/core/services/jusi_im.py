"""HMAC-authenticated client for the jusi-light-im admin API.

Talks to ``POST /admin/tokens/issue`` and surfaces a small typed result object.

The signing scheme matches jusi-light-im's `internal/api/admin/auth.go`:

    sig = HMAC_SHA256(secret, METHOD + "\\n" + PATH + "\\n" + UNIX_TS + "\\n" + RAW_BODY)

method + path are included to prevent a captured signature from being replayed against
a different endpoint.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from dataclasses import dataclass
from typing import Any

import requests

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class JusiImTokenResponse:
    """Result of POST /admin/tokens/issue."""

    uid: str
    token: str
    expires_at: int  # unix seconds


class JusiImServiceError(Exception):
    """Base for failures talking to jusi-light-im."""


class JusiImUnreachableError(JusiImServiceError):
    """Network-level failure: DNS, connect refused, timeout, 5xx."""


class JusiImBadResponseError(JusiImServiceError):
    """HTTP returned but the response was malformed or 4xx."""


class JusiImAdminClient:
    """Thin HMAC-signing wrapper around the jusi-light-im admin endpoints we use."""

    def __init__(
        self,
        api_url: str,
        admin_hmac_secret: str,
        *,
        timeout_seconds: float = 5.0,
    ) -> None:
        if not api_url:
            raise ValueError("api_url is required")
        if not admin_hmac_secret or len(admin_hmac_secret) < 32:
            raise ValueError("admin_hmac_secret must be at least 32 characters")
        # Strip trailing slash so we can safely concatenate `/admin/...`.
        self._api_url = api_url.rstrip("/")
        self._secret = admin_hmac_secret.encode("utf-8")
        self._timeout = timeout_seconds

    def issue_token(self, external_id: str, ttl_seconds: int) -> JusiImTokenResponse:
        """Resolve external_id → uid in jusi-light-im and sign a fresh IM JWT."""
        if not external_id:
            raise ValueError("external_id is required")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")

        path = "/admin/tokens/issue"
        body = self._json_body({"external_id": external_id, "ttl_seconds": ttl_seconds})
        headers = self._signed_headers("POST", path, body)
        url = self._api_url + path

        try:
            response = requests.post(
                url,
                data=body,
                headers=headers,
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            logger.exception("jusi-im admin unreachable: %s", url)
            raise JusiImUnreachableError(str(exc)) from exc

        if response.status_code >= 500:
            raise JusiImUnreachableError(
                f"jusi-im returned {response.status_code} from {path}"
            )
        if response.status_code >= 400:
            raise JusiImBadResponseError(
                f"jusi-im returned {response.status_code} from {path}: "
                f"{response.text[:200]}"
            )
        try:
            data: dict[str, Any] = response.json()
        except ValueError as exc:
            raise JusiImBadResponseError("response was not JSON") from exc

        try:
            return JusiImTokenResponse(
                uid=data["uid"],
                token=data["token"],
                expires_at=int(data["expires_at"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise JusiImBadResponseError(f"unexpected response shape: {data}") from exc

    # ---- helpers ----

    def _signed_headers(self, method: str, path: str, body: bytes) -> dict[str, str]:
        ts = str(int(time.time()))
        mac = hmac.new(self._secret, digestmod=hashlib.sha256)
        mac.update(method.encode("ascii"))
        mac.update(b"\n")
        mac.update(path.encode("utf-8"))
        mac.update(b"\n")
        mac.update(ts.encode("ascii"))
        mac.update(b"\n")
        mac.update(body)
        return {
            "Content-Type": "application/json",
            "X-Timestamp": ts,
            "X-Signature": mac.hexdigest(),
        }

    @staticmethod
    def _json_body(payload: dict[str, Any]) -> bytes:
        # Compact form so the body bytes match exactly what we sign + send on the wire.
        import json

        return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode(
            "utf-8"
        )
