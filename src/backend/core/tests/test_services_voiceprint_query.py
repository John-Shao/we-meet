"""Query quality contracts and real local ASR child; no human/paid cloud data."""

import hashlib
import time
from dataclasses import replace
from uuid import uuid4

import pytest

from core.services import voiceprint_quality as quality
from core.services import voiceprint_quality_process as process
from core.services import voiceprint_query as service
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_encoder import EncoderError, EncoderResult
from core.tests.services.test_voiceprint_enrollment import wav
from core.tests.test_services_voiceprint_matching import vector
from core.tests.test_services_voiceprint_quality import output, prompt_for
from core.tests.test_services_voiceprint_quality_process import children, short_asr

TEXT = (
    "This meeting discusses a synthetic test plan with no random enrollment challenge."
)


def evidence(body=None, duration=3000):
    result = quality.interpret_query(
        output(TEXT) if body is None else body, duration=duration
    )
    result["input_sha256"] = hashlib.sha256(wav()).hexdigest()
    return result


def test_query_uses_real_speech_evidence_without_a_registration_answer():
    result = evidence()
    assert result["passed"] and result["policy"] == quality.QUERY_POLICY_VERSION
    assert set(result) == {
        "policy",
        "model_id",
        "input_sha256",
        "passed",
        "reason",
        "valid_speech_ms",
        "speaker_count",
    }
    assert "text" not in result and TEXT not in repr(result)
    assert (
        quality.interpret(
            output(TEXT), duration=3000, locale="en", prompt=prompt_for()
        )["reason"]
        == "prompt_mismatch"
    )


def test_query_evidence_cannot_be_used_to_confirm_an_enrollment():
    with pytest.raises(quality.QualityError, match="quality_response_invalid"):
        quality.decode_result(
            evidence(),
            digest=hashlib.sha256(wav()).hexdigest(),
            prompt_digest="a" * 64,
            duration=3000,
        )


def test_enrollment_evidence_cannot_be_used_as_a_query_quality_result():
    result = quality.interpret(
        output(), duration=3000, locale="en", prompt=prompt_for()
    )
    result["input_sha256"] = hashlib.sha256(wav()).hexdigest()
    with pytest.raises(quality.QualityError, match="quality_response_invalid"):
        quality.decode_query_result(
            result, digest=result["input_sha256"], duration=3000
        )


@pytest.mark.parametrize(
    "damage",
    ["null_speaker", "no_words", "unfinished", "bad_word_time", "boolean_speaker"],
)
def test_query_missing_provider_evidence_is_not_promoted_to_passed(damage):
    body = output(TEXT)
    sentence = body["output"]["sentences"][0]
    changes = {
        "null_speaker": lambda: sentence.update(speaker_id=None),
        "no_words": lambda: sentence.update(words=[]),
        "unfinished": lambda: sentence.update(sentence_end=False),
        "bad_word_time": lambda: sentence["words"][0].update(end_time=3001),
        "boolean_speaker": lambda: sentence["words"][0].update(speaker_id=True),
    }
    changes[damage]()
    with pytest.raises(quality.QualityError, match="quality_response_invalid"):
        evidence(body)


def test_query_short_speech_and_mixed_speakers_are_definite_refusals():
    assert evidence(output(TEXT, duration=2000))["reason"] == "insufficient_audio"
    body = output(TEXT)
    body["output"]["sentences"][0]["words"][-1]["speaker_id"] = 1
    assert evidence(body)["reason"] == "mixed_speaker"
    assert not evidence(body)["passed"]


def test_punctuation_cannot_inflate_query_speech_time():
    body = output(TEXT, duration=2000)
    sentence = body["output"]["sentences"][0]
    sentence["end_time"] = 3000
    sentence["words"].append({"text": ".", "begin_time": 0, "end_time": 3000})
    assert evidence(body)["valid_speech_ms"] == 2000


@pytest.mark.parametrize(
    "changes",
    [
        {"policy": quality.POLICY_VERSION},
        {"input_sha256": "a" * 64},
        {"model_id": "other-model"},
        {"speaker_count": True},
        {"reason": "prompt_mismatch"},
        {"prompt_sha256": "a" * 64},
    ],
)
def test_query_parent_strictly_binds_policy_audio_and_bounded_fields(changes):
    result = {**evidence(), **changes}
    with pytest.raises(quality.QualityError, match="quality_response_invalid"):
        quality.decode_query_result(
            result, digest=hashlib.sha256(wav()).hexdigest(), duration=3000
        )


def test_real_query_subprocess_sends_no_enrollment_context_and_returns_no_text(
    short_asr, children
):
    short_asr.prompt = TEXT
    result = process.extract_query(
        wav(),
        config=short_asr.config,
        expires=int(time.time()) + 30,
        authorized=lambda: True,
    )
    assert result["passed"] and result["policy"] == quality.QUERY_POLICY_VERSION
    assert short_asr.requests == 1 and all(child.poll() == 0 for child in children)
    assert "prompt_sha256" not in result and TEXT not in repr(result)


def test_query_revocation_before_call_starts_no_process_or_request(short_asr, children):
    with pytest.raises(quality.QualityError, match="quality_authorization_revoked"):
        process.extract_query(
            wav(),
            config=short_asr.config,
            expires=int(time.time()) + 30,
            authorized=lambda: False,
        )
    assert not children and short_asr.requests == 0


def test_query_revocation_during_call_reaps_the_actual_child(short_asr, children):
    short_asr.mode = "slow-headers"
    started = time.monotonic()
    with pytest.raises(quality.QualityError, match="quality_authorization_revoked"):
        process.extract_query(
            wav(),
            config=short_asr.config,
            expires=int(time.time()) + 30,
            authorized=lambda: time.monotonic() - started < 0.75,
        )
    assert all(child.poll() is not None for child in children)


@pytest.mark.parametrize("purpose", ["enrollment", True, "other"])
def test_query_dispatch_has_no_generic_mode_or_prompt_override(purpose):
    with pytest.raises(ValueError):
        process.dispatch({"wav": "", "config": {}, "expires": 1, "purpose": purpose})
    with pytest.raises(ValueError):
        process.dispatch(
            {
                "wav": "",
                "config": {},
                "expires": 1,
                "purpose": "query",
                "prompt": prompt_for(),
            }
        )


@pytest.fixture
def providers(monkeypatch):
    calls = []
    encoded = EncoderResult(
        vector(),
        {
            "duration_ms": 3000,
            "rms_dbfs": -20,
            "ac_rms_dbfs": -20,
            "clipped_fraction": 0,
            "validation": "signal-only-v1",
            "speech_checked": False,
            "speaker_consistency_checked": False,
        },
        hashlib.sha256(wav()).hexdigest(),
    )

    def encode(_wav, **_kwargs):
        calls.append("encoder")
        return encoded

    def check(_wav, **_kwargs):
        calls.append("quality")
        return evidence()

    monkeypatch.setattr(service.encoder_process, "extract", encode)
    monkeypatch.setattr(service.quality_process, "extract_query", check)
    return calls, encoded


def query_clip(**changes):
    return service.extract_clip(
        wav(),
        **{
            "start_ms": 10000,
            "end_ms": 13000,
            "encoder_config": None,
            "quality_config": quality.QualityConfiguration(
                "http://127.0.0.1" + quality.API_PATH, b"synthetic-key-0123456789"
            ),
            "job_id": uuid4(),
            "expires": int(time.time()) + 30,
            "authorized": lambda: True,
            **changes,
        },
    )


def test_query_pipeline_has_bound_features_and_no_registration_side_effects(providers):
    calls, _encoded = providers
    outcome = query_clip()
    assert calls == ["encoder", "quality"] and outcome.status == "ready"
    assert outcome.clip.start_ms == 10000 and outcome.clip.end_ms == 13000
    assert outcome.clip.audio_sha256 == hashlib.sha256(wav()).hexdigest()
    assert outcome.clip.vector == vector() and outcome.clip.speech_checked
    assert "clip=" not in repr(outcome)


@pytest.mark.parametrize(
    "changes",
    [
        {"start_ms": True},
        {"end_ms": 12999},
        {"start_ms": -1},
        {"job_id": "untrusted"},
        {"expires": True},
        {"expires": 0},
    ],
)
def test_query_pipeline_rejects_source_contract_before_any_provider(providers, changes):
    with pytest.raises(VoiceprintError, match="voiceprint_query_invalid"):
        query_clip(**changes)
    assert not providers[0]


@pytest.mark.parametrize("purpose", ["enrollment", "query"])
def test_expiry_during_evidence_interpretation_never_returns_a_pass(
    short_asr, monkeypatch, purpose
):
    expires = int(time.time()) + 10
    name = "interpret" if purpose == "enrollment" else "interpret_query"
    original = getattr(quality, name)

    def late(*args, **kwargs):
        result = original(*args, **kwargs)
        monkeypatch.setattr(quality.time, "time", lambda: expires + 1)
        return result

    monkeypatch.setattr(quality, name, late)
    with pytest.raises(quality.QualityError, match="quality_deadline_exceeded"):
        if purpose == "query":
            quality.check_query(wav(), config=short_asr.config, expires=expires)
        else:
            quality.check(
                wav(),
                config=short_asr.config,
                locale="en",
                prompt=short_asr.prompt,
                expires=expires,
            )


def test_signal_failure_precedes_paid_quality_call(providers, monkeypatch):
    def reject(*_args, **_kwargs):
        raise EncoderError("audio_signal_invalid")

    monkeypatch.setattr(service.encoder_process, "extract", reject)
    with pytest.raises(EncoderError):
        query_clip()
    assert not providers[0]


def test_mismatched_encoder_audio_never_reaches_quality(providers, monkeypatch):
    monkeypatch.setattr(
        service.encoder_process,
        "extract",
        lambda *_args, **_kwargs: replace(providers[1], input_sha256="b" * 64),
    )
    with pytest.raises(EncoderError, match="encoder_response_invalid"):
        query_clip()
    assert not providers[0]


@pytest.mark.parametrize("reason", ["mixed_speaker", "insufficient_audio"])
def test_rejected_query_never_provides_a_feature_to_match(
    providers, monkeypatch, reason
):
    result = evidence(output(TEXT, duration=2000))
    if reason == "mixed_speaker":
        result = {**result, "reason": reason, "speaker_count": 2}
    monkeypatch.setattr(
        service.quality_process, "extract_query", lambda *_args, **_kwargs: result
    )
    outcome = query_clip()
    assert outcome.status == reason and outcome.clip is None


def test_post_quality_revocation_never_returns_a_query_vector(providers, monkeypatch):
    revoked = False

    def check(*_args, **_kwargs):
        nonlocal revoked
        revoked = True
        return evidence()

    monkeypatch.setattr(service.quality_process, "extract_query", check)
    with pytest.raises(VoiceprintError, match="voiceprint_query_authorization_revoked"):
        query_clip(authorized=lambda: not revoked)


def test_encoder_completion_after_revocation_never_calls_paid_asr(
    providers, monkeypatch
):
    revoked = False

    def encode(*_args, **_kwargs):
        nonlocal revoked
        revoked = True
        return providers[1]

    monkeypatch.setattr(service.encoder_process, "extract", encode)
    with pytest.raises(VoiceprintError, match="voiceprint_query_authorization_revoked"):
        query_clip(authorized=lambda: not revoked)
    assert not providers[0]


@pytest.mark.parametrize(
    "changes",
    [
        {"feature_space": "foreign-model"},
        {"vector": (0.0,) * 1024},
        {"quality": {"duration_ms": 3000}},
    ],
)
def test_bad_encoder_contracts_do_not_reach_asr(providers, monkeypatch, changes):
    monkeypatch.setattr(
        service.encoder_process,
        "extract",
        lambda *_args, **_kwargs: replace(providers[1], **changes),
    )
    with pytest.raises(EncoderError, match="encoder_response_invalid"):
        query_clip()
    assert not providers[0]


@pytest.mark.parametrize(
    "changes",
    [
        {"policy": quality.POLICY_VERSION},
        {"input_sha256": "b" * 64},
        {"speaker_count": 2},
    ],
)
def test_final_query_assembly_rechecks_the_quality_contract(
    providers, monkeypatch, changes
):
    monkeypatch.setattr(
        service.quality_process,
        "extract_query",
        lambda *_args, **_kwargs: {**evidence(), **changes},
    )
    with pytest.raises(quality.QualityError, match="quality_response_invalid"):
        query_clip()


def test_bad_quality_configuration_is_detected_before_any_encoding(providers):
    with pytest.raises(quality.QualityError, match="quality_configuration_invalid"):
        query_clip(
            quality_config=quality.QualityConfiguration(
                "https://example.invalid", b"synthetic-key-0123456789"
            )
        )
    assert not providers[0]
