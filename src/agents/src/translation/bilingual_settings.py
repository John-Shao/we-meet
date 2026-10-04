"""Validated per-connection limits for bilingual recognition and recovery."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class BilingualSettings:
    """Keep recognition/recovery below the bounded microphone backlog."""

    probe_ms: int = 800
    retry_ms: int = 400
    max_failures: int = 3
    detection_timeout: float = 4.0
    turn_silence_ms: int = 1000

    @classmethod
    def from_env(cls):
        """Reject invalid tuning before opening provider connections."""
        limits = {
            "probe_ms": ("TRANSLATION_LID_PROBE_MS", 800, 200, 3000),
            "retry_ms": ("TRANSLATION_LID_RETRY_MS", 400, 200, 2000),
            "max_failures": ("TRANSLATION_LID_MAX_FAILURES", 3, 1, 5),
            "detection_timeout": ("TRANSLATION_LID_TIMEOUT_MS", 4000, 1000, 5000),
            "turn_silence_ms": ("TRANSLATION_TURN_SILENCE_MS", 1000, 300, 2000),
        }
        values = {}
        for field, (name, default, low, high) in limits.items():
            try:
                value = int(os.environ.get(name, default))
                if not low <= value <= high:
                    raise ValueError
            except (ValueError, TypeError):
                raise ValueError(f"Invalid {name}") from None
            values[field] = value / 1000 if field == "detection_timeout" else value
        return cls(**values)
