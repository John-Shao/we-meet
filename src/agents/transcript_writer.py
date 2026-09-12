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
from http import HTTPStatus
from typing import Optional

from asr_observer import ASRObserver

logger = logging.getLogger("transcript-writer")

_MAX_ATTEMPTS = 3
_HTTP_BAD_REQUEST = 400
_HTTP_TOO_MANY_REQUESTS = 429
_HTTP_SERVER_ERROR = 500


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward the internal agent credential to a redirected destination."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: PLR0913, PLR0917
        return None


def _open(request, *, timeout):
    return urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout)


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
        self._asr = ASRObserver()
        self._terminal_payload = None
        self._require_delivery = False

    def observe_asr(self, event):
        """Record provider observations separately from text delivery sequences."""
        self._asr.observe(event)

    async def begin_delivery(
        self, room_id: str, livekit_room_sid: str, *, delivery_id=None, writer_id=None
    ) -> bool:
        """Register one run before processing events; unknown sessions fail closed."""
        self._require_delivery = True
        if not self.is_configured or not livekit_room_sid or self._delivery:
            return False
        if (delivery_id is None) != (writer_id is None):
            return False
        payload = {
            "room_id": room_id,
            "livekit_room_sid": livekit_room_sid,
            "delivery_id": str(uuid.UUID(delivery_id))
            if delivery_id
            else str(uuid.uuid4()),
            **({"writer_id": str(uuid.UUID(writer_id))} if writer_id else {}),
        }
        if await self._send({**payload, "action": "begin"}, control=True):
            self._delivery = payload
            return True
        logger.warning(
            "Delivery registration unavailable; source coverage remains unverified"
        )
        return False

    async def capture_state(self):
        """Poll once within three seconds; the controller bounds lease loss."""
        if not self._delivery or not self._delivery.get("writer_id"):
            return None
        try:
            return await asyncio.to_thread(self._capture_state_sync)
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _capture_state_sync(self):
        request = urllib.request.Request(  # noqa: S310 -- operator-controlled backend
            f"{self._base_url}/api/agent/capture-heartbeat/",
            data=json.dumps(self._delivery).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "X-Agent-Token": self._token},
        )
        with _open(request, timeout=min(self._timeout, 3)) as response:
            ack = json.loads(response.read(4096))
            if (
                response.status != HTTPStatus.OK
                or not isinstance(ack, dict)
                or ack.get("status") != "ok"
                or ack.get("id") != self._delivery["delivery_id"]
            ):
                return None
            state = ack.get("state")
            return (
                state
                if state
                in {"starting", "recording", "stopping", "stopped", "incomplete"}
                else None
            )

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
        if self._terminal_payload is None:
            report = self._asr.manifest(pipeline_failed=self._failed)
            incomplete = self._failed or bool(
                report
                and (
                    report["errors"]
                    or report["streams_started"] != report["streams_finished"]
                    or report["tasks_started"] != report["tasks_finished"]
                )
            )
            self._terminal_payload = {
                **self._delivery,
                "action": "finish",
                "final_sequence": self._sequence,
                "outcome": "incomplete" if incomplete else "complete",
                **({"source_report": report} if report else {}),
            }
        return await self._send(self._terminal_payload, control=True)

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
        if not self.is_configured or (self._require_delivery and not self._delivery):
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
            if self._delivery.get("writer_id"):
                payload["writer_id"] = self._delivery["writer_id"]
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
            with _open(req, timeout=self._timeout) as resp:
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
