"""Real frozen outputs may be diagnosed on five labels, not eight-case acceptance."""

import json

import pytest

from core.tests.evaluations import reviewed_intent_replay as replay
from core.tests.evaluations.structured_rerank import ARTIFACTS


def inputs():
    return (
        json.loads(
            (ARTIFACTS / "miaoji-qa-intent-review-b68.json").read_text(encoding="utf-8")
        ),
        json.loads(
            (ARTIFACTS / "miaoji-qa-structured-generations-b66.json").read_text(
                encoding="utf-8"
            )
        ),
    )


def test_actual_frozen_run_is_partial_and_does_not_rewrite_review():
    packet, draws = inputs()
    original = json.dumps(packet, ensure_ascii=False)
    result = replay.evaluate(packet, draws)
    assert result["included_ids"] == ["R02", "R03", "R06", "R07", "R08"]
    assert [c["id"] for c in result["excluded"]] == ["R01", "R04", "R05"]
    assert result["summary"]["schema_only"]["selection_agrees"] == 3
    assert result["summary"]["scenario"]["selection_agrees"] == 2
    assert all(s["total"] == 5 for s in result["summary"].values())
    assert not result["full_review_ready_for_scoring"]
    assert not result["production_promotion_approved"]
    assert json.dumps(packet, ensure_ascii=False) == original
    release = next(
        r for r in result["cases"] if r["id"] == "R02" and r["arm"] == "schema_only"
    )
    assert release["human_evidence_ids"] == ["C"]
    assert release["model_evidence_ids"] == ["B"]
    assert not release["selection_agrees"]


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "input", "raw", "prompt"])
def test_rejects_tampered_or_incomplete_model_archive(mutation):
    packet, draws = inputs()
    if mutation == "missing":
        draws["cases"].pop()
    elif mutation == "duplicate":
        draws["cases"][-1] = draws["cases"][0]
    elif mutation == "input":
        draws["cases"][0]["input_sha256"] = "changed"
    elif mutation == "raw":
        draws["cases"][0]["raw"] = "not-json"
    else:
        draws["prompts"] = {}
    with pytest.raises(AssertionError):
        replay.evaluate(packet, draws)


def test_review_provenance_is_required():
    packet, draws = inputs()
    packet["reviewer"] = None
    with pytest.raises(ValueError, match="provenance"):
        replay.evaluate(packet, draws)
