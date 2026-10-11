"""Bounded per-speaker matching, never attribution or a public vector API.

Policies have no default identity thresholds. Synthetic tests exercise the
algorithm, not human accuracy or the truth of an operator's calibration report.
"""

import hashlib
import json
import math
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from uuid import UUID

from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_encoder import FEATURE_SPACE
from core.services.voiceprint_vectors import cosine, unit_vector

SCORE_POLICY = "qwen-cosine-template-mean-v1"
MAX_CLIPS = 12
MAX_CANDIDATES = 50
MAX_DEVICE_GROUPS = 5
SHA256 = re.compile(r"[0-9a-f]{64}\Z")


@dataclass(frozen=True)
class ThresholdPolicy:
    threshold_version: str
    feature_space: str
    score_policy: str
    accept: float
    margin: float
    min_pair_cosine: float
    min_query_clips: int
    min_query_speech_ms: int
    max_candidates: int
    max_device_groups: int
    calibration_sha256: str
    calibrated: bool

    def validate(self):
        if (
            not isinstance(self.threshold_version, str)
            or not re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", self.threshold_version
            )
            or self.feature_space != FEATURE_SPACE
            or self.score_policy != SCORE_POLICY
            or type(self.calibrated) is not bool
            or not isinstance(self.calibration_sha256, str)
            or SHA256.fullmatch(self.calibration_sha256) is None
            or any(
                type(value) not in (int, float)
                or not 0 < value <= 1
                or not math.isfinite(value)
                for value in (self.accept, self.margin, self.min_pair_cosine)
            )
            or type(self.min_query_clips) is not int
            or not 3 <= self.min_query_clips <= MAX_CLIPS
            or type(self.min_query_speech_ms) is not int
            or not self.min_query_clips * 3000
            <= self.min_query_speech_ms
            <= MAX_CLIPS * 10000
            or type(self.max_candidates) is not int
            or not 1 <= self.max_candidates <= MAX_CANDIDATES
            or type(self.max_device_groups) is not int
            or not 1 <= self.max_device_groups <= MAX_DEVICE_GROUPS
        ):
            raise VoiceprintError("voiceprint_threshold_policy_invalid", status=400)
        return self

    @property
    def digest(self):
        return hashlib.sha256(
            json.dumps(
                asdict(self), sort_keys=True, separators=(",", ":"), allow_nan=False
            ).encode("ascii")
        ).hexdigest()


def unique_fields(items):
    values = {}
    for name, value in items:
        if name in values:
            raise ValueError("duplicate_policy_field")
        values[name] = value
    return values


def load_policy(path):
    """Only a mounted reviewed policy; no fallback to enrollment cosine gates."""
    try:
        with Path(path).open("rb") as stream:
            raw = stream.read(8193)
        if len(raw) > 8192:
            raise ValueError
        body = json.loads(raw, object_pairs_hook=unique_fields)
        if not isinstance(body, dict):
            raise ValueError
        policy = ThresholdPolicy(**body).validate()
        if not policy.calibrated:
            raise ValueError
        return policy
    except (OSError, ValueError, TypeError, RecursionError):
        raise VoiceprintError("voiceprint_threshold_policy_unavailable") from None


@dataclass(frozen=True)
class QueryClip:
    """Internal producer evidence only; query vectors are not persisted here."""

    start_ms: int
    end_ms: int
    valid_speech_ms: int
    audio_sha256: str = field(repr=False)
    vector: tuple = field(repr=False)
    feature_space: str = FEATURE_SPACE
    speech_checked: bool = False
    speaker_consistency_checked: bool = False
    speaker_count: int = 0


@dataclass(frozen=True)
class Candidate:
    user_id: UUID = field(repr=False)
    templates: tuple = field(repr=False)
    feature_space: str = FEATURE_SPACE


@dataclass(frozen=True)
class MatchResult:
    status: str
    reason: str
    clip_count: int = 0
    valid_speech_ms: int = 0
    user_id: UUID | None = field(default=None, repr=False)
    score: float | None = field(default=None, repr=False)
    margin: float | None = field(default=None, repr=False)


def validate_clips(clips):
    if not isinstance(clips, (list, tuple)) or len(clips) > MAX_CLIPS:
        raise VoiceprintError("voiceprint_query_invalid", status=400)
    for clip in clips:
        if (
            not isinstance(clip, QueryClip)
            or clip.feature_space != FEATURE_SPACE
            or type(clip.start_ms) is not int
            or type(clip.end_ms) is not int
            or not 0 <= clip.start_ms < clip.end_ms <= 7200000
            or not 3000 <= clip.end_ms - clip.start_ms <= 10000
            or type(clip.valid_speech_ms) is not int
            or not 0 <= clip.valid_speech_ms <= clip.end_ms - clip.start_ms
            or type(clip.speech_checked) is not bool
            or type(clip.speaker_consistency_checked) is not bool
            or type(clip.speaker_count) is not int
            or not 0 <= clip.speaker_count <= 50
            or not isinstance(clip.audio_sha256, str)
            or SHA256.fullmatch(clip.audio_sha256) is None
        ):
            raise VoiceprintError("voiceprint_query_invalid", status=400)
        unit_vector(clip.vector)


def validate_candidates(candidates, policy):
    if (
        not isinstance(candidates, (list, tuple))
        or len(candidates) > policy.max_candidates
    ):
        raise VoiceprintError("voiceprint_candidates_invalid", status=400)
    identifiers = set()
    for candidate in candidates:
        if (
            not isinstance(candidate, Candidate)
            or not isinstance(candidate.user_id, UUID)
            or candidate.user_id in identifiers
            or candidate.feature_space != FEATURE_SPACE
            or not isinstance(candidate.templates, (list, tuple))
            or not 1 <= len(candidate.templates) <= policy.max_device_groups
        ):
            raise VoiceprintError("voiceprint_candidates_invalid", status=400)
        identifiers.add(candidate.user_id)
        for vector in candidate.templates:
            unit_vector(vector)


def query_rejection(clips, policy):
    if any(clip.speaker_count > 1 for clip in clips):
        return "mixed_speaker", "multiple_speakers"
    if any(
        not clip.speech_checked
        or not clip.speaker_consistency_checked
        or clip.speaker_count != 1
        for clip in clips
    ):
        return "unavailable", "quality_not_verified"
    ordered = sorted(clips, key=lambda clip: (clip.start_ms, clip.end_ms))
    if len({clip.audio_sha256 for clip in clips}) != len(clips) or any(
        right.start_ms < left.end_ms
        for left, right in zip(ordered, ordered[1:], strict=False)
    ):
        return "insufficient_audio", "independent_clips_required"
    if (
        len(clips) < policy.min_query_clips
        or any(clip.valid_speech_ms < 3000 for clip in clips)
        or sum(clip.valid_speech_ms for clip in clips) < policy.min_query_speech_ms
    ):
        return "insufficient_audio", "speech_required"
    if any(
        cosine(left.vector, right.vector) < policy.min_pair_cosine
        for index, left in enumerate(clips)
        for right in clips[index + 1 :]
    ):
        return "mixed_speaker", "query_inconsistent"
    return None


def ranking(clip, candidates):
    # Equal weighting of the bounded device groups avoids a highest-of-many
    # advantage. This exact scoring policy needs independent human calibration.
    scores = [
        (
            math.fsum(cosine(clip.vector, vector) for vector in candidate.templates)
            / len(candidate.templates),
            candidate.user_id,
        )
        for candidate in candidates
    ]
    return sorted(scores, key=lambda item: (-item[0], str(item[1])))


def match(clips, candidates, *, policy):  # noqa: PLR0911 -- Each refusal must precede any identity suggestion.
    policy.validate()
    if not policy.calibrated:
        return MatchResult("unavailable", "calibration_required")
    validate_clips(clips)
    validate_candidates(candidates, policy)
    speech_ms = sum(clip.valid_speech_ms for clip in clips)
    rejection = query_rejection(clips, policy)
    if rejection:
        return MatchResult(*rejection, len(clips), speech_ms)
    if not candidates:
        return MatchResult(
            "unavailable", "no_authorized_templates", len(clips), speech_ms
        )
    rows = [ranking(clip, candidates) for clip in clips]
    # No runner-up does not waive absolute acceptance. Margin is undefined for
    # one candidate, rather than pretending its similarity is a probability.
    accepted = [
        row[0][1]
        for row in rows
        if row[0][0] >= policy.accept
        and (len(row) == 1 or row[0][0] - row[1][0] >= policy.margin)
    ]
    if len(set(accepted)) > 1:
        return MatchResult(
            "mixed_speaker", "conflicting_identities", len(clips), speech_ms
        )
    if any(row[0][0] < policy.accept for row in rows):
        return MatchResult("unknown", "below_acceptance", len(clips), speech_ms)
    if len(accepted) != len(clips):
        return MatchResult("ambiguous", "margin_required", len(clips), speech_ms)
    user_id = accepted[0]
    score = math.fsum(row[0][0] for row in rows) / len(rows)
    margin = (
        math.fsum(row[0][0] - row[1][0] for row in rows) / len(rows)
        if len(candidates) > 1
        else None
    )
    return MatchResult(
        "suggested",
        "consistent_identity",
        len(clips),
        speech_ms,
        user_id,
        score,
        margin,
    )
