"""Finite fixed-space vector operations; never expose a vector through public APIs."""

import json
import math
import struct

from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_encoder import DIMENSION


def unit_vector(values):
    if (
        not isinstance(values, (list, tuple))
        or len(values) != DIMENSION
        or any(
            type(value) not in (int, float)
            or abs(value) > 1e6
            or not math.isfinite(value)
            for value in values
        )
    ):
        raise VoiceprintError("voiceprint_vector_invalid")
    norm = math.sqrt(math.fsum(value * value for value in values))
    if not math.isfinite(norm) or norm <= 1e-8:
        raise VoiceprintError("voiceprint_vector_invalid")
    return tuple(value / norm for value in values)


def decode_vector(clear):
    if not isinstance(clear, bytes) or len(clear) != DIMENSION * 4:
        raise VoiceprintError("voiceprint_vector_invalid")
    vector = struct.unpack(f"<{DIMENSION}f", clear)
    if any(not math.isfinite(value) or abs(value) > 1.001 for value in vector):
        raise VoiceprintError("voiceprint_vector_invalid")
    norm = math.sqrt(math.fsum(value * value for value in vector))
    if not 0.999 <= norm <= 1.001:
        raise VoiceprintError("voiceprint_vector_invalid")
    return unit_vector(vector)


def cosine(left, right):
    left, right = unit_vector(left), unit_vector(right)
    return max(
        -1.0, min(1.0, math.fsum(a * b for a, b in zip(left, right, strict=True)))
    )


def aggregate(vectors):
    if not 3 <= len(vectors) <= 12:
        raise VoiceprintError("voiceprint_contributions_invalid")
    vectors = [unit_vector(row) for row in vectors]
    # Equal weighting per distinct clip; a longer clip never earns extra votes.
    return unit_vector(
        tuple(
            math.fsum(row[i] for row in vectors) / len(vectors)
            for i in range(DIMENSION)
        )
    )


def sample_prefix(sample):
    """Authenticate the feature's exact source and quality-worker metadata.

    Confirmation status/time are deliberately excluded: an owner decision does
    not change an encoder's source or promote its signal-only quality result.
    """
    receipt = {}
    if sample.source_type == "call":
        from core.services.voiceprint_sampling import (  # noqa: PLC0415 -- Call provenance is independently owned.
            receipt_evidence,
        )

        receipt = receipt_evidence(sample)
        if receipt is None:
            raise VoiceprintError("voiceprint_vector_invalid")
    try:
        header = json.dumps(
            {
                "id": str(sample.pk),
                "profile": str(sample.profile_id),
                "generation": sample.generation,
                "space": sample.profile.feature_space,
                "consent_version": sample.consent_version,
                "audio": sample.audio_sha256,
                "permit": str(sample.permit_id),
                "source_type": sample.source_type,
                "record": str(sample.source_record_id),
                "session": str(sample.source_session_id),
                "track": sample.source_track,
                "start_ms": sample.start_ms,
                "end_ms": sample.end_ms,
                "enrollment": str(sample.enrollment_id),
                "slot": sample.enrollment_slot,
                "quality": sample.quality,
                **({"call_receipt": receipt} if receipt else {}),
            },
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("ascii")
    except (ValueError, TypeError):
        raise VoiceprintError("voiceprint_vector_invalid") from None
    if len(header) > 4096:
        raise VoiceprintError("voiceprint_vector_invalid")
    version = b"VPS2" if receipt else b"VPS1"
    return version + len(header).to_bytes(2, "little") + header


def sample_payload(sample, vector):
    return sample_prefix(sample) + struct.pack(f"<{DIMENSION}f", *unit_vector(vector))


def read_sample_vector(sample, clear):
    prefix = sample_prefix(sample)
    if not isinstance(clear, bytes) or not clear.startswith(prefix):
        raise VoiceprintError("voiceprint_vector_invalid")
    return decode_vector(clear[len(prefix) :])
