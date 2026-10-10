"""One published diarized speaker's private, bounded multi-clip query input."""

import time
from dataclasses import dataclass, field
from uuid import UUID

from core.services import voiceprint_matching as matching
from core.services import voiceprint_media as media
from core.services import voiceprint_query as query
from core.services import voiceprint_source_intervals as intervals
from core.services import voiceprint_source_storage as storage
from core.services import voiceprint_sources as sources
from core.services.capture_diarization_objects import configuration_digest
from core.services.voiceprint_consent import VoiceprintError


@dataclass(frozen=True)
class ProducedQuery:
    status: str
    reason: str
    source_digest: str
    clips: tuple = field(default=(), repr=False)
    media_sha256: str = field(default="", repr=False)
    speaker_id: UUID | None = field(default=None, repr=False)


def check_storage(source, config):
    config.validate()
    if (
        source.storage_kind == "capture"
        and configuration_digest(config) != source.storage_digest
    ):
        raise VoiceprintError("voiceprint_source_storage_changed", status=409)


def produce(  # noqa: PLR0913 -- Explicit trusted source, providers, policy and one current job lease.
    source,
    speaker_id,
    *,
    policy,
    media_config,
    storage_config,
    encoder_config,
    quality_config,
    job_id,
    expires,
    authorized,
):
    """No sample/template or identity writes; job publication revalidates again.

    The caller's authorization must bind its current job lease, candidate
    consent epochs and calibration policy. Source checks here supplement that
    callback; they cannot substitute for candidate checks or atomic publication.
    """
    if (
        not isinstance(source, sources.SourceSnapshot)
        or not isinstance(speaker_id, UUID)
        or not isinstance(job_id, UUID)
        or type(expires) is not int
        or expires <= time.time()
        or speaker_id not in {row.speaker_id for row in source.intervals}
    ):
        raise VoiceprintError("voiceprint_query_invalid", status=400)
    policy.validate()
    if not policy.calibrated:
        return ProducedQuery(
            "unavailable",
            "calibration_required",
            source.fingerprint,
            speaker_id=speaker_id,
        )
    media_config.validate()
    check_storage(source, storage_config)
    encoder_config.client()
    quality_config.validate()
    if source.expires_at is not None:
        expires = min(expires, int(source.expires_at.timestamp()))

    def live():
        return time.time() < expires and authorized() and sources.authorized(source)

    if not live() or not sources.revalidate(source):
        raise VoiceprintError("voiceprint_source_changed", status=409)
    with storage.download(
        source.receipt, config=storage_config, expires=expires, authorized=live
    ) as local:
        if source.media_sha256 and local.sha256 != source.media_sha256:
            raise VoiceprintError("voiceprint_source_integrity_unavailable")
        info = media.probe(
            local.media, config=media_config, expires=expires, authorized=live
        )
        if info.channels != 1:
            return ProducedQuery(
                "unavailable",
                "source_channels_unsupported",
                source.fingerprint,
                speaker_id=speaker_id,
            )
        selected = intervals.select(
            source.intervals,
            duration_ms=info.duration_ms,
            minimum=policy.min_query_clips,
        ).get(speaker_id, ())
        if len(selected) < policy.min_query_clips:
            return ProducedQuery(
                "insufficient_audio",
                "clean_intervals_required",
                source.fingerprint,
                speaker_id=speaker_id,
            )
        clips = []
        for interval in selected:
            audio = media.decode(
                local.media,
                info,
                config=media_config,
                start_ms=interval.start_ms,
                end_ms=interval.end_ms,
                expires=expires,
                authorized=live,
            )
            result = query.extract_clip(
                audio.wav,
                start_ms=audio.start_ms,
                end_ms=audio.end_ms,
                encoder_config=encoder_config,
                quality_config=quality_config,
                job_id=job_id,
                expires=expires,
                authorized=live,
            )
            if result.status == "mixed_speaker":
                return ProducedQuery(
                    "mixed_speaker",
                    result.reason,
                    source.fingerprint,
                    speaker_id=speaker_id,
                )
            if result.status == "ready":
                clips.append(result.clip)
        matching.validate_clips(clips)
        rejection = matching.query_rejection(clips, policy)
        if not live() or not sources.revalidate(source):
            raise VoiceprintError("voiceprint_source_changed", status=409)
        if rejection:
            return ProducedQuery(*rejection, source.fingerprint, speaker_id=speaker_id)
        return ProducedQuery(
            "ready",
            "quality_passed",
            source.fingerprint,
            tuple(clips),
            local.sha256,
            speaker_id,
        )
