"""Content-free stage failures shared by the file adapter and capture worker."""

import json
import logging
import time
import uuid
from contextlib import contextmanager

STAGES = frozenset(
    {
        "manifest",
        "control",
        "storage_read",
        "audio_validate",
        "storage_prepare",
        "storage_upload",
        "storage_sign",
        "transcription_submit",
        "transcription_poll",
        "result_fetch",
        "result_parse",
        "delivery",
        "cleanup",
        "finish",
        "execution",
    }
)
CODES = frozenset({"failed", "timeout", "no_speech"})
PREFIX = "capture_diagnostic "


class StageError(ValueError):
    """Carry only enum values, never a provider exception or response body."""

    def __init__(self, stage, code="failed"):
        """Reject accidental content-bearing diagnostics at construction."""
        self.stage = stage if stage in STAGES else "execution"
        self.code = code if code in CODES else "failed"
        super().__init__(self.stage + ":" + self.code)


@contextmanager
def stage(name):
    """Preserve the innermost stage and cancellation across async task groups."""
    try:
        yield
    except (StageError, ExceptionGroup):
        raise
    except Exception as exc:
        raise StageError(
            name, "timeout" if isinstance(exc, TimeoutError) else "failed"
        ) from None


def failures(error):
    """Flatten bounded task-group failures without inspecting exception text."""
    if isinstance(error, BaseExceptionGroup):
        return [failure for child in error.exceptions for failure in failures(child)][
            :8
        ]
    if isinstance(error, StageError):
        return [error]
    return [
        StageError(
            "execution", "timeout" if isinstance(error, TimeoutError) else "failed"
        )
    ]


def emit(job_id, error, started):
    """Log a fixed schema suitable for a read-only, allowlisted operator probe."""
    diagnostic = {
        "job_id": str(uuid.UUID(str(job_id))),
        "stage": error.stage,
        "code": error.code,
        "elapsed_ms": max(0, round((time.monotonic() - started) * 1000)),
    }
    logging.getLogger("capture-transcriber").warning(
        PREFIX + "%s", json.dumps(diagnostic)
    )
