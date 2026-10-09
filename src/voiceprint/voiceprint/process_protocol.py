"""Bounded local model IPC, never pickle or user-selected executable/model code."""

import math

from voiceprint.spec import (
    DIMENSION,
    MAX_SECONDS,
    MIN_SECONDS,
    MODEL_ID,
    MODEL_REVISION,
    PREPROCESS_VERSION,
    SAMPLE_RATE,
)

MAX_HEADER_BYTES = 8192
MAX_OUTPUT_BYTES = 65536
MAX_PCM_BYTES = SAMPLE_RATE * MAX_SECONDS * 4


class EncoderProcessError(ValueError):
    """Fixed non-sensitive process failure code."""


def validate_quality(quality, frames):
    if not isinstance(quality, dict) or set(quality) != {
        "duration_ms",
        "rms_dbfs",
        "ac_rms_dbfs",
        "clipped_fraction",
        "validation",
        "speech_checked",
        "speaker_consistency_checked",
    }:
        raise EncoderProcessError("encoder_protocol_invalid")
    if (
        type(quality["duration_ms"]) is not int
        or quality["duration_ms"] != frames * 1000 // SAMPLE_RATE
        or quality["validation"] != "signal-only-v1"
        or quality["speech_checked"] is not False
        or quality["speaker_consistency_checked"] is not False
        or any(
            type(quality[key]) not in (float, int)
            or abs(quality[key]) > 240
            or not math.isfinite(quality[key])
            for key in ("rms_dbfs", "ac_rms_dbfs", "clipped_fraction")
        )
        or not -240 <= quality["rms_dbfs"] <= 0
        or not -60.001 <= quality["ac_rms_dbfs"] <= 0
        or not 0 <= quality["clipped_fraction"] <= 0.02
    ):
        raise EncoderProcessError("encoder_protocol_invalid")


def validate_frames(frames):
    if (
        type(frames) is not int
        or not SAMPLE_RATE * MIN_SECONDS <= frames <= SAMPLE_RATE * MAX_SECONDS
    ):
        raise EncoderProcessError("encoder_protocol_invalid")


def validate_result(result, *, space, quality):
    expected = {
        "feature_space": space,
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "preprocess_version": PREPROCESS_VERSION,
        "dimension": DIMENSION,
        "sample_rate": SAMPLE_RATE,
        "normalization": "l2",
    }
    if not isinstance(result, dict) or set(result) != {*expected, "vector", "quality"}:
        raise EncoderProcessError("encoder_protocol_invalid")
    if any(
        type(result[key]) is not type(value) or result[key] != value
        for key, value in expected.items()
    ):
        raise EncoderProcessError("encoder_protocol_invalid")
    vector = result["vector"]
    if (
        not isinstance(vector, list)
        or len(vector) != DIMENSION
        or any(
            type(value) not in (int, float)
            or not -1.00001 <= value <= 1.00001
            or not math.isfinite(value)
            for value in vector
        )
    ):
        raise EncoderProcessError("encoder_protocol_invalid")
    if (
        abs(math.sqrt(math.fsum(float(value) ** 2 for value in vector)) - 1) > 1e-4
        or result["quality"] != quality
    ):
        raise EncoderProcessError("encoder_protocol_invalid")
    validate_quality(result["quality"], quality["duration_ms"] * SAMPLE_RATE // 1000)
    return result
