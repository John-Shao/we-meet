"""Replay real reranker decisions through ORM sources; no production integration."""

import gzip
import hashlib
import json
import os
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest

from core.services import meeting_search
from core.services.global_ask import GlobalAskService
from core.tests.evaluations.compare_meeting_qa import compare
from core.tests.evaluations.evidence_rerank import (
    PROMPT,
    candidate_id,
    entity_matches,
    payload,
    validate_selection,
)
from core.tests.evaluations.meeting_qa import evaluate, report, seed_case
from core.tests.evaluations.semantic_candidates import collect, ranked, render
from core.tests.evaluations.test_semantic_retrieval import CASES, CORPORA, compact

ROOT = Path(__file__).parent
ARTIFACTS = ROOT.parents[4] / "docs/research/evaluations"
VECTOR_PATH = ARTIFACTS / "miaoji-qa-semantic-vectors-b64.json.gz"
CONTROLS = json.loads(
    (ROOT / "meeting_qa_rerank_controls.json").read_text(encoding="utf-8")
)["cases"]
ARMS = ("baseline", "dense_035", "entity_only", "entity_rerank")


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


@pytest.fixture(scope="session")
def experiment():
    vectors = json.loads(gzip.decompress(VECTOR_PATH.read_bytes()))
    assert vectors["complete"]
    path = os.environ.get("MEETING_QA_RERANK_DRAWS")
    draws = json.loads(Path(path).read_text(encoding="utf-8")) if path else None
    if draws:
        assert draws["complete"] and draws["prompt"] == PROMPT
    state = {
        "vectors": vectors["vectors"],
        "draws": draws,
        "plan": [],
        "rows": {},
        "controls": [],
    }
    yield state
    output = os.environ.get("MEETING_QA_RERANK_OUTPUT")
    if not output:
        return
    assert sum(len(v) for v in state["rows"].values()) == len(CASES)
    assert len(state["controls"]) == len(CONTROLS)
    target = Path(output)
    target.mkdir(parents=True, exist_ok=True)
    plan = sorted(state["plan"], key=lambda x: x["id"])
    if draws:
        assert draws["plan_sha256"] == hashlib.sha256(encoded(plan)).hexdigest()
        assert {d["id"] for d in draws["cases"]} == {p["id"] for p in plan}
        assert len(draws["cases"]) == len(plan)
    (target / "plan.json").write_bytes(encoded(plan))
    result = {
        "mode": "replay" if draws else "planning",
        "pool_threshold": 0.35,
        "vector_sha256": hashlib.sha256(VECTOR_PATH.read_bytes()).hexdigest(),
        "draws_sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()
        if path
        else None,
        "harness_sha256": {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [
                Path(__file__),
                ROOT / "evidence_rerank.py",
                ROOT / "meeting_qa_rerank_controls.json",
            ]
        },
        "corpora": {},
        "controls": state["controls"],
    }
    for corpus in CORPORA:
        values = state["rows"][corpus.name]
        reports = {}
        for arm in ARMS:
            value = report([v[arm] for v in values])
            value.update(
                dataset=json.loads(corpus.read_text(encoding="utf-8"))["dataset"],
                dataset_sha256=hashlib.sha256(corpus.read_bytes()).hexdigest(),
            )
            reports[arm] = value
        result["corpora"][corpus.stem] = {
            "reports": reports,
            "comparisons": {
                a: compare(reports["baseline"], reports[a]) for a in ARMS[1:]
            },
            "decisions": [v["decision"] for v in values],
        }
    (target / "report.json").write_bytes(encoded(result))


def selection(item, state):
    if not item["candidates"]:
        return []
    state["plan"].append(item)
    if not state["draws"]:
        return []
    matched = [r for r in state["draws"]["cases"] if r["id"] == item["id"]]
    assert len(matched) == 1
    row = matched[0]
    assert row["question"] == item["question"]
    assert (
        row["input_sha256"]
        == hashlib.sha256(
            json.dumps(payload(item), ensure_ascii=False).encode()
        ).hexdigest()
    )
    assert row["model_returned"] == state["draws"]["model"]
    try:
        if row["finish_reason"] != "stop":
            raise ValueError("Incomplete model output")
        parsed = validate_selection(json.loads(row["raw"]), item)
    except (ValueError, TypeError):
        assert row.get("invalid_output") and row["selected"] == []
    else:
        assert not row.get("invalid_output") and parsed == row["selected"]
    return validate_selection(row["selected"], item)


@pytest.mark.django_db
@pytest.mark.parametrize("corpus,case", CASES, ids=[c["id"] for _, c in CASES])
def test_rerank(corpus, case, settings, monkeypatch, experiment):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.CELERY_ENABLED = False
    settings.JUSI_IM_CONFIGURATION = {}
    viewer, aliases = seed_case(case)
    with monkeypatch.context() as patch:
        baseline = compact(evaluate(case, viewer, aliases, patch))
    eligible = baseline["canned"] and not GlobalAskService._quoted_keywords(
        case["question"]
    )
    pool, guarded, reranked = [], [], []
    picked = []
    if eligible:
        candidates = collect(
            viewer,
            **{
                k: date.fromisoformat(case[k])
                for k in ("date_from", "date_to")
                if case.get(k)
            },
        )
        if candidates:
            pool = meeting_search._select(
                [
                    c
                    for c in ranked(candidates, case["question"], experiment["vectors"])
                    if c.body_score >= 0.35
                ]
            )
            guarded = [
                c for c in pool if entity_matches(case["question"], c.title, c.text)
            ]
            by_id = {candidate_id(aliases[str(c.record_id)], c): c for c in guarded}
            item = {
                "id": corpus.stem + "/" + case["id"],
                "question": case["question"],
                "candidates": [
                    {"id": k, "title": c.title, "text": c.text}
                    for k, c in by_id.items()
                ],
            }
            picked = selection(item, experiment)
            reranked = [
                replace(by_id[r["id"]], body_score=len(picked) - i)
                for i, r in enumerate(picked)
            ]
    result = {"baseline": baseline}
    for arm, candidates in (
        ("dense_035", pool),
        ("entity_only", guarded),
        ("entity_rerank", reranked),
    ):
        value = baseline
        if eligible:

            def recall(user, keywords, citations, *, rows=candidates, **kwargs):
                return render(rows, citations, 0)

            with monkeypatch.context() as patch:
                patch.setattr(meeting_search, "recall_records", recall)
                value = compact(evaluate(case, viewer, aliases, patch))
        result[arm] = value
        assert not value["metrics"]["forbidden_content"]
    result["decision"] = {
        "id": case["id"],
        "eligible": eligible,
        "pool_count": len(pool),
        "entity_survivors": len(guarded),
        "selected": picked,
    }
    experiment["rows"].setdefault(corpus.name, []).append(result)


@pytest.mark.parametrize("case", CONTROLS, ids=lambda c: c["id"])
def test_direct_controls(case, experiment):
    item = {
        "id": "controls/" + case["id"],
        "question": case["question"],
        "candidates": [
            c
            for c in case["candidates"]
            if entity_matches(case["question"], c["title"], c["text"])
        ],
    }
    selected = selection(item, experiment)
    actual = [r["id"] for r in selected]
    experiment["controls"].append(
        {
            "id": case["id"],
            "expected": case["expected_ids"],
            "actual": actual,
            "passed": set(actual) == set(case["expected_ids"])
            if experiment["draws"]
            else None,
        }
    )
    # Semantic quality failures must be reported, not disguised as parser test failures.


@pytest.mark.parametrize(
    "text,expected",
    [
        ("ZXQ997批准。", True),
        ("zxq997批准。", True),
        ("ZXQ9970批准。", False),
        ("XZXQ997批准。", False),
        ("另一项目批准。", False),
    ],
)
def test_exact_identifier_boundary(text, expected):
    assert entity_matches("ZXQ997的预算", "", text) is expected


@pytest.mark.parametrize(
    "value",
    [
        None,
        ["847586ff3e7ece43019a", "16ad58dce0e1fc46bbc1"],
        [{"id": "missing", "evidence": "事实"}],
        [{"id": "a", "evidence": "编造"}],
        [{"id": "a", "evidence": "事实"}] * 2,
        [{"id": "a", "evidence": "事实", "extra": 1}],
    ],
)
def test_invalid_evidence_selection(value):
    with pytest.raises(ValueError):
        validate_selection(value, {"candidates": [{"id": "a", "text": "事实依据"}]})


def test_payload_omits_gold_and_internal_annotations():
    item = {
        "id": "internal",
        "question": "问题",
        "gold": ["secret"],
        "candidates": [
            {"id": "a", "title": "标题", "text": "原句", "score": 0.9, "gold": True}
        ],
    }
    assert payload(item) == {
        "question": "问题",
        "candidates": [{"id": "a", "title": "标题", "text": "原句"}],
    }
