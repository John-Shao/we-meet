"""Run a deterministic retrieval baseline in the test DB; quality misses are reported, not hidden."""

import json
import os
from pathlib import Path

import pytest

from core.tests.evaluations.meeting_qa import (
    CASES,
    aggregate,
    evaluate,
    report,
    score,
    seed_case,
)


@pytest.fixture(scope="module")
def results():
    rows = []
    yield rows
    target = os.environ.get("MEETING_QA_EVAL_OUTPUT")
    if target and len(rows) != len(CASES):
        pytest.fail("Report requires the full unsharded case set; no report was written")
    if target:
        Path(target).write_text(
            json.dumps(report(rows), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )


@pytest.mark.django_db
@pytest.mark.parametrize("case", CASES, ids=lambda c: c["id"])
def test_baseline(case, settings, monkeypatch, results):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.CELERY_ENABLED = False
    settings.JUSI_IM_CONFIGURATION = {}
    settings.CACHES = {
        "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
    }
    viewer, aliases = seed_case(case)
    row = evaluate(case, viewer, aliases, monkeypatch)
    results.append(row)
    assert not row["metrics"]["forbidden_content"], row
    # Deliberately do not assert recall=100%: baseline quality misses must remain visible.
    assert row["generated_answer"] is None


def test_record_hit_without_support_is_not_evidence_hit():
    case = {"evidence": [{"record": "a", "span": "budget 30"}]}
    result = score(case, [{"record": "a", "context": "unrelated preamble"}])
    assert result["record_recall"] == 1
    assert result["evidence_recall"] == 0
    assert result["evidence_precision"] == 0


def test_duplicate_hits_do_not_inflate_evidence_recall():
    case = {
        "evidence": [{"record": "a", "span": "old"}, {"record": "b", "span": "new"}]
    }
    result = score(case, [{"record": "a", "context": "old"}] * 4)
    assert result["evidence_recall"] == 0.5
    assert result["largest_record_share"] == 1
    assert not result["all_evidence"]


def test_snippet_does_not_substitute_for_model_context():
    case = {"evidence": [{"record": "a", "span": "fact"}]}
    assert score(case, [{"record": "a", "context": "fact", "snippet": "short"}])[
        "all_evidence"
    ]
    assert not score(case, [{"record": "a", "context": "short", "snippet": "fact"}])[
        "all_evidence"
    ]


def test_negative_questions_have_no_vacuous_recall_credit():
    metrics = score({"evidence": [], "expect_empty": True}, [])
    summary = aggregate([{"metrics": metrics}])
    assert summary["evidence_recall"] == {"value": None, "denominator": 0}
    assert summary["empty_expectation_met"] == {"value": 1.0, "denominator": 1}


def test_forbidden_text_or_record_is_a_hard_failure():
    assert score(
        {"evidence": [], "forbidden_records": ["secret"]},
        [{"record": "secret", "context": "x"}],
    )["forbidden_content"]
    assert score(
        {"evidence": [], "forbidden_spans": ["secret"]},
        [{"record": "a", "context": "secret"}],
    )["forbidden_content"]


def test_case_annotations_are_consistent():
    assert len({c["id"] for c in CASES}) == len(CASES)
    for case in CASES:
        ids = {r["id"] for r in case["records"]}
        assert len(ids) == len(case["records"])
        assert case["split"] in {"diagnostic", "validation"}
        assert case["answer_requirements"]
        assert not (case["evidence"] and case.get("expect_empty"))
        for evidence in case["evidence"]:
            assert evidence["record"] in ids
            spec = next(r for r in case["records"] if r["id"] == evidence["record"])
            texts = [
                spec.get("corrections", {}).get(str(i), t)
                for i, t in enumerate(spec["texts"])
            ]
            texts.append(spec.get("review", spec.get("summary", "")))
            assert any(evidence["span"] in t for t in texts)
