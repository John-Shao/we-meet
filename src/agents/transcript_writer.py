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
from datetime import datetime
from typing import Optional

logger = logging.getLogger("transcript-writer")


class TranscriptWriter:
    """Async transcript-ingestion client. Best-effort, fire-and-forget OK."""

    def __init__(self, *, base_url: str, token: str, timeout: float = 5.0) -> None:
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

    async def write(
        self,
        *,
        room_id: str,
        speaker_identity: str,
        speaker_name: str,
        text: str,
        language: str,
        started_at: datetime,
        ended_at: Optional[datetime] = None,
        translations: Optional[dict] = None,
    ) -> None:
        """POST one transcript row. Errors are logged, never raised."""
        if not self.is_configured:
            logger.debug("TranscriptWriter not configured; dropping transcript")
            return
        if not text.strip():
            return

        payload = {
            "room_id": room_id,
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

        try:
            await asyncio.to_thread(self._post_sync, payload)
        except Exception:
            logger.exception(
                "Failed to ingest transcript for room=%s speaker=%s",
                room_id,
                speaker_identity,
            )

    def _post_sync(self, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self._endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Agent-Token": self._token,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                if resp.status >= 400:
                    logger.warning(
                        "Transcript ingest got HTTP %s: %s",
                        resp.status,
                        resp.read(500),
                    )
        except urllib.error.HTTPError as e:
            logger.warning("Transcript ingest HTTP %s: %s", e.code, e.read(500))
