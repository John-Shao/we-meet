"""Answer experiments cannot confuse valid reference numbers with supported facts."""

import hashlib
import json
import sys

import pytest

from core.tests.evaluations import media_answer_evaluation as answers
from core.tests.evaluations.context_decisions import encoded
from core.tests.evaluations.structured_rerank import digest


def test_actual_plan_preserves_all_order_variants_and_empty_evidence():
    plan = answers.build_plan()
    assert len(plan) == 20
    assert len({(p["id"], p["arm"]) for p in plan}) == 20
    empty = [p for p in plan if p["canned_answer"] is not None]
    assert len(empty) == 4
    assert all(p["id"].startswith("M04/") and not p["citations"] for p in empty)
    with pytest.raises(ValueError, match="Empty evidence"):
        answers.request_body(empty[0], "fixture")
    case = next(p for p in plan if p["system"])
    sent = answers.request_body(case, "fixture")
    assert set(sent) == {"model", "temperature", "enable_thinking", "messages"}
    assert [m["role"] for m in sent["messages"]] == ["system", "user"]


@pytest.mark.parametrize(
    "answer,invalid,has_reference",
    [("fact[1]", [], True), ("fact[2]", [2], False), ("uncited fact", [], False)],
)
def test_reference_check_does_not_assert_semantic_support(
    answer, invalid, has_reference
):
    result = answers.citation_check(answer, [{"n": 1}])
    assert result["invalid"] == invalid
    assert result["references_existing_evidence"] == has_reference
    assert result["semantic_support_checked"] is False


def test_existing_report_cannot_be_overwritten(tmp_path, monkeypatch):
    plan, output = tmp_path / "plan.json", tmp_path / "output.json"
    output.write_text("existing", encoding="utf-8")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "answers",
            "--plan",
            str(plan),
            "--output",
            str(output),
            "--model",
            "fixture",
            "--base-url",
            "https://invalid.test",
        ],
    )
    with pytest.raises(FileExistsError):
        answers.main()
    assert output.read_text(encoding="utf-8") == "existing"


def test_empty_evidence_uses_canned_answer_without_provider(tmp_path, monkeypatch):
    case = next(p for p in answers.build_plan() if p["canned_answer"] is not None)
    monkeypatch.setattr(answers, "build_plan", lambda: [case])
    monkeypatch.setattr(
        answers.requests, "post", lambda *a, **k: pytest.fail("unexpected model call")
    )
    output = tmp_path / "output.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "answers",
            "--plan",
            str(tmp_path / "plan.json"),
            "--output",
            str(output),
            "--model",
            "fixture",
            "--base-url",
            "https://invalid.test",
        ],
    )
    assert answers.main() == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["complete"] and not report["cases"][0]["model_called"]


@pytest.mark.parametrize("tamper", [False, True])
def test_report_validates_requests_but_does_not_claim_semantic_correctness(tamper):
    plan = answers.build_plan()
    report = {
        "complete": True,
        "model_requested": "fixture",
        "plan_sha256": hashlib.sha256(encoded(plan)).hexdigest(),
        "upstream_sha256": hashlib.sha256(answers.DRAWS.read_bytes()).hexdigest(),
        "service_sha256": hashlib.sha256(answers.SERVICE.read_bytes()).hexdigest(),
        "cases": [],
    }
    for case in plan:
        called = case["canned_answer"] is None
        text = "unsupported fact[1]" if called else case["canned_answer"]
        row = {
            "id": case["id"],
            "arm": case["arm"],
            "input_sha256": digest(case),
            "model_called": called,
            "answer": text,
            "model_returned": "fixture",
            "finish_reason": "stop" if called else "canned",
            "citation_check": answers.citation_check(text, case["citations"]),
        }
        if called:
            row["request_sha256"] = digest(answers.request_body(case, "fixture"))
        report["cases"].append(row)
    if tamper:
        report["cases"][0]["request_sha256"] = "changed"
        with pytest.raises(AssertionError):
            answers.validate_report(report, plan)
    else:
        result = answers.validate_report(report, plan)
        assert result["model_calls"] == 16 and result["canned_answers"] == 4
        assert result["semantic_support_checked"] is False
