"""Verifier labels cannot leak into requests or replace quote provenance checks."""

import hashlib
import json

import pytest

from core.tests.evaluations import answer_support_check as checker
from core.tests.evaluations.structured_rerank import digest


def test_frozen_media_and_balanced_controls_do_not_leak_labels():
    cases = checker.corpus()
    assert len(cases) == 28
    controls = [c for c in cases if c["id"].startswith("control/")]
    assert sum(c["expected"] == "supported" for c in controls) == 6
    assert sum(c["expected"] == "unsupported" for c in controls) == 6
    assert sum(c["expected"] == "unsupported" for c in cases) == 11
    for case in cases:
        body = checker.request_body(case, "fixture")
        sent = json.loads(body["messages"][1]["content"])
        assert set(sent) == {"question", "answer", "citations"}
        assert "expected" not in sent and "id" not in sent


@pytest.mark.parametrize(
    "kind", ["claim", "quote", "number", "fields", "decision", "empty"]
)
def test_schema_success_does_not_allow_fabricated_audit_quotes(kind):
    case = {
        "answer": "wrong fact[1]",
        "citations": [{"n": 1, "quote": "actual source"}],
    }
    issue = {
        "claim": "wrong fact",
        "reason": "different",
        "citation": 1,
        "quote": "actual",
    }
    result = {"verdict": "unsupported", "issues": [issue]}
    if kind == "claim":
        issue["claim"] = "fabricated"
    elif kind == "quote":
        issue["quote"] = "fabricated"
    elif kind == "number":
        issue["citation"] = True
    elif kind == "fields":
        issue["extra"] = "ignored"
    elif kind == "decision":
        result["verdict"] = "supported"
    else:
        result["issues"] = []
    with pytest.raises(ValueError):
        checker.validate(json.dumps(result), case)


def test_missing_evidence_and_uncertainty_are_not_silently_supported():
    case = {"answer": "claim", "citations": []}
    result = {
        "verdict": "uncertain",
        "issues": [
            {"claim": "claim", "reason": "no evidence", "citation": 0, "quote": ""}
        ],
    }
    assert checker.validate(json.dumps(result), case) == result
    assert (
        checker.validate('{"verdict":"supported","issues":[]}', case)["verdict"]
        == "supported"
    )
    # The latter is structurally valid, not semantically certified; calibrated
    # false-negative results must remain visible rather than rewritten by code.


@pytest.mark.parametrize("tamper", [None, "request", "source", "missing", "result"])
def test_report_integrity_and_false_negatives(tamper):
    cases = checker.corpus()
    report = {
        "complete": True,
        "model": "fixture",
        "prompt": checker.PROMPT,
        "schema": checker.SCHEMA,
        "plan_sha256": digest([{"id": c["id"], **checker.payload(c)} for c in cases]),
        "source_sha256": {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (
                checker.CONTROLS,
                checker.INPUTS,
                checker.RESPONSES,
                checker.AUDIT,
            )
        },
        "cases": [
            {
                "id": c["id"],
                "model_returned": "fixture",
                "finish_reason": "stop",
                "request_sha256": digest(checker.request_body(c, "fixture")),
                "raw": '{"verdict":"supported","issues":[]}',
                "result": {"verdict": "supported", "issues": []},
                "usage": {"total_tokens": 1},
            }
            for c in cases
        ],
    }
    if tamper == "request":
        report["cases"][0]["request_sha256"] = "changed"
    elif tamper == "source":
        report["source_sha256"] = {}
    elif tamper == "missing":
        report["cases"].pop()
    elif tamper == "result":
        report["cases"][0]["result"]["verdict"] = "unsupported"
    if tamper:
        with pytest.raises(AssertionError):
            checker.evaluate(report)
    else:
        result = checker.evaluate(report)
        assert len(result["summary"]["control"]["unsupported_passed"]) == 6
        assert len(result["summary"]["media"]["unsupported_passed"]) == 5
        assert result["production_promotion_approved"] is False
