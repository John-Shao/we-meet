"""Separate synthetic context decisions; never reinterpret B68 human judgments."""

import argparse
import hashlib
import json
import statistics
from pathlib import Path

from core.tests.evaluations.evidence_rerank import payload
from core.tests.evaluations.structured_rerank import (
    ARMS,
    PROMPTS,
    digest,
    replay,
    request_body,
)

CASES_PATH = Path(__file__).with_name("meeting_qa_context_cases.json")


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def cases():
    source = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    result = []
    for case in source["cases"]:
        for reverse in (False, True):
            result.append(
                {
                    **case,
                    "id": case["id"] + ("/reverse" if reverse else "/forward"),
                    "candidates": list(reversed(case["candidates"]))
                    if reverse
                    else case["candidates"],
                }
            )
    return result


def build_plan():
    return [{"id": case["id"], **payload(case)} for case in cases()]


def score(case, row):
    expected = case["expected_evidence"]
    selected = {s["id"]: s["evidence"] for s in row["selected"]}
    decision_ok = row["decision"] == case["expected_decision"]
    ids_ok = set(selected) == set(expected)
    facts_ok = all(
        all(term in selected.get(ident, "") for term in terms)
        for ident, terms in expected.items()
    )
    return {
        "id": case["id"],
        "arm": row["arm"],
        "expected_decision": case["expected_decision"],
        "decision": row["decision"],
        "expected_ids": list(expected),
        "actual_ids": list(selected),
        "decision_passed": decision_ok,
        "evidence_ids_passed": ids_ok,
        "required_facts_present": facts_ok,
        "passed": decision_ok and ids_ok and facts_ok,
    }


def evaluate(draws):
    plan = build_plan()
    assert draws["complete"] and draws["corpus"] == "b69"
    assert draws["corpus_sha256"] == hashlib.sha256(CASES_PATH.read_bytes()).hexdigest()
    assert draws["plan_sha256"] == hashlib.sha256(encoded(plan)).hexdigest()
    assert draws["prompts"] == PROMPTS
    assert draws["temperature"] == 0 and draws["enable_thinking"] is False
    assert draws["max_tokens"] is None
    assert draws["response_format"] == "json_schema/strict"
    indexed = {(r["id"], r["arm"]): r for r in draws["cases"]}
    expected_keys = {(c["id"], a) for c in plan for a in ARMS}
    assert set(indexed) == expected_keys and len(indexed) == len(draws["cases"])
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
        paired = [r for r in rows if r["id"].endswith("/forward")]
        summary[arm] = {
            "total": len(rows),
            "decision_passed": sum(r["decision_passed"] for r in rows),
            "fully_passed": sum(r["passed"] for r in rows),
            "both_orders_passed": sum(
                r["passed"] and by_id[r["id"].replace("/forward", "/reverse")]["passed"]
                for r in paired
            ),
            "paired_total": len(paired),
            "failed_ids": [r["id"] for r in rows if not r["passed"]],
        }
    return {
        "dataset": json.loads(CASES_PATH.read_text(encoding="utf-8"))["dataset"],
        "data_kind": "author_created_synthetic_not_independent_review",
        "mode": "frozen_model_replay",
        "corpus_sha256": hashlib.sha256(CASES_PATH.read_bytes()).hexdigest(),
        "plan_sha256": draws["plan_sha256"],
        "summary": summary,
        "cases": outcomes,
        "calls": len(draws["cases"]),
        "total_tokens": sum(r["usage"]["total_tokens"] for r in draws["cases"]),
        "median_latency_seconds": statistics.median(
            r["elapsed_seconds"] for r in draws["cases"]
        ),
        "b68_pending_context_unchanged": ["R01", "R04", "R05"],
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
        value["draws_sha256"] = hashlib.sha256(args.draws.read_bytes()).hexdigest()
        value["harness_sha256"] = {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (
                Path(__file__),
                Path(__file__).with_name("structured_rerank.py"),
                Path(__file__).with_name("evidence_rerank.py"),
            )
        }
    target.write_bytes(encoded(value))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
