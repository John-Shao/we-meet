"""Compare an OFFLINE-only empty-result fallback; never changes production search."""

import hashlib
import json
import os
from pathlib import Path

import pytest

from core.services.global_ask import GlobalAskService
from core.tests.evaluations.meeting_qa import evaluate, report, seed_case
from core.tests.evaluations.run_query_expansion import validate_plan, validate_terms

ROOT = Path(__file__).parent
CORPORA = [ROOT / "meeting_qa_cases.json", ROOT / "meeting_qa_expansion_cases.json"]
CASES = [
    (p, c) for p in CORPORA for c in json.loads(p.read_text(encoding="utf-8"))["cases"]
]


@pytest.fixture(scope="module")
def results():
    rows, plan = {}, []
    yield rows, plan
    output = os.environ.get("MEETING_QA_EXPANSION_OUTPUT")
    if output:
        assert sum(len(v) for v in rows.values()) == len(CASES)
        target = Path(output)
        target.mkdir(parents=True, exist_ok=True)
        for corpus in CORPORA:
            values = rows[corpus.name]
            for arm in ("baseline", "candidate"):
                value = report([v[arm] for v in values])
                value.update(
                    dataset=json.loads(corpus.read_text(encoding="utf-8"))["dataset"],
                    dataset_sha256=hashlib.sha256(corpus.read_bytes()).hexdigest(),
                    experiment="offline empty/unquoted keyword replacement; no production integration",
                    harness_sha256=hashlib.sha256(
                        Path(__file__).read_bytes()
                    ).hexdigest(),
                )
                rewrite_file = os.environ.get("MEETING_QA_EXPANSIONS")
                value["query_rewrite_artifact_sha256"] = (
                    hashlib.sha256(Path(rewrite_file).read_bytes()).hexdigest()
                    if rewrite_file
                    else None
                )
                value["query_rewrite_generation"] = (
                    "external frozen artifact; answer generation disabled"
                )
                value["expansion_decisions"] = [v["decision"] for v in values]
                (target / (corpus.stem + "-" + arm + ".json")).write_text(
                    json.dumps(value, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                    newline="\n",
                )
        (target / "plan.json").write_text(
            json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )


@pytest.mark.django_db
@pytest.mark.parametrize("corpus,case", CASES, ids=[c["id"] for _, c in CASES])
def test_offline_fallback(corpus, case, settings, monkeypatch, results):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.CELERY_ENABLED = False
    settings.JUSI_IM_CONFIGURATION = {}
    settings.CACHES = {
        "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
    }
    viewer, aliases = seed_case(case)
    with monkeypatch.context() as patch:
        baseline = evaluate(case, viewer, aliases, patch)
    eligible = baseline["canned"] and not GlobalAskService._quoted_keywords(
        case["question"]
    )
    rows, plan = results
    terms = []
    key = corpus.stem + "/" + case["id"]
    if eligible:
        plan.append({"id": key, "question": case["question"]})
        path = os.environ.get("MEETING_QA_EXPANSIONS")
        if path:
            rewrites = json.loads(Path(path).read_text(encoding="utf-8"))["cases"]
            matches = [r for r in rewrites if r["id"] == key]
            assert len(matches) == 1 and matches[0]["question"] == case["question"]
            terms = validate_terms(matches[0]["terms"])
    candidate = baseline
    if terms:
        with monkeypatch.context() as patch:
            patch.setattr(
                GlobalAskService,
                "_meeting_keywords",
                classmethod(lambda cls, question: terms),
            )
            candidate = evaluate(case, viewer, aliases, patch)
    decision = {
        "id": case["id"],
        "eligible": eligible,
        "terms": terms,
        "attempted": bool(terms),
    }
    rows.setdefault(corpus.name, []).append(
        {"baseline": baseline, "candidate": candidate, "decision": decision}
    )
    assert not candidate["metrics"]["forbidden_content"]
    # Quality and empty-result regressions stay in reports; pytest green is NOT promotion.


@pytest.mark.parametrize("value", [None, "budget", ["a"], [1], ["x" * 41], ["xx"] * 4])
def test_reject_invalid_terms(value):
    with pytest.raises(ValueError):
        validate_terms(value)


@pytest.mark.parametrize(
    "value",
    [
        {},
        [{"id": "x", "question": "q", "evidence": []}],
        [{"id": "x", "question": "q"}] * 2,
        [{"id": "x", "question": 1}],
    ],
)
def test_reject_non_question_plan(value):
    with pytest.raises(ValueError):
        validate_plan(value)


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
def test_matching_rewrite_still_obeys_boundaries(case, settings, monkeypatch):
    # Deliberately matching control, separate from real-model effectiveness scores.
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.CELERY_ENABLED = False
    viewer, aliases = seed_case(case)
    monkeypatch.setattr(
        GlobalAskService, "_meeting_keywords", classmethod(lambda cls, q: ["回滚"])
    )
    result = evaluate(case, viewer, aliases, monkeypatch)
    assert not result["metrics"]["forbidden_content"]
    if case.get("expect_empty"):
        assert result["metrics"]["empty_expectation_met"]
    else:
        assert result["metrics"]["all_evidence"]
