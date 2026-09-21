"""Review tool validates labels, never supplies human judgments or promotion."""

import copy
import json
import sys

import pytest

from core.tests.evaluations import review_meeting_qa as review


def completed_fixture():
    # Deliberately mechanical test labels, never exported as real review data.
    packet = review.build_packet()
    packet.update(reviewer="unit-test-only", reviewed_at="2026-09-21")
    for case in packet["cases"]:
        candidate = case["candidates"][0]
        case["review"] = {
            "decision": "answer",
            "evidence": [{"candidate_id": candidate["id"], "quote": candidate["text"]}],
            "clarification": None,
            "rationale": "Synthetic parser fixture, not a semantic judgment",
        }
    return packet


def test_pending_packet_never_ready():
    packet = review.build_packet()
    result = review.validate(packet)
    assert result["pending"] == [f"R{i:02d}" for i in range(1, 9)]
    assert not result["ready_for_scoring"]
    assert not result["human_identity_independently_verified"]
    assert not result["production_promotion_approved"]
    assert packet == review.build_packet()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda p: p.update(source_sha256="changed"),
        lambda p: p.update(schema_version=True),
        lambda p: p["policy"].update(multiple_projects_without_target="guess"),
        lambda p: p["cases"][0].update(question="changed"),
        lambda p: p["cases"][0]["candidates"][0].update(text="changed"),
        lambda p: p["cases"].pop(),
        lambda p: p["cases"].reverse(),
    ],
)
def test_frozen_source_cannot_be_relabelled_by_editing_input(mutation):
    packet = copy.deepcopy(review.build_packet())
    mutation(packet)
    with pytest.raises(ValueError):
        review.validate(packet)


@pytest.mark.parametrize(
    "annotation",
    [
        {
            "decision": "answer",
            "evidence": [],
            "clarification": None,
            "rationale": "test",
        },
        {
            "decision": "answer",
            "evidence": [{"candidate_id": "Z", "quote": "invented"}],
            "clarification": None,
            "rationale": "test",
        },
        {
            "decision": "answer",
            "evidence": [{"candidate_id": "A", "quote": "invented"}],
            "clarification": None,
            "rationale": "test",
        },
        {
            "decision": "clarify",
            "evidence": [],
            "clarification": None,
            "rationale": "test",
        },
        {
            "decision": "clarify",
            "evidence": [],
            "clarification": "Which project?",
            "rationale": "",
        },
        {
            "decision": "no_evidence",
            "evidence": [],
            "clarification": "Which project?",
            "rationale": "test",
        },
    ],
)
def test_invalid_labels_rejected(annotation):
    packet = review.build_packet()
    packet["cases"][0]["review"] = annotation
    with pytest.raises(ValueError):
        review.validate(packet)


def test_completed_structure_does_not_claim_human_authentication_or_release():
    result = review.validate(completed_fixture())
    assert result["ready_for_scoring"]
    assert not result["human_identity_independently_verified"]
    assert not result["production_promotion_approved"]


@pytest.mark.parametrize(
    "update", [{"reviewer": " "}, {"reviewed_at": "not-a-date"}, {"reviewed_at": 123}]
)
def test_invalid_review_metadata(update):
    packet = completed_fixture()
    packet.update(update)
    with pytest.raises(ValueError):
        review.validate(packet)


def test_generated_packet_does_not_mutate_canonical_policy():
    packet = review.build_packet()
    packet["policy"]["multiple_projects_without_target"] = "guess"
    with pytest.raises(ValueError):
        review.validate(packet)


def test_needs_context_is_still_blocked():
    packet = completed_fixture()
    packet["cases"][0]["review"] = {
        "decision": "needs_context",
        "evidence": [],
        "clarification": None,
        "rationale": "Need the user's actual context",
    }
    result = review.validate(packet)
    assert result["needs_context"] == ["R01"] and not result["ready_for_scoring"]


def test_clarification_has_no_selected_answer():
    packet = completed_fixture()
    packet["cases"][0]["review"] = {
        "decision": "clarify",
        "evidence": [],
        "clarification": "Which project?",
        "rationale": "Multiple targets",
    }
    assert review.validate(packet)["ready_for_scoring"]


def test_packet_omits_gold_predictions_and_source_case_labels():
    packet = review.build_packet()
    assert all(
        set(c) == {"id", "question", "candidates", "review"} for c in packet["cases"]
    )
    assert all(set(c["review"]) == set(review.EMPTY_REVIEW) for c in packet["cases"])
    assert all(
        set(v) == {"id", "title", "text"}
        for c in packet["cases"]
        for v in c["candidates"]
    )


def test_create_and_pending_exit_without_overwrite(tmp_path, monkeypatch):
    output = tmp_path / "review.json"
    monkeypatch.setattr(sys, "argv", ["review", "--create", str(output)])
    assert review.main() == 0
    before = output.read_bytes()
    with pytest.raises(FileExistsError):
        review.main()
    assert output.read_bytes() == before
    assert output.with_suffix(".md").read_text(encoding="utf-8") == review.render(
        json.loads(before)
    )
    monkeypatch.setattr(sys, "argv", ["review", "--review", str(output)])
    assert review.main() == 2
