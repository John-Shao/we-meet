"""HTTP client for posting transcripts to the we-meet backend.

Called by ``multi_user_transcriber.py`` on each FINAL_TRANSCRIPT event from
the STT engine. Authenticates via a shared ``AGENT_INTERNAL_API_TOKEN``
header. Failures are logged but never raised — losing a single transcript
must not crash the transcription session.

Env vars consumed:
    AGENT_BACKEND_API_URL      base URL, e.g. ``http://meet-backend:8000``
    AGENT_INTERNAL_API_TOKEN   shared secret matching the backend setting
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from typing import Optional

logger = logging.getLogger("transcript-writer")

_MAX_ATTEMPTS = 3
_HTTP_BAD_REQUEST = 400
_HTTP_TOO_MANY_REQUESTS = 429
_HTTP_SERVER_ERROR = 500


class TranscriptWriter:
    """Async transcript-ingestion client. Best-effort, fire-and-forget OK."""

    def __init__(self, *, base_url: str, token: str, timeout: float = 5.0) -> None:
        """Configure the trusted backend endpoint and agent credential."""
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout
        self._endpoint = f"{self._base_url}/api/agent/transcripts/"

    @classmethod
    def from_env(cls) -> "TranscriptWriter":
        """Construct from ``AGENT_BACKEND_API_URL`` / ``AGENT_INTERNAL_API_TOKEN``."""
        base_url = os.getenv("AGENT_BACKEND_API_URL", "")
        token = os.getenv("AGENT_INTERNAL_API_TOKEN", "")
        return cls(base_url=base_url, token=token)

    @property
    def is_configured(self) -> bool:
        """True iff both base URL and token are non-empty."""
        return bool(self._base_url and self._token)

    async def write(  # noqa: PLR0913 - mirrors the transcript wire contract
        self,
        *,
        room_id: str,
        livekit_room_sid: str,
        speaker_identity: str,
        speaker_name: str,
        text: str,
        language: str,
        started_at: datetime,
        ended_at: Optional[datetime] = None,
        translations: Optional[dict] = None,
        ingest_id: Optional[str] = None,
    ) -> None:
        """POST one transcript row with a stable key across transient retries."""
        if not self.is_configured:
            logger.debug("TranscriptWriter not configured; dropping transcript")
            return
        if not text.strip():
            return

        payload = {
            "room_id": room_id,
            "livekit_room_sid": livekit_room_sid,
            "ingest_id": ingest_id or str(uuid.uuid4()),
            "speaker_identity": speaker_identity,
            "speaker_name": speaker_name or "",
            "text": text,
            "language": language or "",
            "started_at": started_at.isoformat(),
        }
        if ended_at is not None:
            payload["ended_at"] = ended_at.isoformat()
        if translations:
            payload["translations"] = translations

        for attempt in range(_MAX_ATTEMPTS):
            try:
                await asyncio.to_thread(self._post_sync, payload)
                return
            except (OSError, urllib.error.URLError):
                if attempt == _MAX_ATTEMPTS - 1:
                    logger.exception(
                        "Failed to ingest transcript after retries "
                        "room=%s room_sid=%s speaker=%s ingest_id=%s",
                        room_id,
                        livekit_room_sid,
                        speaker_identity,
                        payload["ingest_id"],
                    )
                    return
                await asyncio.sleep(0.25 * (2**attempt))

    def _post_sync(self, payload: dict) -> bool:
        body = json.dumps(payload).encode("utf-8")
        # The endpoint is assembled from an operator-controlled HTTP(S) base URL.
        req = urllib.request.Request(  # noqa: S310
            self._endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Agent-Token": self._token,
            },
        )
        try:
            with urllib.request.urlopen(  # noqa: S310
                req, timeout=self._timeout
            ) as resp:
                if resp.status >= _HTTP_BAD_REQUEST:
                    logger.warning(
                        "Transcript ingest got HTTP %s: %s",
                        resp.status,
                        resp.read(500),
                    )
                else:
                    logger.info(
                        "ingested transcript speaker=%s lang=%s text=%r",
                        payload.get("speaker_identity", ""),
                        payload.get("language", ""),
                        payload.get("text", "")[:80],
                    )
                    return True
        except urllib.error.HTTPError as e:
            response_body = e.read(500)
            if e.code == _HTTP_TOO_MANY_REQUESTS or e.code >= _HTTP_SERVER_ERROR:
                raise
            logger.warning("Transcript ingest HTTP %s: %s", e.code, response_body)
            return False

        return False
