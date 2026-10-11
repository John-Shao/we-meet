"""Fixed internal sampler endpoints; no redirect or arbitrary audio destination."""

import json
import os
import re
import ssl
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from uuid import UUID, uuid4

import aiohttp

MAX_RESPONSE = 16384
HTTP_SECONDS = 2
MIN_CLIP_MS = 3000
MAX_CLIP_MS = 10000
SAMPLE_RATE = 24000
MAX_PERMIT_TTL = 31
MIN_TOKEN_LENGTH = 32
MAX_TOKEN_LENGTH = 512
MAX_PORT = 65535
MAX_CA_BYTES = 1048576
ASCII_FIRST = 33
ASCII_LAST = 126


class SamplingError(ValueError):
    """Fixed, non-private failure code safe for process diagnostics."""


def identifier(value):
    """Require one bounded ASCII RTC identifier."""
    if (
        not isinstance(value, str)
        or re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value) is None
    ):
        raise SamplingError("sampling_identity_invalid")
    return value


def grant_valid(grant, origin, identity):
    """Require a current, bounded permit for exactly the observed connection."""
    try:
        expiry = datetime.fromisoformat(grant["expires_at"])
        UUID(grant["id"])
        UUID(grant["user_id"])
        UUID(grant["session_id"])
        if (
            any(grant.get(key) != value for key, value in origin.items())
            or grant["identity"] != identity
            or not isinstance(grant["token"], str)
            or re.fullmatch(r"[A-Za-z0-9_-]{43}", grant["token"]) is None
            or type(grant["max_duration_ms"]) is not int
            or not MIN_CLIP_MS <= grant["max_duration_ms"] <= MAX_CLIP_MS
            or grant["sample_rate"] != SAMPLE_RATE
            or grant["channels"] != 1
            or expiry.tzinfo is None
            or not 0
            < (expiry - datetime.now(timezone.utc)).total_seconds()
            <= MAX_PERMIT_TTL
        ):
            raise ValueError
    except (TypeError, ValueError, KeyError, AttributeError):
        raise SamplingError("sampling_grant_invalid") from None
    return grant


class SamplingClient:
    """Use only the distinct sampler credential, never an ordinary agent token."""

    def __init__(self, base_url, token, *, ca_bundle=None):
        """Validate operator configuration before any connection or request."""
        try:
            parsed = urlsplit(base_url)
            if parsed.port is not None and not 1 <= parsed.port <= MAX_PORT:
                raise ValueError
        except (ValueError, TypeError):
            raise SamplingError("sampling_configuration_invalid") from None
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
            or any(char.isspace() for char in base_url)
            or not isinstance(token, str)
            or not token.isascii()
            or not MIN_TOKEN_LENGTH <= len(token) <= MAX_TOKEN_LENGTH
            or any(not ASCII_FIRST <= ord(char) <= ASCII_LAST for char in token)
        ):
            raise SamplingError("sampling_configuration_invalid")
        self.endpoint = base_url.rstrip("/") + "/api/agent/voiceprint-sampling/permits/"
        self._token = token
        self.ssl_context = None
        if ca_bundle is not None:
            try:
                if parsed.scheme != "https" or not Path(ca_bundle).is_absolute():
                    raise ValueError
                with Path(ca_bundle).open("rb") as stream:
                    raw = stream.read(MAX_CA_BYTES + 1)
                if len(raw) > MAX_CA_BYTES:
                    raise ValueError
                self.ssl_context = ssl.create_default_context()
                self.ssl_context.load_verify_locations(cadata=raw.decode("ascii"))
            except (OSError, ValueError, TypeError):
                raise SamplingError("sampling_configuration_invalid") from None

    @classmethod
    def from_env(cls):
        """Missing separate configuration fails closed."""
        from voiceprint.configuration import secret  # noqa: PLC0415

        return cls(
            os.getenv("AGENT_BACKEND_API_URL", ""),
            secret("MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN"),
            ca_bundle=os.getenv("VOICEPRINT_SAMPLER_BACKEND_CA_FILE"),
        )

    async def _send(self, method, path, body, *, headers=None):
        """Bound the complete request, including trickled headers and body."""
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=HTTP_SECONDS),
                trust_env=False,
                auto_decompress=False,
                read_bufsize=4096,
                cookie_jar=aiohttp.DummyCookieJar(),
            ) as session:
                async with session.request(
                    method,
                    self.endpoint + path,
                    data=body,
                    allow_redirects=False,
                    ssl=self.ssl_context or True,
                    headers={
                        "X-Voiceprint-Agent-Token": self._token,
                        "Accept-Encoding": "identity",
                        **(headers or {}),
                    },
                ) as response:
                    if response.status not in {200, 202} or response.headers.get(
                        "Content-Encoding"
                    ) not in {None, "identity"}:
                        return None
                    encoded = bytearray()
                    while len(encoded) <= MAX_RESPONSE:
                        chunk = await response.content.read(
                            min(4096, MAX_RESPONSE + 1 - len(encoded))
                        )
                        if not chunk:
                            break
                        encoded.extend(chunk)
                    if len(encoded) > MAX_RESPONSE:
                        return None
                    result = json.loads(encoded)
                    return result if isinstance(result, dict) else None
        except (OSError, ValueError, RecursionError, aiohttp.ClientError, TimeoutError):
            return None

    async def issue(self, origin):
        """Retry an ambiguous reservation with exactly the same request nonce."""
        body = json.dumps({**origin, "request_key": str(uuid4())}).encode()
        for _ in range(2):
            result = await self._send(
                "POST",
                "",
                body,
                headers={"Content-Type": "application/json"},
            )
            if result is not None:
                return result
        return None

    async def validate(self, grant, origin):
        """An unavailable authorization check always stops sampling."""
        return await self._validate(grant, origin)

    async def progress(self, grant, origin, phase, sequence):
        """Report a short-lived phase using the same current authorization check."""
        if (
            phase not in {"waiting", "sampling", "uploading", "stopped"}
            or type(sequence) is not int
            or not 0 <= sequence <= 2**31 - 1
        ):
            return False
        return await self._validate(
            grant, origin, activity_phase=phase, activity_sequence=sequence
        )

    async def _validate(self, grant, origin, **activity):
        body = json.dumps({**origin, "token": grant["token"]}).encode()
        if activity:
            body = json.dumps({**origin, "token": grant["token"], **activity}).encode()
        result = await self._send(
            "POST",
            str(UUID(grant["id"])) + "/validate/",
            body,
            headers={"Content-Type": "application/json"},
        )
        return result == grant

    async def upload(self, grant, origin, wav):
        """Reuse the identical bounded bytes and permit after a lost acknowledgement."""
        path = str(UUID(grant["id"])) + "/clip/?" + urlencode(origin)
        headers = {
            "Content-Type": "audio/wav",
            "X-Voiceprint-Permit-Token": grant["token"],
        }
        for _ in range(2):
            result = await self._send("PUT", path, wav, headers=headers)
            if result is not None:
                try:
                    UUID(result["id"])
                except (KeyError, ValueError, TypeError):
                    return None
                return result
        return None
