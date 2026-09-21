"""Frozen embedding replay over live ORM visibility, solely in the test database."""

import gzip
import hashlib
import json
import os
from datetime import date
from pathlib import Path

import pytest

from core import models
from core.services import meeting_search
from core.services.global_ask import GlobalAskService
from core.tests.evaluations.compare_meeting_qa import compare
from core.tests.evaluations.meeting_qa import evaluate, report, seed_case
from core.tests.evaluations.run_semantic_embeddings import validate_vector
from core.tests.evaluations.semantic_candidates import (
    THRESHOLDS,
    collect,
    cosine,
    embedding_text,
    ranked,
    render,
    text_id,
)

ROOT = Path(__file__).parent
CORPORA = [
    ROOT / name
    for name in (
        "meeting_qa_cases.json",
        "meeting_qa_expansion_cases.json",
        "meeting_qa_semantic_cases.json",
    )
]
CASES = [
    (p, c) for p in CORPORA for c in json.loads(p.read_text(encoding="utf-8"))["cases"]
]


@pytest.fixture(scope="module")
def experiment():
    path = os.environ.get("MEETING_QA_VECTORS")
    artifact = json.loads(gzip.decompress(Path(path).read_bytes())) if path else None
    if artifact:
        assert artifact["complete"] and artifact["dimensions"] == 1024
        assert all(r["model_returned"] == artifact["model"] for r in artifact["requests"])
        assert len(artifact["requests"]) == len(artifact["vectors"])
        assert {r["text_id"] for r in artifact["requests"]} == set(artifact["vectors"])
        for vector in artifact["vectors"].values():
            validate_vector(vector)
    state = {
        "vectors": artifact["vectors"] if artifact else None,
        "plan": {},
        "rows": {},
    }
    yield state
    output = os.environ.get("MEETING_QA_SEMANTIC_OUTPUT")
    if not output:
        return
    assert sum(len(v) for v in state["rows"].values()) == len(CASES)
    target = Path(output)
    target.mkdir(parents=True, exist_ok=True)
    plan = [{"id": k, "text": v} for k, v in sorted(state["plan"].items())]
    plan_text = json.dumps(plan, ensure_ascii=False, indent=2) + "\n"
    if artifact:
        assert artifact["plan_sha256"] == hashlib.sha256(plan_text.encode()).hexdigest()
        assert set(artifact["vectors"]) == set(state["plan"])
    (target / "plan.json").write_text(plan_text, encoding="utf-8", newline="\n")
    result = {
        "mode": "replay" if artifact else "planning",
        "thresholds": THRESHOLDS,
        "vector_artifact_sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()
        if path
        else None,
        "model": artifact["model"] if artifact else None,
        "harness_sha256": {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [Path(__file__), ROOT / "semantic_candidates.py"]
        },
        "corpora": {},
    }
    for corpus in CORPORA:
        values = state["rows"][corpus.name]
        arms = {}
        for arm in ("baseline", *(str(t) for t in THRESHOLDS)):
            rows = [v[arm] for v in values]
            value = report(rows)
            value.update(
                dataset=json.loads(corpus.read_text(encoding="utf-8"))["dataset"],
                dataset_sha256=hashlib.sha256(corpus.read_bytes()).hexdigest(),
            )
            arms[arm] = value
        result["corpora"][corpus.stem] = {
            "reports": arms,
            "comparisons": {
                str(t): compare(arms["baseline"], arms[str(t)]) for t in THRESHOLDS
            },
            "diagnostics": [v["diagnostic"] for v in values],
        }
    (target / "report.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def compact(row):
    return {
        k: v
        for k, v in row.items()
        if k
        not in {
            "generation_prompt",
            "human_review",
            "answer_requirements",
            "generated_answer",
        }
    }


@pytest.mark.django_db
@pytest.mark.parametrize("corpus,case", CASES, ids=[c["id"] for _, c in CASES])
def test_semantic_fallback(corpus, case, settings, monkeypatch, experiment):
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
    candidates = (
        collect(
            viewer,
            **{
                k: date.fromisoformat(case[k])
                for k in ("date_from", "date_to")
                if case.get(k)
            },
        )
        if eligible
        else []
    )
    ranking = []
    if candidates:
        for text in [case["question"], *(embedding_text(c) for c in candidates)]:
            experiment["plan"][text_id(text)] = text
        if experiment["vectors"]:
            ranking = ranked(candidates, case["question"], experiment["vectors"])
    row = {"baseline": baseline}
    for threshold in THRESHOLDS:
        candidate = baseline
        if ranking:

            def recall(user, keywords, citations, *, cutoff=threshold, **kwargs):
                return render(ranking, citations, cutoff)

            with monkeypatch.context() as patch:
                patch.setattr(meeting_search, "recall_records", recall)
                candidate = compact(evaluate(case, viewer, aliases, patch))
        row[str(threshold)] = candidate
        assert not candidate["metrics"]["forbidden_content"]
    row["diagnostic"] = {
        "id": case["id"],
        "eligible": eligible,
        "visible_windows": len(candidates),
        "ranking": [
            {
                "record": aliases[str(c.record_id)],
                "text": c.text,
                "ability": c.ability,
                "cosine": c.body_score,
            }
            for c in sorted(ranking, key=lambda c: -c.body_score)
        ],
    }
    experiment["rows"].setdefault(corpus.name, []).append(row)


@pytest.mark.parametrize(
    "a,b", [([], []), ([0], [1]), ([1], [1, 2]), ([float("nan")], [1]), ([True], [1])]
)
def test_invalid_vectors_rejected(a, b):
    with pytest.raises(ValueError):
        cosine(a, b)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "case",
    [
        c
        for p, c in CASES
        if c["id"]
        in {
            "private_translation",
            "revoked_translation",
            "trashed_translation",
            "dated_translation",
            "corrected_translation",
            "reviewed_translation",
        }
    ],
    ids=lambda c: c["id"],
)
def test_perfect_similarity_cannot_bypass_source_boundaries(case, settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.CELERY_ENABLED = False
    viewer, _ = seed_case(case)
    candidates = collect(
        viewer,
        **{
            k: date.fromisoformat(case[k])
            for k in ("date_from", "date_to")
            if case.get(k)
        },
    )
    if case.get("expect_empty"):
        assert candidates == []
    else:
        assert any(e["span"] in c.text for e in case["evidence"] for c in candidates)
        assert all(s not in c.text for s in case["forbidden_spans"] for c in candidates)


@pytest.mark.parametrize(
    "vector", [[], [1.0] * 1023, [0.0] * 1024, [True] * 1024, [float("inf")] * 1024]
)
def test_provider_vector_contract(vector):
    with pytest.raises(ValueError):
        validate_vector(vector)


def test_cosine_controls():
    assert cosine([1, 0], [1, 0]) == 1
    assert cosine([1, 0], [0, 1]) == 0
    assert cosine([1, 0], [-1, 0]) == -1


@pytest.mark.django_db
def test_revision_changes_embedding_key_and_excludes_old_text(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.CELERY_ENABLED = False
    case = next(c for _, c in CASES if c["id"] == "corrected_translation")
    viewer, _ = seed_case(case)
    old = collect(viewer)
    segment = models.MeetingOriginalSegment.objects.get()
    models.MeetingOriginalRevision.objects.create(
        record=segment.record,
        original=segment,
        revision=2,
        edited_by=viewer,
        text="新的当前有效结论。",
    )
    current = collect(viewer)
    assert len(current) == 1 and current[0].text == "新的当前有效结论。"
    assert text_id(embedding_text(current[0])) != text_id(embedding_text(old[0]))
    # Frozen vectors for an obsolete projection must not silently substitute.
    with pytest.raises(KeyError):
        ranked(
            current,
            "query",
            {text_id("query"): [1], text_id(embedding_text(old[0])): [1]},
        )


@pytest.mark.django_db
def test_cached_candidate_citations_fail_after_revocation(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.CELERY_ENABLED = False
    case = {
        "records": [
            {
                "id": "a",
                "title": "合成样本",
                "date": "2026-09-01",
                "texts": ["当前结论。"],
                "access": "transcript",
            }
        ]
    }
    viewer, _ = seed_case(case)
    candidates = collect(viewer)
    assert candidates
    models.MeetingRecordAccess.objects.filter(user=viewer).delete()
    citations = []
    render(candidates, citations, 0)
    assert not meeting_search.citations_visible(viewer, citations)
    assert collect(viewer) == []
