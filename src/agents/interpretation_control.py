"""Shared interpretation identity, control transport and expiring output grants."""

import asyncio
import json
import os
import re
import time
import urllib.request
import uuid
from http import HTTPStatus
from urllib.parse import urlsplit

from livekit import rtc

from plugins.qwen_live_translate import TranslationError
from transcript_writer import _open

MAX_RESPONSE_BYTES = 128000
MAX_SOURCES = 16
MAX_LISTENERS = 100
LEASE_SECONDS = 15
MAX_IDENTITY_LENGTH = 255


def _uuid(value):
    if (
        not isinstance(value, str)
        or str(uuid.UUID(value)) != value
        or uuid.UUID(value).int == 0
    ):
        raise ValueError("Invalid interpretation identity")
    return value


def interpretation_metadata(raw):
    """Dispatch selects a channel, never provider settings or recipients."""
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) != {"interpretation"}:
        raise ValueError("Invalid interpretation metadata")
    value = data["interpretation"]
    if not isinstance(value, dict) or set(value) != {
        "channel_id",
        "generation",
        "livekit_room_sid",
    }:
        raise ValueError("Invalid interpretation metadata")
    _uuid(value["channel_id"])
    if (
        type(value["generation"]) is not int
        or value["generation"] < 1
        or not isinstance(value["livekit_room_sid"], str)
        or not re.fullmatch(r"RM_[A-Za-z0-9_-]{1,61}", value["livekit_room_sid"])
    ):
        raise ValueError("Invalid interpretation source")
    return value


class InterpretationReporter:
    """Retry bounded internal receipts without replaying provider audio."""

    def __init__(self, room_id, metadata, *, base_url, token):
        """Freeze one operator-owned origin and unique worker identity."""
        metadata = interpretation_metadata(json.dumps({"interpretation": metadata}))
        parsed = urlsplit(base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.path not in {"", "/"}
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or not token
        ):
            raise ValueError("Invalid interpretation backend configuration")
        self.endpoint = base_url.rstrip("/") + "/api/agent/interpretation/control/"
        self.token = token
        self.identity = {
            "room_id": _uuid(room_id),
            **metadata,
            "worker_id": str(uuid.uuid4()),
        }
        self.receipt = None

    @classmethod
    def from_env(cls, room_id, metadata):
        """Read the same internal credentials as existing meeting Agents."""
        return cls(
            room_id,
            metadata,
            base_url=os.getenv("AGENT_BACKEND_API_URL", ""),
            token=os.getenv("AGENT_INTERNAL_API_TOKEN", ""),
        )

    def _send(self, payload):
        request = urllib.request.Request(  # noqa: S310 -- operator-owned origin, redirects rejected by _open
            self.endpoint,
            data=json.dumps(payload).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "X-Agent-Token": self.token},
        )
        with _open(request, timeout=3) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if response.status != HTTPStatus.OK or len(body) > MAX_RESPONSE_BYTES:
                return None
            result = json.loads(body)
        if (
            not isinstance(result, dict)
            or result.get("id") != self.identity["channel_id"]
            or type(result.get("generation")) is not int
            or result["generation"] != self.identity["generation"]
            or result.get("state")
            not in {
                "prepared",
                "starting",
                "translating",
                "stopping",
                "stopped",
                "incomplete",
            }
        ):
            return None
        return result

    async def command(self, operation, *, receipt=None):
        """Reconcile claim/finish; heartbeat failures revoke local output."""
        if operation not in {"claim", "heartbeat", "finish"}:
            raise ValueError("Invalid interpretation operation")
        payload = {**self.identity, "operation": operation}
        if operation == "finish":
            if self.receipt is None:
                self.receipt = dict(receipt)
            elif self.receipt != receipt:
                raise ValueError("Interpretation receipt changed")
            payload["receipt"] = self.receipt
        attempts = 1 if operation == "heartbeat" else 3
        for attempt in range(attempts):
            try:
                result = await asyncio.to_thread(self._send, payload)
                if result is not None:
                    return result
            except (OSError, ValueError, KeyError, TypeError):
                pass
            if attempt + 1 < attempts:
                await asyncio.sleep(0.2 * (attempt + 1))
        return None


def _people(rows, *, listeners):
    if not isinstance(rows, list) or len(rows) > (
        MAX_LISTENERS if listeners else MAX_SOURCES
    ):
        raise ValueError("Invalid interpretation grant size")
    result = {}
    identities = set()
    sids = set()
    for row in rows:
        expected = (
            {"identity", "participant_sid", "subscription_id", "revision"}
            if listeners
            else {"identity", "participant_sid", "participation_id"}
        )
        if not isinstance(row, dict) or set(row) != expected:
            raise ValueError("Invalid interpretation grant")
        identity, sid = row.get("identity"), row.get("participant_sid")
        if (
            not isinstance(identity, str)
            or not 0 < len(identity) <= MAX_IDENTITY_LENGTH
            or not isinstance(sid, str)
            or not re.fullmatch(r"PA_[A-Za-z0-9_-]{1,61}", sid)
            or identity in identities
            or sid in sids
        ):
            raise ValueError("Invalid interpretation connection")
        key = _uuid(row.get("subscription_id" if listeners else "participation_id"))
        if key in result:
            raise ValueError("Duplicate interpretation grant")
        if listeners and (type(row.get("revision")) is not int or row["revision"] < 1):
            raise ValueError("Invalid interpretation revision")
        result[key] = dict(row)
        identities.add(identity)
        sids.add(sid)
    return result


class GrantLease:
    """Expired or malformed responses revoke former listeners and source grants."""

    def __init__(self, *, clock=time.monotonic):
        """Use monotonic time independently of wall-clock changes."""
        self.clock = clock
        self.deadline = 0
        self.configuration = None
        self.state = "starting"
        self.tail = False
        self.sources = {}
        self.listeners = {}

    def deny(self):
        """Revoke local input and output immediately."""
        self.deadline = 0
        self.sources, self.listeners = {}, {}
        self.tail = False

    def accept(self, value):
        """Validate the full replacement before accepting any recipient changes."""
        self.deny()
        try:
            self.state = value["state"]
            if self.state not in {"translating", "stopping"}:
                return
            if (
                type(value.get("lease_seconds")) is not int
                or not 0 < value["lease_seconds"] <= LEASE_SECONDS
            ):
                raise ValueError("Invalid interpretation lease")
            self.tail = self.state == "stopping" and value.get("deliver_tail") is True
            if self.state == "stopping" and not self.tail:
                return
            configuration = (
                value["configuration"]
                if self.state == "translating"
                else self.configuration
            )
            if (
                not isinstance(configuration, dict)
                or configuration.get("scope") != "meeting_channel"
                or configuration.get("model") != "qwen3.5-livetranslate-flash-realtime"
                or configuration.get("target") not in {"zh", "en"}
                or configuration.get("source") is not None
                or configuration.get("audio") is not True
                or configuration.get("max_sources") != MAX_SOURCES
                or configuration.get("max_listeners") != MAX_LISTENERS
                or (self.configuration and configuration != self.configuration)
            ):
                raise ValueError("Interpretation configuration changed")
            sources = _people(value["sources"], listeners=False)
            listeners = _people(value["listeners"], listeners=True)
            self.configuration = dict(configuration)
            self.sources, self.listeners = sources, listeners
            self.deadline = self.clock() + value["lease_seconds"]
        except (ValueError, KeyError, TypeError) as exc:
            self.deny()
            raise TranslationError("invalid_interpretation_grant") from exc

    @property
    def input_allowed(self):
        """Only a live translating lease accepts new microphone frames."""
        return self.state == "translating" and self.clock() < self.deadline

    @property
    def output_allowed(self):
        """Normal stop can drain authorized tail; errors and expiry cannot."""
        return (
            self.state == "translating" or self.tail
        ) and self.clock() < self.deadline

    @staticmethod
    def matches(room, row):
        """Identity alone is insufficient after a reconnect or device change."""
        participant = room.remote_participants.get(row["identity"])
        return bool(
            participant
            and participant.sid == row["participant_sid"]
            and participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
        )

    def current_listeners(self, room):
        """A missing listener never falls back to room-wide output."""
        return (
            [row for row in self.listeners.values() if self.matches(room, row)]
            if self.output_allowed
            else []
        )

    def current_sources(self, room):
        """Exclude generated audio and former source connections."""
        return (
            [row for row in self.sources.values() if self.matches(room, row)]
            if self.input_allowed
            else []
        )

    def disconnected(self, participant):
        """Apply disconnect events before the next control-plane heartbeat."""
        for values in (self.sources, self.listeners):
            for key, row in list(values.items()):
                if (
                    row["identity"] == participant.identity
                    and row["participant_sid"] == participant.sid
                ):
                    del values[key]
