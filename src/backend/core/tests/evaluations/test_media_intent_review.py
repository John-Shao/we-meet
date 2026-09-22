"""Media-derived material never supplies independent human labels by itself."""

import json
import sys

import pytest

from core.tests.evaluations import media_intent_review as review


def test_all_actual_source_segments_are_visible_and_questions_unlabelled():
    data = review.source()
    segments = [s for r in data["sources"] for s in r["segments"]]
    assert len(segments) == len({s["id"] for s in segments}) == 26
    assert all(r["complete_pagination"] for r in data["sources"])
    assert all(s["text"] in review.render() for s in segments)
    result = review.validate(review.build_packet())
    assert result["pending"] == [f"M{i:02}" for i in range(1, 6)]
    assert not result["ready_for_calibration"]
    assert not result["real_user_query_log"]
    assert not result["independent_holdout"]


@pytest.mark.parametrize("mutation", ["source", "question", "missing", "quote"])
def test_source_question_and_evidence_integrity(mutation):
    packet = review.build_packet()
    if mutation == "source":
        packet["source_sha256"] = "changed"
    elif mutation == "question":
        packet["cases"][0]["question"] = "different question"
    elif mutation == "missing":
        packet["cases"].pop()
    else:
        packet["cases"][0]["review"] = {
            "decision": "answer",
            "rationale": "fixture",
            "clarification": None,
            "evidence": [{"candidate_id": "A01", "quote": "invented evidence"}],
        }
    with pytest.raises(ValueError):
        review.validate(packet)


def test_needs_context_is_not_ready_even_if_all_questions_filled():
    packet = review.build_packet()
    packet.update(reviewer="test-fixture-only", reviewed_at="2026-09-22")
    for case in packet["cases"]:
        case["review"].update(decision="needs_context", rationale="fixture")
    result = review.validate(packet)
    assert result["pending"] == [] and len(result["needs_context"]) == 5
    assert not result["ready_for_calibration"]


def test_create_refuses_to_overwrite_human_work(tmp_path, monkeypatch):
    path = tmp_path / "review.json"
    monkeypatch.setattr(sys, "argv", ["review", "--create", str(path)])
    assert review.main() == 0
    path.with_suffix(".md").write_text("human work", encoding="utf-8")
    with pytest.raises(FileExistsError):
        review.main()
    assert path.with_suffix(".md").read_text(encoding="utf-8") == "human work"
    assert json.loads(path.read_text(encoding="utf-8")) == review.build_packet()
