"""Automatic reference diagnostics after the user explicitly skipped human review."""

import argparse
import hashlib
import json
import statistics
from pathlib import Path

from core.tests.evaluations.context_decisions import encoded
from core.tests.evaluations.evidence_rerank import payload
from core.tests.evaluations.media_intent_review import SOURCE
from core.tests.evaluations.structured_rerank import (
    ARMS,
    PROMPTS,
    digest,
    replay,
    request_body,
)

REFERENCES = Path(__file__).with_name("meeting_qa_media_auto_cases.json")


def corpus_hash():
    return hashlib.sha256(REFERENCES.read_bytes()).hexdigest()


def cases():
    refs = json.loads(REFERENCES.read_text(encoding="utf-8"))
    if refs["source_sha256"] != hashlib.sha256(SOURCE.read_bytes()).hexdigest():
        raise ValueError("Changed media source")
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    questions = {q["id"]: q["question"] for q in source["questions"]}
    assert {c["id"] for c in refs["cases"]} == set(questions)
    candidates = [
        {"id": s["id"], "title": r["media_name"], "text": s["text"]}
        for r in source["sources"]
        for s in r["segments"]
    ]
    result = []
    for ref in refs["cases"]:
        for reverse in (False, True):
            result.append(
                {
                    **ref,
                    "id": ref["id"] + ("/reverse" if reverse else "/forward"),
                    "question": questions[ref["id"]],
                    "candidates": list(reversed(candidates)) if reverse else candidates,
                }
            )
    return result


def build_plan():
    return [{"id": case["id"], **payload(case)} for case in cases()]


def score(case, row):
    selected = {s["id"]: s["evidence"] for s in row["selected"]}
    decision_ok = row["decision"] == case["expected_decision"]
    unexpected = sorted(set(selected) - set(case["allowed_ids"]))
    covered = [
        any(
            all(term in selected.get(ident, "") for term in terms)
            for ident, terms in group.items()
        )
        for group in case["fact_groups"]
    ]
    return {
        "id": case["id"],
        "arm": row["arm"],
        "reference_decision": case["expected_decision"],
        "actual_decision": row["decision"],
        "actual_ids": list(selected),
        "unexpected_ids": unexpected,
        "fact_groups_covered": covered,
        "decision_agrees": decision_ok,
        "automatic_reference_agrees": decision_ok and not unexpected and all(covered),
    }


def evaluate(draws):
    plan = build_plan()
    assert draws["complete"] and draws["corpus"] == "b72"
    assert draws["corpus_sha256"] == corpus_hash()
    assert draws["plan_sha256"] == hashlib.sha256(encoded(plan)).hexdigest()
    assert draws["prompts"] == PROMPTS
    assert draws["temperature"] == 0 and draws["enable_thinking"] is False
    assert (
        draws["max_tokens"] is None and draws["response_format"] == "json_schema/strict"
    )
    indexed = {(r["id"], r["arm"]): r for r in draws["cases"]}
    assert set(indexed) == {(c["id"], a) for c in plan for a in ARMS}
    assert len(indexed) == len(draws["cases"])
    outcomes = []
    for case in cases():
        for arm in ARMS:
            row = indexed[case["id"], arm]
            assert row["model_returned"] == draws["model"]
            assert row["request_sha256"] == digest(
                request_body(case, arm, draws["model"])
            )
            replay(row, case)
            outcomes.append(score(case, row))
    summary = {}
    for arm in ARMS:
        rows = [r for r in outcomes if r["arm"] == arm]
        by_id = {r["id"]: r for r in rows}
        summary[arm] = {
            "total": len(rows),
            "decision_agrees": sum(r["decision_agrees"] for r in rows),
            "automatic_reference_agrees": sum(
                r["automatic_reference_agrees"] for r in rows
            ),
            "both_orders_agree": sum(
                r["automatic_reference_agrees"]
                and by_id[r["id"].replace("/forward", "/reverse")][
                    "automatic_reference_agrees"
                ]
                for r in rows
                if r["id"].endswith("/forward")
            ),
            "disagrees_ids": [
                r["id"] for r in rows if not r["automatic_reference_agrees"]
            ],
        }
    return {
        "human_review_gate": "skipped_by_user_2026-09-22",
        "human_review_performed": False,
        "reference_origin": "assistant_authored_not_human_confirmed",
        "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "corpus_sha256": corpus_hash(),
        "summary": summary,
        "cases": outcomes,
        "calls": len(draws["cases"]),
        "total_tokens": sum(r["usage"]["total_tokens"] for r in draws["cases"]),
        "median_latency_seconds": statistics.median(
            r["elapsed_seconds"] for r in draws["cases"]
        ),
        "real_user_query_log": False,
        "independent_holdout": False,
        "final_answer_evaluated": False,
        "production_promotion_approved": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--plan", type=Path)
    group.add_argument("--draws", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    target = args.plan or args.output
    if target is None:
        parser.error("--draws requires --output")
    if target.exists():
        raise FileExistsError("Use a new output path")
    if args.plan:
        value = build_plan()
    else:
        value = evaluate(json.loads(args.draws.read_text(encoding="utf-8")))
        value["file_sha256"] = {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (args.draws, Path(__file__), REFERENCES)
        }
    target.write_bytes(encoded(value))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
