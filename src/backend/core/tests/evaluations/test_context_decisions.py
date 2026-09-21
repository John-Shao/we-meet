"""Context fixtures preserve provenance, unknowns, and full evidence coverage."""

import copy
import hashlib
import json

import pytest

from core.tests.evaluations import context_decisions as context
from core.tests.evaluations.evidence_rerank import payload
from core.tests.evaluations.structured_rerank import (
    ARMS,
    PROMPTS,
    digest,
    request_body,
    response_format,
)


def fixture_draws():
    rows = []
    for case in context.cases():
        for arm in ARMS:
            value = {
                "decision": case["expected_decision"],
                "selected": [
                    {"id": c["id"], "evidence": c["text"]}
                    for c in case["candidates"]
                    if c["id"] in case["expected_evidence"]
                ],
            }
            rows.append(
                {
                    "id": case["id"],
                    "arm": arm,
                    "model_returned": "fixture-model",
                    "input_sha256": digest(payload(case)),
                    "schema_sha256": digest(response_format(case)),
                    "request_sha256": digest(request_body(case, arm, "fixture-model")),
                    "raw": json.dumps(value, ensure_ascii=False),
                    "finish_reason": "stop",
                    "elapsed_seconds": 0.1,
                    "usage": {"total_tokens": 1},
                    **value,
                }
            )
    return {
        "complete": True,
        "corpus": "b69",
        "corpus_sha256": hashlib.sha256(context.CASES_PATH.read_bytes()).hexdigest(),
        "plan_sha256": hashlib.sha256(
            context.encoded(context.build_plan())
        ).hexdigest(),
        "prompts": PROMPTS,
        "temperature": 0,
        "enable_thinking": False,
        "max_tokens": None,
        "response_format": "json_schema/strict",
        "model": "fixture-model",
        "cases": rows,
    }


def test_plan_does_not_expose_labels_or_change_candidates_on_reverse():
    plan = context.build_plan()
    assert len(plan) == len({c["id"] for c in plan}) == 20
    for forward, reverse in zip(plan[::2], plan[1::2], strict=True):
        assert set(forward) == {"id", "question", "candidates"}
        assert forward["question"] == reverse["question"]
        assert forward["candidates"] == list(reversed(reverse["candidates"]))
    for case in context.cases():
        sent = json.loads(
            request_body(case, "scenario", "fixture")["messages"][1]["content"]
        )
        assert sent == payload(case)
        assert set(sent) == {"question", "candidates"}


def test_known_fixture_scores_all_cases_without_claiming_production_readiness():
    report = context.evaluate(fixture_draws())
    assert report["calls"] == 40
    assert not report["production_promotion_approved"]
    assert not report["final_answer_evaluated"]
    for arm in ARMS:
        assert report["summary"][arm]["fully_passed"] == 20
        assert report["summary"][arm]["both_orders_passed"] == 10


@pytest.mark.parametrize(
    "field,value",
    [
        ("complete", False),
        ("corpus", "b66"),
        ("corpus_sha256", "changed"),
        ("plan_sha256", "changed"),
        ("prompts", {}),
        ("model", "other-model"),
    ],
)
def test_rejects_wrong_run_provenance(field, value):
    draws = fixture_draws()
    draws[field] = value
    with pytest.raises(AssertionError):
        context.evaluate(draws)


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "raw", "request"])
def test_rejects_incomplete_or_tampered_rows(mutation):
    draws = fixture_draws()
    if mutation == "missing":
        draws["cases"].pop()
    elif mutation == "duplicate":
        draws["cases"][-1] = copy.deepcopy(draws["cases"][0])
    elif mutation == "raw":
        draws["cases"][0]["raw"] = '{"decision":"clarify","selected":[]}'
    else:
        draws["cases"][0]["request_sha256"] = "changed"
    with pytest.raises(AssertionError):
        context.evaluate(draws)


def test_missing_fact_or_extra_candidate_cannot_pass_evidence_score():
    case = context.cases()[0]
    row = {
        "arm": "scenario",
        "decision": "evidence",
        "selected": [{"id": "A", "evidence": "青禾项目"}],
    }
    result = context.score(case, row)
    assert result["evidence_ids_passed"] and not result["passed"]
    row["selected"] = [
        {"id": c["id"], "evidence": c["text"]} for c in case["candidates"]
    ]
    assert not context.score(case, row)["passed"]
