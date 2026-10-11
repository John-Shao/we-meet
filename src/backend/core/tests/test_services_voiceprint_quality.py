"""Synthetic short-ASR contracts and prompt checks; no accuracy claims."""

import copy
import time
from uuid import uuid4

import pytest

from core.services import voiceprint_quality as service
from core.services.voiceprint_enrollment import PROMPTS
from core.services.voiceprint_prompt import challenge_digest, prompt_matches
from core.tests.services.test_voiceprint_enrollment import wav

NUMBERS = "12 · 21 · 34 · 58 · 71 · 90"


def prompt_for(locale="en", numbers=NUMBERS):
    return PROMPTS[locale].format(numbers=numbers)


def output(prompt=None, *, duration=3000, speaker=0):
    prompt = prompt or prompt_for()
    tokens = [
        token for token in prompt.split() if any(char.isalnum() for char in token)
    ]
    words = [
        {
            "text": text,
            "speaker_id": speaker,
            "begin_time": i * duration // len(tokens),
            "end_time": (i + 1) * duration // len(tokens),
        }
        for i, text in enumerate(tokens)
    ]
    return {
        "output": {
            "sentences": [
                {
                    "sentence_id": 1,
                    "sentence_end": True,
                    "speaker_id": speaker,
                    "channel_id": 0,
                    "begin_time": 0,
                    "end_time": duration,
                    "words": words,
                    "text": prompt,
                }
            ],
            "text": prompt,
        },
        "request_id": str(uuid4()),
    }


@pytest.mark.parametrize(
    "locale,spoken",
    [
        ("en", "twelve twenty-one thirty-four fifty-eight seventy-one ninety"),
        ("zh-CN", "十二、二十一、三十四、五十八、七十一、九十"),
        (
            "fr",
            "douze vingt et un trente-quatre cinquante-huit soixante et onze quatre-vingt-dix",
        ),
        (
            "de",
            "zwölf einundzwanzig vierunddreißig achtundfünfzig einundsiebzig neunzig",
        ),
        ("nl", "twaalf eenentwintig vierendertig achtenvijftig eenenzeventig negentig"),
    ],
)
def test_multilingual_cardinals_and_numeric_transcripts_match_exact_challenge(
    locale, spoken
):
    prompt = prompt_for(locale)
    assert prompt_matches(prompt, locale=locale, prompt=prompt)
    assert prompt_matches(
        PROMPTS[locale].format(numbers=spoken), locale=locale, prompt=prompt
    )
    assert not prompt_matches(
        PROMPTS[locale].format(numbers=spoken + " 10"), locale=locale, prompt=prompt
    )


@pytest.mark.parametrize(
    "text",
    [
        NUMBERS,
        "12 21 34 58 71",
        prompt_for(numbers="12 21 34 58 71 91"),
        prompt_for(numbers="21 12 34 58 71 90"),
        prompt_for() + " 10",
        "someone said my account is 12 21 34 58 71 90",
        "",
        "x" * 4097,
    ],
)
def test_numbers_alone_wrong_digits_or_unrelated_words_are_rejected(text):
    assert not prompt_matches(text, locale="en", prompt=prompt_for())


def test_only_timed_word_text_is_used_and_no_names_are_inferred():
    body = output()
    body["output"]["text"] = (
        "An unrelated polished top-level text with a person's name."
    )
    result = service.interpret(body, duration=3000, locale="en", prompt=prompt_for())
    assert result["passed"] and result["valid_speech_ms"] == 3000
    assert "text" not in result and "name" not in result
    body["output"]["sentences"][0]["words"][0]["text"] = "unrelated-name"
    # A single small fixed wording difference is allowed, never a digit change.
    assert (
        service.interpret(body, duration=3000, locale="en", prompt=prompt_for())[
            "speaker_count"
        ]
        == 1
    )


def test_word_time_union_cannot_double_count_overlapping_audio():
    body = output()
    for word in body["output"]["sentences"][0]["words"]:
        word["begin_time"], word["end_time"] = 0, 2000
    result = service.interpret(body, duration=3000, locale="en", prompt=prompt_for())
    assert (
        result["valid_speech_ms"] == 2000 and result["reason"] == "insufficient_audio"
    )


def test_one_foreign_speaker_is_rejected_without_majority_voting():
    body = output()
    body["output"]["sentences"][0]["words"][-1]["speaker_id"] = 1
    result = service.interpret(body, duration=3000, locale="en", prompt=prompt_for())
    assert (
        result["speaker_count"] == 2
        and result["reason"] == "mixed_speaker"
        and not result["passed"]
    )


def test_empty_speech_and_wrong_prompt_have_explicit_rejections():
    assert (
        service.interpret(
            {"output": {"sentences": []}},
            duration=3000,
            locale="en",
            prompt=prompt_for(),
        )["reason"]
        == "insufficient_audio"
    )
    assert (
        service.interpret(
            output(prompt_for(numbers="12 21 34 58 71 99")),
            duration=3000,
            locale="en",
            prompt=prompt_for(),
        )["reason"]
        == "prompt_mismatch"
    )


def test_unordered_final_sentences_are_reconstructed_by_word_time():
    body = output()
    sentence = body["output"]["sentences"][0]
    middle = len(sentence["words"]) // 2
    first, second = copy.deepcopy(sentence), copy.deepcopy(sentence)
    first["words"], second["words"] = first["words"][:middle], second["words"][middle:]
    first["end_time"] = first["words"][-1]["end_time"]
    second["begin_time"], second["sentence_id"] = second["words"][0]["begin_time"], 2
    body["output"]["sentences"] = [second, first]
    assert service.interpret(body, duration=3000, locale="en", prompt=prompt_for())[
        "passed"
    ]


def test_chinese_character_word_boundaries_do_not_change_random_numbers():
    spoken = "十 二 · 二 十 一 · 三 十 四 · 五 十 八 · 七 十 一 · 九 十"
    assert prompt_matches(
        PROMPTS["zh-CN"].format(numbers=spoken),
        locale="zh-CN",
        prompt=prompt_for("zh-CN"),
    )


def test_punctuation_timestamps_cannot_turn_short_speech_into_a_qualified_clip():
    body = output(duration=2000)
    sentence = body["output"]["sentences"][0]
    sentence["end_time"] = 3000
    sentence["words"].append(
        {"text": ".", "speaker_id": 0, "begin_time": 0, "end_time": 3000}
    )
    result = service.interpret(body, duration=3000, locale="en", prompt=prompt_for())
    assert (
        result["valid_speech_ms"] == 2000 and result["reason"] == "insufficient_audio"
    )


@pytest.mark.parametrize(
    "damage",
    [
        "missing_diarization",
        "null_speaker",
        "boolean_speaker",
        "unfinished",
        "foreign_channel",
        "bad_time",
        "out_of_bounds",
        "word_outside_sentence",
        "no_words",
        "duplicate_sentence",
        "too_many_words",
        "too_long_text",
    ],
)
def test_unusable_provider_evidence_is_unavailable_instead_of_accepted(damage):
    body = output()
    sentence = body["output"]["sentences"][0]
    if damage == "missing_diarization":
        del body["output"]["sentences"]
    elif damage == "null_speaker":
        sentence["speaker_id"] = None
    elif damage == "boolean_speaker":
        sentence["words"][0]["speaker_id"] = True
    elif damage == "unfinished":
        sentence["sentence_end"] = False
    elif damage == "foreign_channel":
        sentence["channel_id"] = 1
    elif damage == "bad_time":
        sentence["words"][0]["begin_time"] = -1
    elif damage == "out_of_bounds":
        sentence["end_time"] = 3001
    elif damage == "word_outside_sentence":
        sentence["begin_time"] = 1
    elif damage == "no_words":
        sentence["words"] = []
    elif damage == "duplicate_sentence":
        body["output"]["sentences"].append(copy.deepcopy(sentence))
    elif damage == "too_many_words":
        sentence["words"] = sentence["words"] * 100
    else:
        sentence["words"][0]["text"] = "x" * 513
    with pytest.raises(service.QualityError, match="quality_response_invalid"):
        service.interpret(body, duration=3000, locale="en", prompt=prompt_for())


@pytest.mark.parametrize("text", ["." * 513, " "])
def test_malformed_punctuation_is_not_exempt_from_word_bounds(text):
    body = output()
    body["output"]["sentences"][0]["words"][0]["text"] = text
    with pytest.raises(service.QualityError, match="quality_response_invalid"):
        service.interpret(body, duration=3000, locale="en", prompt=prompt_for())


@pytest.mark.parametrize(
    "url,ca",
    [
        ("http://example.com" + service.API_PATH, True),
        ("https://example.com" + service.API_PATH, True),
        ("https://dashscope.aliyuncs.com/other", True),
        ("https://dashscope.aliyuncs.com" + service.API_PATH + "?q=secret", True),
        ("https://user:secret@dashscope.aliyuncs.com" + service.API_PATH, True),
        ("https://dashscope.aliyuncs.com:8443" + service.API_PATH, True),
        ("https://dashscope.aliyuncs.com" + service.API_PATH, False),
    ],
)
def test_operator_configuration_cannot_redirect_audio_or_disable_tls(url, ca):
    config = service.QualityConfiguration(url, b"synthetic-key-0123456789", ca)
    with pytest.raises(service.QualityError, match="quality_configuration_invalid"):
        config.validate()
    assert "synthetic-key" not in repr(config)


def test_pcm_audio_bounds_are_checked_without_decoding_other_media():
    assert service.audio_duration(wav(seconds=10)) == 10000
    for data in (
        b"x",
        wav(seconds=2),
        wav(rate=16000),
        wav(channels=2),
        wav() + b"metadata",
    ):
        with pytest.raises(service.QualityError, match="quality_input_invalid"):
            service.audio_duration(data)


@pytest.mark.parametrize(
    "field,value",
    [
        ("input_sha256", "0" * 64),
        ("prompt_sha256", "0" * 64),
        ("model_id", "unknown-model"),
        ("valid_speech_ms", True),
        ("valid_speech_ms", 3001),
        ("speaker_count", True),
        ("speaker_count", 2),
        ("reason", []),
        ("passed", 1),
        ("policy", "changed"),
    ],
)
def test_parent_revalidates_fixed_quality_contract(field, value):
    result = {
        **service.interpret(output(), duration=3000, locale="en", prompt=prompt_for()),
        "input_sha256": "a" * 64,
    }
    result[field] = value
    with pytest.raises(service.QualityError, match="quality_response_invalid"):
        service.decode_result(
            result,
            digest="a" * 64,
            prompt_digest=challenge_digest("en", prompt_for()),
            duration=3000,
        )


def test_invalid_configuration_is_private_and_expired_audio_never_leaves(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("No HTTP request is allowed for an expired request.")

    monkeypatch.setattr(service.requests, "Session", forbidden)
    with pytest.raises(service.QualityError, match="quality_lease_expired"):
        service.check(
            wav(),
            config=service.QualityConfiguration(
                "https://dashscope.aliyuncs.com" + service.API_PATH,
                b"synthetic-key-0123456789",
            ),
            locale="en",
            prompt=prompt_for(),
            expires=int(time.time()) - 1,
        )
