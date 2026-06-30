"""HTTP client for La Suite Docs' server-to-server document API (P3).

Talks to ``POST /api/v1.0/documents/create-for-owner/`` — Docs' purpose-built
server-to-server endpoint (auth class ``ServerToServerAuthentication``, gated by a
shared token in Docs' ``SERVER_TO_SERVER_API_TOKENS``). Lets we-meet create a
document owned by a given user — identified by Keycloak ``sub`` with ``email`` as a
fallback so Docs can lazily provision a user who hasn't logged into Docs yet — with
initial **markdown** content (Docs converts it to its internal yjs format via a Node
microservice). Used to land a meeting summary as a collaborative Doc (妙记).

Design + spike findings: docs/phases/p3-collab-docs.md. Mirrors the shape of
core/services/jusi_im.py (typed result + Unreachable/BadResponse error split).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import requests

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DocsCreateResponse:
    """Result of POST /api/v1.0/documents/create-for-owner/."""

    id: str


class DocsServiceError(Exception):
    """Base for failures talking to La Suite Docs."""


class DocsUnreachableError(DocsServiceError):
    """Network-level failure: DNS, connect refused, timeout, 5xx."""


class DocsBadResponseError(DocsServiceError):
    """HTTP returned but the response was 4xx / malformed."""


class DocsClient:
    """Thin client over the Docs server-to-server document endpoint."""

    CREATE_FOR_OWNER_PATH = "/api/v1.0/documents/create-for-owner/"

    def __init__(
        self,
        api_url: str,
        server_to_server_token: str,
        *,
        timeout_seconds: float = 5.0,
    ) -> None:
        if not api_url:
            raise ValueError("api_url is required")
        if not server_to_server_token:
            raise ValueError("server_to_server_token is required")
        self._api_url = str(api_url).rstrip("/")
        self._token = str(server_to_server_token)
        self._timeout = timeout_seconds

    def create_for_owner(
        self,
        *,
        sub: str,
        email: str,
        title: str,
        content: str,
        message: str | None = None,
        subject: str | None = None,
    ) -> DocsCreateResponse:
        """Create a Docs document owned by (sub/email) with markdown ``content``.

        ``content`` is markdown — Docs converts it server-side to its internal
        format. Returns the created document id.
        """
        if not sub and not email:
            raise ValueError("sub or email is required to identify the owner")
        if not title:
            raise ValueError("title is required")

        payload: dict[str, Any] = {
            "sub": str(sub or ""),
            "email": str(email or ""),
            "title": title,
            "content": content or "",
        }
        if message:
            payload["message"] = message
        if subject:
            payload["subject"] = subject

        url = self._api_url + self.CREATE_FOR_OWNER_PATH
        try:
            response = requests.post(
                url,
                json=payload,
                # Docs' ServerToServerAuthentication bears a token listed in its
                # SERVER_TO_SERVER_API_TOKENS. Exact header format to confirm at
                # deploy (read Docs core/api/authentication.py); Bearer is the default.
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            logger.exception("docs server unreachable: %s", url)
            raise DocsUnreachableError(str(exc)) from exc

        if response.status_code >= 500:
            raise DocsUnreachableError(
                f"docs returned {response.status_code} from {self.CREATE_FOR_OWNER_PATH}"
            )
        if response.status_code >= 400:
            raise DocsBadResponseError(
                f"docs returned {response.status_code} from "
                f"{self.CREATE_FOR_OWNER_PATH}: {response.text[:200]}"
            )
        try:
            data: dict[str, Any] = response.json()
        except ValueError as exc:
            raise DocsBadResponseError("response was not JSON") from exc
        try:
            return DocsCreateResponse(id=str(data["id"]))
        except (KeyError, TypeError) as exc:
            raise DocsBadResponseError(f"unexpected response shape: {data}") from exc
