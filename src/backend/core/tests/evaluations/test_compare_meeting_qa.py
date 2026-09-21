"""Non-regression gates must reject missing cases and avoid aggregate-only wins."""

from copy import deepcopy

import pytest

from core.tests.evaluations.compare_meeting_qa import compare


def sample():
    return {
        "schema_version": 1,
        "dataset": "test",
        "dataset_sha256": "a",
        "scope": "meetings",
        "generation": "disabled",
        "cases": [
            {
                "id": "a",
                "question": "q",
                "gold_evidence": [],
                "metrics": {
                    "forbidden_content": False,
                    "empty_expectation_met": None,
                    "evidence_recall": 0.5,
                    "record_recall": 1,
                    "evidence_precision": 0.5,
                },
            }
        ],
    }


def test_same_report_is_not_answer_quality_pass():
    result = compare(sample(), sample())
    assert result["passed"] and not result["improvements"]
    assert result["answer_semantics"] == "not_evaluated"


def test_one_metric_improving_cannot_hide_another_regressing():
    old = sample()
    new = deepcopy(old)
    new["cases"][0]["metrics"].update(evidence_recall=1, evidence_precision=0)
    result = compare(old, new)
    assert not result["passed"] and result["improvements"]


@pytest.mark.parametrize("change", ["missing", "duplicate", "dataset", "gold", "nan"])
def test_incompatible_comparisons_rejected(change):
    old = sample()
    new = deepcopy(old)
    if change == "missing":
        new["cases"] = []
    elif change == "duplicate":
        new["cases"] *= 2
    elif change == "dataset":
        new["dataset_sha256"] = "b"
    elif change == "gold":
        new["cases"][0]["gold_evidence"] = ["changed"]
    else:
        new["cases"][0]["metrics"]["evidence_recall"] = float("nan")
    with pytest.raises(ValueError):
        compare(old, new)


@pytest.mark.parametrize(
    "key,value", [("forbidden_content", True), ("empty_expectation_met", False)]
)
def test_boundaries_override_retrieval_scores(key, value):
    old = sample()
    new = deepcopy(old)
    new["cases"][0]["metrics"][key] = value
    assert not compare(old, new)["passed"]
