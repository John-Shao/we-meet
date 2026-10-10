"""Offline sampler configuration, bounded Secret files and explicit room budgets."""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from voiceprint.client import (
    ASCII_FIRST,
    ASCII_LAST,
    MAX_PORT,
    SamplingClient,
    SamplingError,
)


def secret(name, *, minimum=32, maximum=512):
    """Use one source only, and never include a value or path in errors."""
    value, filename = os.getenv(name), os.getenv(name + "_FILE")
    try:
        if filename is not None:
            if value is not None or not Path(filename).is_absolute():
                raise ValueError
            with Path(filename).open("rb") as stream:
                raw = stream.read(maximum + 3)
            if len(raw) > maximum + 2:
                raise ValueError
            value = raw.strip().decode("ascii")
        if (
            not isinstance(value, str)
            or not minimum <= len(value) <= maximum
            or not value.isascii()
            or any(ord(char) < ASCII_FIRST or ord(char) > ASCII_LAST for char in value)
        ):
            raise ValueError
        return value
    except (OSError, ValueError, UnicodeError):
        raise SamplingError("sampling_configuration_invalid") from None


def switch(name):
    """A missing business flag is disabled; malformed values fail closed."""
    value = os.getenv(name, "false").lower()
    if value not in {"true", "false"}:
        raise SamplingError("sampling_configuration_invalid")
    return value == "true"


def integer(name, default, *, minimum, maximum):
    """Bound process counts independently of SDK or host CPU defaults."""
    value = os.getenv(name, str(default))
    if re.fullmatch(r"[0-9]{1,5}", value) is None:
        raise SamplingError("sampling_configuration_invalid")
    number = int(value)
    if not minimum <= number <= maximum:
        raise SamplingError("sampling_configuration_invalid")
    return number


@dataclass(frozen=True)
class Configuration:
    """No credentials appear in repr, command arguments or health output."""

    agent_name: str
    livekit_url: str = field(repr=False)
    api_key: str = field(repr=False)
    api_secret: str = field(repr=False)
    max_rooms: int
    job_memory_mb: int
    enabled: bool

    @classmethod
    def from_env(cls):
        """Check private inputs before opening a server or LiveKit connection."""
        try:
            agent_name = os.getenv("MEETING_VOICEPRINT_SAMPLING_AGENT_NAME", "")
            if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", agent_name) is None:
                raise ValueError
            url = os.getenv("LIVEKIT_URL", "")
            parsed = urlsplit(url)
            if (
                parsed.scheme not in {"ws", "wss"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
                or parsed.path not in {"", "/"}
                or any(char.isspace() for char in url)
                or (parsed.port is not None and not 1 <= parsed.port <= MAX_PORT)
            ):
                raise ValueError
            key = secret("LIVEKIT_API_KEY", minimum=1)
            api_secret = secret("LIVEKIT_API_SECRET")
            client = SamplingClient.from_env()
            ordinary_token = None
            if (
                "AGENT_INTERNAL_API_TOKEN" in os.environ
                or "AGENT_INTERNAL_API_TOKEN_FILE" in os.environ
            ):
                ordinary_token = secret("AGENT_INTERNAL_API_TOKEN")
            if client._token in {
                key,
                api_secret,
                ordinary_token,
            }:
                raise ValueError
            enabled = switch("MEETING_VOICEPRINT_ENABLED")
            sampling = switch("MEETING_VOICEPRINT_SAMPLING_ENABLED")
            return cls(
                agent_name,
                url,
                key,
                api_secret,
                integer("VOICEPRINT_SAMPLER_MAX_ROOMS", 1, minimum=1, maximum=8),
                integer(
                    "VOICEPRINT_SAMPLER_JOB_MEMORY_MB", 256, minimum=128, maximum=2048
                ),
                enabled and sampling,
            )
        except (TypeError, ValueError, OSError):
            raise SamplingError("sampling_configuration_invalid") from None
