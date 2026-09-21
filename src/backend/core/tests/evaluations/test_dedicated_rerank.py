"""Frozen dedicated rankings through the established visible-source ORM harness."""

import copy
import gzip
import hashlib
import json
import os
import statistics
from pathlib import Path

import pytest

from core.tests.evaluations import test_evidence_rerank as previous
from core.tests.evaluations.compare_meeting_qa import compare
from core.tests.evaluations.dedicated_rerank import (
    ENDPOINT,
    MODEL,
    POLICIES,
    request_body,
    select,
    validate_response,
)
from core.tests.evaluations.meeting_qa import report
from core.tests.evaluations.structured_rerank import ARTIFACTS, build_plan, digest
from core.tests.evaluations.test_structured_rerank import DIRECT_CONTROLS


@pytest.fixture(scope="session")
def dedicated_experiment():
    path = os.environ.get("MEETING_QA_DEDICATED_DRAWS")
    if not path:
        pytest.skip("Set MEETING_QA_DEDICATED_DRAWS for model replay")
    draws = json.loads(Path(path).read_text(encoding="utf-8"))
    plan = build_plan()
    assert (
        draws["complete"] and draws["model"] == MODEL and draws["endpoint"] == ENDPOINT
    )
    assert draws["scores_are_request_relative"] is True
    assert draws["plan_sha256"] == hashlib.sha256(previous.encoded(plan)).hexdigest()
    indexed = {v["id"]: v for v in draws["cases"]}
    assert len(indexed) == len(draws["cases"]) == len(plan)
    assert set(indexed) == {i["id"] for i in plan}
    for item in plan:
        row = indexed[item["id"]]
        assert row["status_code"] == 200 and not row.get("invalid_response")
        assert row["request_sha256"] == digest(request_body(item))
        assert row["ranked"] == validate_response(row["response"], item)
    old_path = ARTIFACTS / "miaoji-qa-structured-report-b66.json"
    old = json.loads(old_path.read_text(encoding="utf-8"))
    state = {
        "plan": {i["id"]: i for i in plan},
        "indexed": indexed,
        "used": set(),
        "rows": {p: {} for p in POLICIES},
        "controls": [],
        "vectors": json.loads(gzip.decompress(previous.VECTOR_PATH.read_bytes()))[
            "vectors"
        ],
    }
    yield state
    assert state["used"] == {(i, p) for i in indexed for p in POLICIES}
    assert len(state["controls"]) == len(DIRECT_CONTROLS) * len(POLICIES)
    output = os.environ.get("MEETING_QA_DEDICATED_OUTPUT")
    if not output:
        return
    result = {
        "mode": "replay",
        "model": MODEL,
        "policies": POLICIES,
        "draws_sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest(),
        "plan_sha256": draws["plan_sha256"],
        "baseline_artifact": old_path.name,
        "baseline_sha256": hashlib.sha256(old_path.read_bytes()).hexdigest(),
        "harness_sha256": {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [
                Path(__file__),
                Path(previous.__file__),
                previous.ROOT / "dedicated_rerank.py",
                previous.ROOT / "structured_rerank.py",
                previous.ROOT / "meeting_qa_scenario_controls.json",
            ]
        },
        "corpora": {},
        "controls": state["controls"],
        "calls": {
            "count": len(draws["cases"]),
            "total_tokens": sum(
                v["response"]["usage"]["total_tokens"] for v in draws["cases"]
            ),
            "latency_median": statistics.median(
                v["elapsed_seconds"] for v in draws["cases"]
            ),
            "latency_max": max(v["elapsed_seconds"] for v in draws["cases"]),
        },
    }
    for corpus in previous.CORPORA:
        baselines = old["corpora"][corpus.stem]["reports"]
        reports = {}
        for policy in POLICIES:
            rows = state["rows"][policy][corpus.name]
            assert len(rows) == len(baselines["baseline"]["cases"])
            assert {v["baseline"]["id"]: v["baseline"]["metrics"] for v in rows} == {
                v["id"]: v["metrics"] for v in baselines["baseline"]["cases"]
            }
            value = report([v["entity_rerank"] for v in rows])
            value.update(
                dataset=baselines["baseline"]["dataset"],
                dataset_sha256=hashlib.sha256(corpus.read_bytes()).hexdigest(),
            )
            reports[policy] = value
        result["corpora"][corpus.stem] = {
            "reports": reports,
            "comparisons": {
                p: {
                    b: compare(baselines[b], reports[p])
                    for b in ("baseline", "dense_035", "schema_only")
                }
                for p in POLICIES
            },
        }
    Path(output).write_bytes(previous.encoded(result))


@pytest.mark.django_db
@pytest.mark.parametrize("policy", POLICIES)
@pytest.mark.parametrize(
    "sample", previous.CASES, ids=[c["id"] for _, c in previous.CASES]
)
def test_dedicated_retrieval(
    sample, policy, settings, monkeypatch, dedicated_experiment
):
    corpus, case = sample
    state = dedicated_experiment
    local = {"vectors": state["vectors"], "rows": state["rows"][policy]}

    def selected(item, _):
        if not item["candidates"]:
            return []
        assert item == state["plan"][item["id"]]
        state["used"].add((item["id"], policy))
        # Adapter forwards IDs only; no generated evidence quotes are fabricated.
        return [
            {"id": r["id"]}
            for r in select(state["indexed"][item["id"]]["ranked"], policy)
        ]

    with monkeypatch.context() as patch:
        patch.setattr(previous, "selection", selected)
        previous.test_rerank(corpus, case, settings, patch, local)


@pytest.mark.parametrize("policy", POLICIES)
@pytest.mark.parametrize("case", DIRECT_CONTROLS, ids=lambda c: c["plan_id"])
def test_direct_ranking(case, policy, dedicated_experiment):
    state = dedicated_experiment
    row = state["indexed"][case["plan_id"]]
    selected = select(row["ranked"], policy)
    actual = [r["id"] for r in selected]
    gold = case["expected_ids"]
    state["used"].add((case["plan_id"], policy))
    state["controls"].append(
        {
            "id": case["plan_id"],
            "policy": policy,
            "expected": gold,
            "actual": actual,
            "first_relevant_rank": next(
                (i + 1 for i, r in enumerate(row["ranked"]) if r["id"] in gold), None
            ),
            "required_decision": case["expected_decision"],
            "decision_capability": "not_implemented",
            "selection_exact": set(actual) == set(gold),
            "all_evidence": set(gold).issubset(actual) if gold else None,
        }
    )


ITEM = {
    "question": "test",
    "candidates": [
        {"id": "a", "title": "A", "text": "source one"},
        {"id": "b", "title": "B", "text": "source two"},
    ],
}
VALID = {
    "model": MODEL,
    "usage": {"total_tokens": 10},
    "results": [
        {"index": 1, "relevance_score": 0.8},
        {"index": 0, "relevance_score": 0.2},
    ],
}


def test_original_indices_map_to_stable_ids():
    assert validate_response(VALID, ITEM) == [
        {"id": "b", "score": 0.8},
        {"id": "a", "score": 0.2},
    ]
    assert len(select(validate_response(VALID, ITEM), "top1")) == 1


@pytest.mark.parametrize(
    "rows",
    [
        [],
        [{"index": 1, "relevance_score": 0.8}],
        [{"index": 1, "relevance_score": 0.8}, {"index": 1, "relevance_score": 0.2}],
        [{"index": True, "relevance_score": 0.8}, {"index": 0, "relevance_score": 0.2}],
        [{"index": 2, "relevance_score": 0.8}, {"index": 0, "relevance_score": 0.2}],
        [
            {"index": 1, "relevance_score": float("nan")},
            {"index": 0, "relevance_score": 0.2},
        ],
        [
            {"index": 1, "relevance_score": float("inf")},
            {"index": 0, "relevance_score": 0.2},
        ],
        [{"index": 1, "relevance_score": True}, {"index": 0, "relevance_score": 0.2}],
        [{"index": 1, "relevance_score": -0.1}, {"index": 0, "relevance_score": 0.2}],
        [{"index": 1, "relevance_score": 0.2}, {"index": 0, "relevance_score": 0.8}],
    ],
)
def test_invalid_rank_contract(rows):
    with pytest.raises(ValueError):
        validate_response({**VALID, "results": rows}, ITEM)


@pytest.mark.parametrize(
    "update",
    [
        {"model": "other"},
        {"usage": None},
        {"usage": {"total_tokens": -1}},
        {"usage": {"total_tokens": True}},
    ],
)
def test_invalid_provenance(update):
    with pytest.raises(ValueError):
        validate_response({**VALID, **update}, ITEM)


def test_request_never_sends_gold_or_internal_ids():
    item = copy.deepcopy(ITEM)
    item["gold"] = "private label"
    body = request_body(item)
    assert body == {
        "model": MODEL,
        "query": "test",
        "documents": ["A\nsource one", "B\nsource two"],
        "top_n": 2,
    }
