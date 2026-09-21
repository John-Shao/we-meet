"""Partial human-label diagnostic, deliberately separate from eight-case readiness."""

import argparse
import hashlib
import json
from pathlib import Path

from core.tests.evaluations.context_decisions import encoded
from core.tests.evaluations.review_meeting_qa import CASE_IDS, validate
from core.tests.evaluations.structured_rerank import (
    ARMS,
    PROMPTS,
    build_plan,
    digest,
    replay,
    request_body,
)


def evaluate(packet, draws):
    readiness = validate(packet)
    if not readiness["reviewer_provided"] or not readiness["review_date_provided"]:
        raise ValueError("Human review provenance is required")
    plan = build_plan()
    assert draws["complete"] and draws.get("corpus", "b66") == "b66"
    assert draws["plan_sha256"] == hashlib.sha256(encoded(plan)).hexdigest()
    assert draws["plan_sha256"] == packet["source_sha256"]
    assert draws["prompts"] == PROMPTS
    assert draws["temperature"] == 0 and draws["enable_thinking"] is False
    assert draws["response_format"] == "json_schema/strict"
    assert draws["max_tokens"] is None
    rows = {(row["id"], row["arm"]): row for row in draws["cases"]}
    assert len(rows) == len(draws["cases"])
    assert set(rows) == {(item["id"], arm) for item in plan for arm in ARMS}
    for item in plan:
        for arm in ARMS:
            row = rows[item["id"], arm]
            assert row["model_returned"] == draws["model"]
            assert row["request_sha256"] == digest(
                request_body(item, arm, draws["model"])
            )
            replay(row, item)
    indexed_plan = {item["id"]: item for item in plan}
    outcomes, excluded = [], []
    for case, source_id in zip(packet["cases"], CASE_IDS, strict=True):
        review = case["review"]
        if review["decision"] in (None, "needs_context"):
            excluded.append(
                {
                    "id": case["id"],
                    "decision": review["decision"],
                    "reason": review["rationale"],
                }
            )
            continue
        original = indexed_plan[source_id]
        # B68 neutral ordering changed labels only; map by exact source, never rank.
        aliases = {}
        for candidate in case["candidates"]:
            matches = [
                c
                for c in original["candidates"]
                if (c["title"], c["text"]) == (candidate["title"], candidate["text"])
            ]
            if len(matches) != 1:
                raise ValueError("Source mapping must be unique")
            aliases[matches[0]["id"]] = candidate["id"]
        expected_ids = {e["candidate_id"] for e in review["evidence"]}
        expected_decision = (
            "evidence" if review["decision"] == "answer" else review["decision"]
        )
        for arm in ARMS:
            row = rows[source_id, arm]
            actual_ids = {aliases[e["id"]] for e in row["selected"]}
            decision_ok = row["decision"] == expected_decision
            evidence_ok = actual_ids == expected_ids
            outcomes.append(
                {
                    "id": case["id"],
                    "source_id": source_id,
                    "arm": arm,
                    "human_decision": review["decision"],
                    "model_decision": row["decision"],
                    "human_evidence_ids": sorted(expected_ids),
                    "model_evidence_ids": sorted(actual_ids),
                    "decision_agrees": decision_ok,
                    "evidence_set_agrees": evidence_ok,
                    "selection_agrees": decision_ok and evidence_ok,
                    "human_clarification": review["clarification"],
                }
            )
    return {
        "scope": "determinate_human_labels_only_not_full_b68_acceptance",
        "review_sha256": readiness["review_sha256"],
        "full_review_ready_for_scoring": readiness["ready_for_scoring"],
        "review_total": len(packet["cases"]),
        "included_ids": sorted({r["id"] for r in outcomes}),
        "excluded": excluded,
        "summary": {
            arm: {
                "selection_agrees": sum(
                    r["selection_agrees"] for r in outcomes if r["arm"] == arm
                ),
                "total": sum(r["arm"] == arm for r in outcomes),
                "disagrees_ids": [
                    r["id"]
                    for r in outcomes
                    if r["arm"] == arm and not r["selection_agrees"]
                ],
            }
            for arm in ARMS
        },
        "cases": outcomes,
        "new_model_calls": 0,
        "full_answer_or_clarification_text_evaluated": False,
        "production_promotion_approved": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--draws", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Use a new output path")
    result = evaluate(
        json.loads(args.review.read_text(encoding="utf-8")),
        json.loads(args.draws.read_text(encoding="utf-8")),
    )
    result["file_sha256"] = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (
            args.review,
            args.draws,
            Path(__file__),
            Path(__file__).with_name("review_meeting_qa.py"),
            Path(__file__).with_name("structured_rerank.py"),
            Path(__file__).with_name("evidence_rerank.py"),
        )
    }
    args.output.write_bytes(encoded(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
