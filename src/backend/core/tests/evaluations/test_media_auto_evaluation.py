"""Skipping human review must not turn automatic references into human labels."""

import hashlib
import json

import pytest

from core.tests.evaluations import media_auto_evaluation as auto
from core.tests.evaluations.context_decisions import encoded
from core.tests.evaluations.evidence_rerank import payload
from core.tests.evaluations.structured_rerank import (
    ARMS,
    PROMPTS,
    digest,
    request_body,
    response_format,
)


def fixture_draws():
    selected = {
        "M01": ["A05"],
        "M02": ["A07", "A10"],
        "M03": ["A07", "A17"],
        "M04": [],
        "M05": ["V07"],
    }
    rows = []
    for case in auto.cases():
        for arm in ARMS:
            value = {
                "decision": case["expected_decision"],
                "selected": [
                    {"id": c["id"], "evidence": c["text"]}
                    for c in case["candidates"]
                    if c["id"] in selected[case["id"].split("/")[0]]
                ],
            }
            rows.append(
                {
                    "id": case["id"],
                    "arm": arm,
                    "model_returned": "fixture",
                    "input_sha256": digest(payload(case)),
                    "schema_sha256": digest(response_format(case)),
                    "request_sha256": digest(request_body(case, arm, "fixture")),
                    "raw": json.dumps(value, ensure_ascii=False),
                    "finish_reason": "stop",
                    "usage": {"total_tokens": 1},
                    "elapsed_seconds": 0.1,
                    **value,
                }
            )
    return {
        "complete": True,
        "corpus": "b72",
        "corpus_sha256": auto.corpus_hash(),
        "plan_sha256": hashlib.sha256(encoded(auto.build_plan())).hexdigest(),
        "prompts": PROMPTS,
        "model": "fixture",
        "temperature": 0,
        "enable_thinking": False,
        "max_tokens": None,
        "response_format": "json_schema/strict",
        "cases": rows,
    }


def test_plan_includes_all_sources_and_hides_automatic_references():
    plan = auto.build_plan()
    assert len(plan) == 10 and all(len(c["candidates"]) == 26 for c in plan)
    for left, right in zip(plan[::2], plan[1::2], strict=True):
        assert left["question"] == right["question"]
        assert left["candidates"] == list(reversed(right["candidates"]))
    for case in auto.cases():
        assert set(
            json.loads(
                request_body(case, "scenario", "fixture")["messages"][1]["content"]
            )
        ) == {"question", "candidates"}


def test_automatic_results_do_not_claim_human_review_or_final_answers():
    result = auto.evaluate(fixture_draws())
    assert result["calls"] == 20
    assert result["human_review_gate"] == "skipped_by_user_2026-09-22"
    assert result["human_review_performed"] is False
    assert result["final_answer_evaluated"] is False
    assert result["production_promotion_approved"] is False
    assert all(
        r["automatic_reference_agrees"] == 10 for r in result["summary"].values()
    )


def test_missing_fact_or_unrelated_source_does_not_agree():
    case = next(c for c in auto.cases() if c["id"] == "M02/forward")
    row = {
        "arm": "scenario",
        "decision": "evidence",
        "selected": [
            {
                "id": "A07",
                "evidence": next(
                    c["text"] for c in case["candidates"] if c["id"] == "A07"
                ),
            }
        ],
    }
    assert not auto.score(case, row)["automatic_reference_agrees"]
    row["selected"].append({"id": "V07", "evidence": "unrelated"})
    assert auto.score(case, row)["unexpected_ids"] == ["V07"]


@pytest.mark.parametrize(
    "mutation", ["corpus", "request", "raw", "missing", "duplicate"]
)
def test_provenance_and_complete_run_required(mutation):
    draws = fixture_draws()
    if mutation == "corpus":
        draws["corpus_sha256"] = "changed"
    elif mutation == "request":
        draws["cases"][0]["request_sha256"] = "changed"
    elif mutation == "raw":
        draws["cases"][0]["raw"] = "bad output"
    elif mutation == "missing":
        draws["cases"].pop()
    else:
        draws["cases"][-1] = draws["cases"][0]
    with pytest.raises(AssertionError):
        auto.evaluate(draws)
