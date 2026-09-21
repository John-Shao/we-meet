"""Replay batch 66 through the same ORM/query harness, with frozen batch 65 gold."""

import gzip
import hashlib
import json
import os
import statistics
from pathlib import Path

import pytest

from core.tests.evaluations import test_evidence_rerank as previous
from core.tests.evaluations.compare_meeting_qa import compare
from core.tests.evaluations.evidence_rerank import payload
from core.tests.evaluations.meeting_qa import report
from core.tests.evaluations.structured_rerank import (
    ARMS,
    ARTIFACTS,
    PROMPTS,
    build_plan,
    controls,
    digest,
    replay,
    request_body,
    response_format,
    validate,
)

DIRECT_CONTROLS = [
    {
        **c,
        "plan_id": "controls/" + c["id"],
        "expected_decision": "evidence" if c["expected_ids"] else "no_evidence",
    }
    for c in previous.CONTROLS
] + [{**c, "plan_id": "scenario_controls/" + c["id"]} for c in controls()]


@pytest.fixture(scope="session")
def structured_experiment():
    path = os.environ.get("MEETING_QA_STRUCTURED_DRAWS")
    if not path:
        pytest.skip("Set MEETING_QA_STRUCTURED_DRAWS for frozen model replay")
    draws = json.loads(Path(path).read_text(encoding="utf-8"))
    plan = build_plan()
    assert draws["complete"] and draws["prompts"] == PROMPTS
    assert draws["response_format"] == "json_schema/strict"
    assert draws["temperature"] == 0 and draws["enable_thinking"] is False
    assert draws["max_tokens"] is None
    assert draws["plan_sha256"] == hashlib.sha256(previous.encoded(plan)).hexdigest()
    indexed = {(r["id"], r["arm"]): r for r in draws["cases"]}
    assert len(indexed) == len(draws["cases"]) == len(plan) * len(ARMS)
    assert set(indexed) == {(i["id"], a) for i in plan for a in ARMS}
    for item in plan:
        for arm in ARMS:
            row = indexed[item["id"], arm]
            assert row["model_returned"] == draws["model"]
            assert row["request_sha256"] == digest(
                request_body(item, arm, draws["model"])
            )
            replay(row, item)
    old = json.loads(
        (ARTIFACTS / "miaoji-qa-rerank-report-b65.json").read_text(encoding="utf-8")
    )
    state = {
        "plan": {i["id"]: i for i in plan},
        "vectors": json.loads(gzip.decompress(previous.VECTOR_PATH.read_bytes()))[
            "vectors"
        ],
        "indexed": indexed,
        "used": set(),
        "rows": {a: {} for a in ARMS},
        "controls": [],
    }
    yield state
    assert state["used"] == set(indexed)
    assert len(state["controls"]) == len(DIRECT_CONTROLS) * len(ARMS)
    output = os.environ.get("MEETING_QA_STRUCTURED_OUTPUT")
    if not output:
        return
    result = {
        "mode": "replay",
        "draws_sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest(),
        "plan_sha256": draws["plan_sha256"],
        "b65_report_sha256": hashlib.sha256(
            (ARTIFACTS / "miaoji-qa-rerank-report-b65.json").read_bytes()
        ).hexdigest(),
        "harness_sha256": {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [
                Path(__file__),
                Path(previous.__file__),
                previous.ROOT / "structured_rerank.py",
                previous.ROOT / "meeting_qa_scenario_controls.json",
            ]
        },
        "corpora": {},
        "controls": state["controls"],
        "calls": {},
    }
    for corpus in previous.CORPORA:
        old_reports = old["corpora"][corpus.stem]["reports"]
        reports = {
            k: old_reports[k] for k in ("baseline", "dense_035", "entity_rerank")
        }
        for arm in ARMS:
            rows = state["rows"][arm][corpus.name]
            assert len(rows) == len(old_reports["baseline"]["cases"])
            baseline_metrics = {
                c["id"]: c["metrics"] for c in reports["baseline"]["cases"]
            }
            assert baseline_metrics == {
                c["baseline"]["id"]: c["baseline"]["metrics"] for c in rows
            }
            value = report([c["entity_rerank"] for c in rows])
            value.update(
                dataset=old_reports["baseline"]["dataset"],
                dataset_sha256=hashlib.sha256(corpus.read_bytes()).hexdigest(),
            )
            reports[arm] = value
        result["corpora"][corpus.stem] = {
            "reports": reports,
            "comparisons": {
                arm: {
                    base: compare(reports[base], reports[arm])
                    for base in ("baseline", "dense_035", "entity_rerank")
                }
                for arm in ARMS
            },
        }
    for arm in ARMS:
        calls = [r for r in draws["cases"] if r["arm"] == arm]
        result["calls"][arm] = {
            "count": len(calls),
            "invalid": [c["id"] for c in calls if c.get("invalid_output")],
            "clarify": [c["id"] for c in calls if c["decision"] == "clarify"],
            "usage": {
                k: sum(c["usage"][k] for c in calls)
                for k in ("prompt_tokens", "completion_tokens", "total_tokens")
            },
            "latency_median": statistics.median(c["elapsed_seconds"] for c in calls),
            "latency_max": max(c["elapsed_seconds"] for c in calls),
        }
    Path(output).write_bytes(previous.encoded(result))


@pytest.mark.django_db
@pytest.mark.parametrize("arm", ARMS)
@pytest.mark.parametrize(
    "sample", previous.CASES, ids=[c["id"] for _, c in previous.CASES]
)
def test_structured_retrieval(
    sample, arm, settings, monkeypatch, structured_experiment
):
    corpus, case = sample

    state = structured_experiment
    local = {
        "vectors": state["vectors"],
        "rows": state["rows"][arm],
    }

    def selected(item, _):
        if not item["candidates"]:
            return []
        assert item == state["plan"][item["id"]]
        state["used"].add((item["id"], arm))
        return replay(state["indexed"][item["id"], arm], item)

    with monkeypatch.context() as patch:
        patch.setattr(previous, "selection", selected)
        previous.test_rerank(corpus, case, settings, patch, local)


@pytest.mark.parametrize("arm", ARMS)
@pytest.mark.parametrize("case", DIRECT_CONTROLS, ids=lambda c: c["plan_id"])
def test_scenario_control(case, arm, structured_experiment):
    state = structured_experiment
    item = state["plan"][case["plan_id"]]
    row = state["indexed"][item["id"], arm]
    selected = replay(row, item)
    state["used"].add((item["id"], arm))
    actual = [s["id"] for s in selected]
    state["controls"].append(
        {
            "id": case["plan_id"],
            "arm": arm,
            "expected": case["expected_ids"],
            "actual": actual,
            "expected_decision": case["expected_decision"],
            "decision": row["decision"],
            "passed": set(actual) == set(case["expected_ids"])
            and row["decision"] == case["expected_decision"],
        }
    )


ITEM = {
    "question": "test",
    "candidates": [{"id": "a", "title": "test", "text": "source evidence"}],
}


@pytest.mark.parametrize(
    "value",
    [
        [],
        {"decision": "evidence", "selected": ["a"]},
        {"decision": "evidence", "selected": []},
        {"decision": "other", "selected": []},
        {"decision": "no_evidence", "selected": [{"id": "a", "evidence": "source"}]},
        {"decision": "clarify", "selected": [{"id": "a", "evidence": "source"}]},
        {"decision": "evidence", "selected": [{"id": "b", "evidence": "source"}]},
        {"decision": "evidence", "selected": [{"id": "a", "evidence": "invented"}]},
        {"decision": "evidence", "selected": [{"id": "a", "evidence": "source"}] * 2},
        {"decision": "no_evidence", "selected": [], "extra": True},
    ],
)
def test_reject_invalid_contract(value):
    with pytest.raises(ValueError):
        validate(value, ITEM)


@pytest.mark.parametrize("decision", ["no_evidence", "clarify", "evidence"])
def test_valid_contract(decision):
    selected = [{"id": "a", "evidence": "source"}] if decision == "evidence" else []
    value = {"decision": decision, "selected": selected}
    assert validate(value, ITEM) == value


def test_request_allowlist_and_strict_schema():
    body = request_body({**ITEM, "gold": "secret"}, "scenario", "qwen3.8-flash")
    assert "max_tokens" not in body
    assert body["response_format"]["json_schema"]["strict"] is True
    assert json.loads(body["messages"][1]["content"]) == payload(ITEM)


def test_replay_rejects_saved_selection_tampering():
    row = {
        "input_sha256": digest(payload(ITEM)),
        "schema_sha256": digest(response_format(ITEM)),
        "finish_reason": "stop",
        "raw": '{"decision":"no_evidence","selected":[]}',
        "decision": "evidence",
        "selected": [{"id": "a", "evidence": "source"}],
    }
    with pytest.raises(AssertionError):
        replay(row, ITEM)
