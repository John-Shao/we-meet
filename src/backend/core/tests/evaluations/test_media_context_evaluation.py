"""Bounded context must retain source provenance without using reference answers."""

from copy import deepcopy

import pytest

from core.tests.evaluations import media_answer_evaluation as answers
from core.tests.evaluations.media_context_evaluation import POLICY, availability, expand


def segment(ident, start, text):
    return {"id": ident, "start_ms": start, "end_ms": start + 100, "text": text}


def test_order_and_time_boundary_do_not_change_anchor():
    rows = [
        segment("a", 0, "earlier"),
        segment("b", 1000, "anchor"),
        segment("c", 40000, "unrelated later discussion"),
    ]
    anchor = {"n": 1, "source_id": "b", "quote": "anchor"}
    result = expand(anchor, rows)
    assert result == expand(anchor, list(reversed(rows)))
    assert [s["id"] for s in result["segments"]] == ["a", "b"]
    assert result["anchor_quote"] == "anchor"
    assert "unrelated" not in result["quote"]


def test_character_budget_does_not_truncate_neighbors_or_anchor():
    rows = [segment("a", 0, "x" * 1000), segment("b", 1000, "exact quote")]
    result = expand({"source_id": "b", "quote": "exact quote"}, rows)
    assert len(result["quote"]) <= POLICY["max_chars"]
    assert [s["id"] for s in result["segments"]] == ["b"]
    with pytest.raises(ValueError, match="budget"):
        expand({"source_id": "a", "quote": "x" * 1000}, rows)


@pytest.mark.parametrize("kind", ["unknown", "duplicate", "not_verbatim"])
def test_invalid_anchors_fail_closed(kind):
    rows = [segment("a", 0, "original")]
    anchor = {
        "source_id": "missing" if kind == "unknown" else "a",
        "quote": "changed" if kind == "not_verbatim" else "original",
    }
    if kind == "duplicate":
        rows *= 2
    with pytest.raises(ValueError):
        expand(anchor, rows)


def test_neighbor_count_is_bounded_even_when_timestamps_are_close():
    rows = [segment(str(i), i, "text") for i in range(20)]
    result = expand({"source_id": "10", "quote": "text"}, rows)
    assert [s["id"] for s in result["segments"]] == [str(i) for i in range(7, 14)]


def test_media_expansion_is_separate_from_selection_and_preserves_empty_answers():
    baseline = answers.build_plan()
    original = deepcopy(baseline)
    plan = answers.build_plan(True)
    assert baseline == original
    for before, after in zip(baseline, plan, strict=True):
        assert before["canned_answer"] == after["canned_answer"]
        assert [(c["n"], c["source_id"], c["quote"]) for c in before["citations"]] == [
            (c["n"], c["source_id"], c["anchor_quote"]) for c in after["citations"]
        ]
        for citation in after["citations"]:
            assert len(citation["quote"]) <= POLICY["max_chars"]
            assert {s["id"][0] for s in citation["segments"]} == {
                citation["source_id"][0]
            }
        if not after["citations"]:
            assert after["system"] is None
        else:
            sent = str(answers.request_body(after, "fixture"))
            assert "fact_groups" not in sent and "expected_decision" not in sent
    assert sum(r["all_fact_groups_present"] for r in availability(baseline)) == 15
    assert sum(r["all_fact_groups_present"] for r in availability(plan)) == 20
