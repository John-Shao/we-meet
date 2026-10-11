"""Private Qwen query features and quality, separate from enrollment samples."""

import hashlib
import time
from dataclasses import dataclass, field
from uuid import UUID

from core.services import voiceprint_quality as quality
from core.services import voiceprint_quality_process as quality_process
from core.services import voiceprint_rpc_process as encoder_process
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_encoder import (
    FEATURE_SPACE,
    EncoderError,
    EncoderResult,
    decode_result,
)
from core.services.voiceprint_matching import QueryClip


@dataclass(frozen=True)
class QueryOutcome:
    status: str
    reason: str
    clip: QueryClip | None = field(default=None, repr=False)


def extract_clip(  # noqa: PLR0913 -- Fixed source interval and two private providers share one live lease.
    wav,
    *,
    start_ms,
    end_ms,
    encoder_config,
    quality_config,
    job_id,
    expires,
    authorized,
):
    """Internal producer only; the callback must bind media/source/job access.

    No database writes, query caching, registration decisions or template updates.
    Both providers are cancellable and use the same original audio digest/lease.
    """
    duration = quality.audio_duration(wav)
    if (
        type(start_ms) is not int
        or type(end_ms) is not int
        or not 0 <= start_ms < end_ms <= 7200000
        or end_ms - start_ms != duration
        or not isinstance(job_id, UUID)
        or type(expires) is not int
        or expires <= time.time()
    ):
        raise VoiceprintError("voiceprint_query_invalid", status=400)
    if not authorized():
        raise VoiceprintError("voiceprint_query_authorization_revoked")
    quality_config.validate()
    # Cheap signal rejection precedes the billed ASR call. The encoder cannot
    # certify speech or speaker count, and its feature is not persisted here.
    encoded = encoder_process.extract(
        wav,
        config=encoder_config,
        job_id=job_id,
        lease_expires_at=expires,
        authorized=authorized,
    )
    if not isinstance(encoded, EncoderResult) or encoded.feature_space != FEATURE_SPACE:
        raise EncoderError("encoder_response_invalid")
    digest = hashlib.sha256(wav).hexdigest()
    encoded = decode_result(encoder_process.result_payload(encoded), digest)
    if encoded.quality["duration_ms"] != duration:
        raise VoiceprintError("voiceprint_query_invalid", status=400)
    if not authorized() or time.time() >= expires:
        raise VoiceprintError("voiceprint_query_authorization_revoked")
    evidence = quality.decode_query_result(
        quality_process.extract_query(
            wav,
            config=quality_config,
            expires=expires,
            authorized=authorized,
        ),
        digest=digest,
        duration=duration,
    )
    if not authorized() or time.time() >= expires:
        raise VoiceprintError("voiceprint_query_authorization_revoked")
    if not evidence["passed"]:
        return QueryOutcome(evidence["reason"], evidence["reason"])
    return QueryOutcome(
        "ready",
        "quality_passed",
        QueryClip(
            start_ms=start_ms,
            end_ms=end_ms,
            valid_speech_ms=evidence["valid_speech_ms"],
            audio_sha256=evidence["input_sha256"],
            vector=encoded.vector,
            speech_checked=True,
            speaker_consistency_checked=True,
            speaker_count=1,
        ),
    )
