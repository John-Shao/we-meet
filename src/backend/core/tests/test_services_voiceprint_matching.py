"""Synthetic geometry proves refusal behavior, not real identity accuracy."""

import json
import math
from dataclasses import asdict, replace
from uuid import UUID

import pytest

from core.services import voiceprint_matching as service
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_encoder import FEATURE_SPACE

A, B = UUID(int=1), UUID(int=2)


def vector(angle=0):
    return (math.cos(angle), math.sin(angle), *([0.0] * 1022))


def policy(**changes):
    return service.ThresholdPolicy(
        **{
            "threshold_version": "synthetic-test-only-v1",
            "feature_space": FEATURE_SPACE,
            "score_policy": service.SCORE_POLICY,
            "accept": 0.85,
            "margin": 0.05,
            "min_pair_cosine": 0.85,
            "min_query_clips": 3,
            "min_query_speech_ms": 9000,
            "max_candidates": 50,
            "max_device_groups": 5,
            "calibration_sha256": "a" * 64,
            "calibrated": True,
            **changes,
        }
    )


def clips(*angles):
    return tuple(
        service.QueryClip(
            start_ms=index * 10000,
            end_ms=index * 10000 + 3000,
            valid_speech_ms=3000,
            audio_sha256=f"{index + 1:064x}",
            vector=vector(angle),
            speech_checked=True,
            speaker_consistency_checked=True,
            speaker_count=1,
        )
        for index, angle in enumerate(angles or (0, 0, 0))
    )


def candidates(*angles):
    return tuple(
        service.Candidate(UUID(int=index + 1), (vector(angle),))
        for index, angle in enumerate(angles or (0, math.pi / 2))
    )


def run(query=None, pool=None, **parameters):
    return service.match(
        clips() if query is None else query,
        candidates() if pool is None else pool,
        policy=policy(**parameters),
    )


def test_consistent_suggestion_is_private_and_never_a_probability():
    result = run()
    assert result.status == "suggested" and result.user_id == A
    assert result.score == pytest.approx(1) and result.margin == pytest.approx(1)
    assert result.clip_count == 3 and result.valid_speech_ms == 9000
    assert str(A) not in repr(result) and "score=" not in repr(result)
    assert "vector=" not in repr(clips()[0])
    assert "templates=" not in repr(candidates()[0])


def test_one_candidate_must_pass_absolute_acceptance_without_inventing_a_margin():
    assert run(pool=candidates(0)).status == "suggested"
    assert run(pool=candidates(0)).margin is None
    result = run(pool=candidates(math.pi / 2))
    assert result.status == "unknown" and result.user_id is None


def test_unregistered_visitor_is_unknown_even_in_a_large_pool():
    pool = tuple(
        service.Candidate(UUID(int=index + 1), (vector(math.pi / 2),))
        for index in range(50)
    )
    result = run(pool=pool)
    assert result.status == "unknown" and result.score is None


def test_an_unavailable_library_is_distinct_from_an_unknown_voice():
    assert run(pool=()).status == "unavailable"
    assert run(pool=()).reason == "no_authorized_templates"


def test_ties_and_close_candidates_are_ambiguous_independent_of_input_order():
    pool = candidates(0, 0.1)
    for order in (pool, pool[::-1], candidates(0, 0)):
        result = run(pool=order)
        assert result.status == "ambiguous" and result.user_id is None


def test_a_low_confidence_clip_cannot_be_hidden_by_the_group_average():
    result = run(query=clips(0, 0, 0.55))
    assert result.status == "suggested"
    result = run(query=clips(0, 0, 0.58), min_pair_cosine=0.80)
    assert result.status == "unknown"  # Aggregate score would exceed acceptance.


def test_a_low_margin_clip_cannot_be_hidden_by_the_majority():
    result = run(query=clips(0, 0, 0.22), pool=candidates(0, 0.45), min_pair_cosine=0.9)
    assert result.status == "ambiguous" and result.user_id is None


def test_different_confident_clip_identities_are_mixed_not_a_majority_vote():
    result = run(
        query=clips(-0.15, -0.15, 0.15),
        pool=candidates(-0.3, 0.3),
        min_pair_cosine=0.95,
        accept=0.95,
        margin=0.05,
    )
    assert (
        result.status == "mixed_speaker" and result.reason == "conflicting_identities"
    )
    assert result.user_id is None and result.score is None


def test_all_query_pairs_must_agree_before_candidate_scores_are_considered():
    result = run(query=clips(0, 0, math.pi / 2), pool=candidates(0))
    assert result.status == "mixed_speaker" and result.reason == "query_inconsistent"


def test_a_provider_mixed_clip_is_never_silently_dropped():
    query = list(clips())
    query[-1] = replace(query[-1], speaker_count=2, speaker_consistency_checked=False)
    assert run(query=query).status == "mixed_speaker"


@pytest.mark.parametrize("field", ["speech_checked", "speaker_consistency_checked"])
def test_signal_only_or_unchecked_quality_cannot_match(field):
    query = list(clips())
    query[-1] = replace(query[-1], **{field: False})
    assert run(query=query).status == "unavailable"


@pytest.mark.parametrize("query", [(), clips(0), clips(0, 0)])
def test_insufficient_independent_speech_never_suggests(query):
    assert run(query=query).status == "insufficient_audio"


def test_total_and_per_clip_speech_requirements_are_both_enforced():
    assert run(min_query_speech_ms=9001).status == "insufficient_audio"
    query = list(clips())
    query[-1] = replace(query[-1], valid_speech_ms=2999)
    assert run(query=query).status == "insufficient_audio"


@pytest.mark.parametrize("damage", ["duplicate_audio", "same_interval", "overlap"])
def test_repeated_or_overlapping_clips_do_not_multiply_identity_evidence(damage):
    query = list(clips())
    changes = {
        "duplicate_audio": {"audio_sha256": query[0].audio_sha256},
        "same_interval": {"start_ms": 0, "end_ms": 3000},
        "overlap": {"start_ms": 2999, "end_ms": 5999},
    }
    query[-1] = replace(query[-1], **changes[damage])
    assert run(query=query).reason == "independent_clips_required"


def test_multiple_diarized_labels_can_independently_match_the_same_account():
    assert run(query=clips(0, 0, 0)).user_id == A
    assert run(query=clips(0.1, 0.1, 0.1)).user_id == A


def test_device_groups_use_the_frozen_mean_instead_of_best_of_many():
    pool = (
        service.Candidate(A, (vector(0), vector(math.pi / 2))),
        service.Candidate(B, (vector(math.pi / 4),)),
    )
    result = run(pool=pool, accept=0.65, margin=0.1)
    assert result.user_id == B and result.score == pytest.approx(math.sqrt(0.5))


@pytest.mark.parametrize(
    "changes",
    [
        {"vector": [0.0] * 1024},
        {"vector": [math.nan] * 1024},
        {"vector": [math.inf] * 1024},
        {"vector": [1e100] * 1024},
        {"vector": [True] * 1024},
        {"vector": vector()[:-1]},
        {"feature_space": "other-model"},
        {"start_ms": True},
        {"valid_speech_ms": True},
        {"valid_speech_ms": 3001},
        {"end_ms": 7200001},
        {"speech_checked": 1},
        {"speaker_count": True},
        {"audio_sha256": "private-url"},
    ],
)
def test_bad_query_contracts_fail_with_fixed_errors(changes):
    query = list(clips())
    query[-1] = replace(query[-1], **changes)
    with pytest.raises(VoiceprintError, match="voiceprint_(query|vector)_invalid"):
        run(query=query)


@pytest.mark.parametrize(
    "pool",
    [
        candidates(0) * 2,
        candidates(*([0] * 51)),
        (service.Candidate(A, ()),),
        (service.Candidate(A, (vector(),) * 6),),
        (service.Candidate("untrusted-user", (vector(),)),),
        (service.Candidate(A, (vector(),), "wrong-model"),),
    ],
)
def test_candidate_bounds_and_identity_types_cannot_be_bypassed(pool):
    with pytest.raises(VoiceprintError, match="voiceprint_candidates_invalid"):
        run(pool=pool)


def test_calibration_envelope_limits_pool_and_device_group_sizes():
    with pytest.raises(VoiceprintError, match="voiceprint_candidates_invalid"):
        run(max_candidates=1)
    with pytest.raises(VoiceprintError, match="voiceprint_candidates_invalid"):
        run(pool=(service.Candidate(A, (vector(),) * 2),), max_device_groups=1)
    with pytest.raises(VoiceprintError, match="voiceprint_query_invalid"):
        run(query=clips(*([0] * 13)))


@pytest.mark.parametrize(
    "changes",
    [
        {"accept": 0},
        {"margin": 0},
        {"min_pair_cosine": 0},
        {"accept": math.nan},
        {"accept": 10**400},
        {"accept": True},
        {"threshold_version": "private query\n"},
        {"feature_space": "other-model"},
        {"score_policy": "highest-of-many"},
        {"calibration_sha256": "not-reviewed"},
        {"calibrated": 1},
        {"min_query_clips": 2},
        {"min_query_clips": True},
        {"min_query_speech_ms": 8999},
        {"min_query_speech_ms": 120001},
        {"max_candidates": 51},
        {"max_device_groups": 6},
    ],
)
def test_no_unversioned_default_or_invalid_threshold_can_be_used(changes):
    with pytest.raises(VoiceprintError, match="voiceprint_threshold_policy_invalid"):
        run(**changes)


def test_uncalibrated_policy_cannot_even_score_synthetic_perfect_vectors():
    result = run(calibrated=False)
    assert result.status == "unavailable" and result.reason == "calibration_required"
    assert result.user_id is None and result.score is None


def test_reviewed_file_is_exact_bounded_and_its_digest_tracks_actual_parameters(
    tmp_path,
):
    path = tmp_path / "synthetic-policy.json"
    path.write_text(json.dumps(asdict(policy())))
    actual = service.load_policy(path)
    assert actual == policy() and len(actual.digest) == 64
    assert replace(actual, margin=0.06).digest != actual.digest
    assert replace(actual, calibration_sha256="b" * 64).digest != actual.digest
    for body in (
        {**asdict(policy()), "secret_extra": "private"},
        {**asdict(policy()), "calibrated": False},
        {"accept": 0.85},
        [],
    ):
        path.write_text(json.dumps(body))
        with pytest.raises(
            VoiceprintError, match="voiceprint_threshold_policy_unavailable"
        ):
            service.load_policy(path)
    path.write_bytes(b" " * 8193)
    with pytest.raises(
        VoiceprintError, match="voiceprint_threshold_policy_unavailable"
    ):
        service.load_policy(path)
    with pytest.raises(
        VoiceprintError, match="voiceprint_threshold_policy_unavailable"
    ):
        service.load_policy(tmp_path / "missing")


def test_duplicate_policy_keys_cannot_hide_the_effective_threshold(tmp_path):
    path = tmp_path / "ambiguous-policy.json"
    value = json.dumps(asdict(policy())).replace(
        '"accept": 0.85', '"accept": 0.80, "accept": 0.85'
    )
    path.write_text(value)
    with pytest.raises(
        VoiceprintError, match="voiceprint_threshold_policy_unavailable"
    ):
        service.load_policy(path)
