"""HTTP client for posting transcripts to the we-meet backend.

Called by ``multi_user_transcriber.py`` on each FINAL_TRANSCRIPT event from
the STT engine. Authenticates via a shared ``AGENT_INTERNAL_API_TOKEN``
header. Expected transport failures return False and keep the delivery ledger
incomplete. Cancellation remains visible to the caller's shutdown handling.

Env vars consumed:
    AGENT_BACKEND_API_URL      base URL, e.g. ``http://meet-backend:8000``
    AGENT_INTERNAL_API_TOKEN   shared secret matching the backend setting

The transcriber enables the ledger with AGENT_TRANSCRIPT_DELIVERY_ENABLED.
The ledger verifies emitted text delivery, not complete audio recognition.
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
    """Async ingestion with explicit acknowledgements and optional delivery ledger."""

    def __init__(self, *, base_url: str, token: str, timeout: float = 5.0) -> None:
        """Configure the trusted backend endpoint and agent credential."""
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout
        self._endpoint = f"{self._base_url}/api/agent/transcripts/"
        self._delivery: dict | None = None
        self._sequence = 0
        self._failed = False
        self._closed = False

    async def begin_delivery(self, room_id: str, livekit_room_sid: str) -> bool:
        """Register one run before processing events; unknown sessions fail closed."""
        if not self.is_configured or not livekit_room_sid or self._delivery:
            return False
        payload = {
            "room_id": room_id,
            "livekit_room_sid": livekit_room_sid,
            "delivery_id": str(uuid.uuid4()),
        }
        if await self._send({**payload, "action": "begin"}, control=True):
            self._delivery = payload
            return True
        logger.warning(
            "Delivery registration unavailable; source coverage remains unverified"
        )
        return False

    def reserve_sequence(self) -> int | None:
        """Reserve at FINAL event arrival, before translation or asynchronous writes."""
        if self._closed:
            raise RuntimeError("Transcript writer is closed")
        if self._delivery is None:
            return None
        self._sequence += 1
        return self._sequence

    def mark_incomplete(self) -> None:
        """Remember processing or drain failures even if some events were delivered."""
        self._failed = True

    async def finish_delivery(self) -> bool:
        """Call after draining every producer and write; never promote failed runs."""
        self._closed = True
        if self._delivery is None:
            return False
        payload = {
            **self._delivery,
            "action": "finish",
            "final_sequence": self._sequence,
            "outcome": "incomplete" if self._failed else "complete",
        }
        return await self._send(payload, control=True)

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
        sequence: int | None = None,
    ) -> bool:
        """POST one transcript row with a stable key across transient retries."""
        if not self.is_configured:
            logger.debug("TranscriptWriter not configured; dropping transcript")
            self.mark_incomplete()
            return False
        if not text.strip():
            self.mark_incomplete()
            return False
        if self._closed:
            self.mark_incomplete()
            return False

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
        if self._delivery:
            if (room_id, livekit_room_sid) != (
                self._delivery["room_id"],
                self._delivery["livekit_room_sid"],
            ):
                self.mark_incomplete()
                return False
            payload["delivery_id"] = self._delivery["delivery_id"]
            payload["sequence"] = (
                sequence if sequence is not None else self.reserve_sequence()
            )
        acknowledged = await self._send(payload)
        if not acknowledged:
            self.mark_incomplete()
        return acknowledged

    async def _send(self, payload: dict, *, control: bool = False) -> bool:
        for attempt in range(_MAX_ATTEMPTS):
            try:
                if control:
                    return await asyncio.to_thread(
                        self._post_sync, payload, control=True
                    )
                return await asyncio.to_thread(self._post_sync, payload)
            except (OSError, urllib.error.URLError):
                if attempt == _MAX_ATTEMPTS - 1:
                    logger.warning(
                        "Transcript request exhausted retries ingest_id=%s",
                        payload.get("ingest_id"),
                    )
                    return False
                await asyncio.sleep(0.25 * (2**attempt))
        return False

    def _post_sync(self, payload: dict, *, control: bool = False) -> bool:
        body = json.dumps(payload).encode("utf-8")
        # The endpoint is assembled from an operator-controlled HTTP(S) base URL.
        req = urllib.request.Request(  # noqa: S310
            f"{self._base_url}/api/agent/transcript-deliveries/"
            if control
            else self._endpoint,
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
                    logger.warning("Transcript ingest got HTTP %s", resp.status)
                else:
                    try:
                        ack = json.loads(resp.read(4096))
                        uuid.UUID(ack["id"])
                        return ack["status"] == "ok" and (
                            not control or ack["id"] == payload["delivery_id"]
                        )
                    except (ValueError, KeyError, TypeError):
                        logger.warning(
                            "Transcript endpoint returned an invalid acknowledgement"
                        )
                        return False
        except urllib.error.HTTPError as e:
            if e.code == _HTTP_TOO_MANY_REQUESTS or e.code >= _HTTP_SERVER_ERROR:
                raise
            logger.warning("Transcript ingest HTTP %s", e.code)
            return False

        return False
