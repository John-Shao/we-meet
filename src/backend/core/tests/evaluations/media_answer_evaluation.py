"""Generate answers from frozen media selections using the current service prompt."""

import argparse
import ast
import hashlib
import json
import os
import re
import time
from pathlib import Path

import requests

from core.tests.evaluations.context_decisions import encoded
from core.tests.evaluations.media_auto_evaluation import build_plan as evidence_plan
from core.tests.evaluations.media_auto_evaluation import (
    evaluate as validate_evidence_run,
)
from core.tests.evaluations.structured_rerank import ARTIFACTS, digest

DRAWS = ARTIFACTS / "miaoji-qa-media-auto-generations-b72.json"
SERVICE = Path(__file__).parents[2] / "services/global_ask.py"


def service_constants():
    names = {"_SYSTEM_PROMPT_TEMPLATE", "_EMPTY_ANSWER"}
    values = {}
    for node in ast.parse(SERVICE.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in names:
                    values[target.id] = ast.literal_eval(node.value)
    if set(values) != names or not all(isinstance(v, str) for v in values.values()):
        raise ValueError("Service prompt must be available as literal strings")
    return values


def build_plan():
    draws = json.loads(DRAWS.read_text(encoding="utf-8"))
    validate_evidence_run(draws)
    inputs = {p["id"]: p for p in evidence_plan()}
    constants = service_constants()
    cases = []
    for row in draws["cases"]:
        if row["decision"] not in ("evidence", "no_evidence"):
            raise ValueError("This answer experiment requires evidence or no_evidence")
        citations = [
            {"n": i, "source_id": s["id"], "quote": s["evidence"]}
            for i, s in enumerate(row["selected"], 1)
        ]
        context = (
            "【会议字幕】\n"
            + "\n\n".join(f"[{c['n']}] {c['quote']}" for c in citations)
            + "\n"
        )
        cases.append(
            {
                "id": row["id"],
                "arm": row["arm"],
                "question": inputs[row["id"]]["question"],
                "citations": citations,
                "system": constants["_SYSTEM_PROMPT_TEMPLATE"].format(context=context)
                if citations
                else None,
                "canned_answer": constants["_EMPTY_ANSWER"] if not citations else None,
            }
        )
    return cases


def request_body(case, model):
    if case["system"] is None:
        raise ValueError("Empty evidence must not call the model")
    return {
        "model": model,
        "temperature": 0,
        "enable_thinking": False,
        "messages": [
            {"role": "system", "content": case["system"]},
            {"role": "user", "content": case["question"]},
        ],
    }


def citation_check(answer, citations):
    used = sorted({int(n) for n in re.findall(r"\[(\d+)\]", answer)})
    valid = {c["n"] for c in citations}
    return {
        "used": used,
        "invalid": sorted(set(used) - valid),
        "references_existing_evidence": bool(used) and set(used) <= valid
        if citations
        else not used,
        "semantic_support_checked": False,
    }


def validate_report(report, plan):
    """Validate provenance and reference numbers; semantic audit remains separate."""
    assert report["complete"] and plan == build_plan()
    assert report["plan_sha256"] == hashlib.sha256(encoded(plan)).hexdigest()
    assert report["upstream_sha256"] == hashlib.sha256(DRAWS.read_bytes()).hexdigest()
    assert report["service_sha256"] == hashlib.sha256(SERVICE.read_bytes()).hexdigest()
    rows = {(r["id"], r["arm"]): r for r in report["cases"]}
    assert len(rows) == len(report["cases"])
    assert set(rows) == {(c["id"], c["arm"]) for c in plan}
    failures = []
    for case in plan:
        row = rows[case["id"], case["arm"]]
        assert row["input_sha256"] == digest(case)
        assert isinstance(row["answer"], str) and row["answer"].strip()
        if case["canned_answer"] is not None:
            assert (
                row["model_called"] is False and row["answer"] == case["canned_answer"]
            )
            assert row["finish_reason"] == "canned"
        else:
            assert row["model_called"] is True
            assert row["model_returned"] == report["model_requested"]
            assert row["request_sha256"] == digest(
                request_body(case, report["model_requested"])
            )
        checked = citation_check(row["answer"], case["citations"])
        assert row["citation_check"] == checked
        if not checked["references_existing_evidence"] or row["finish_reason"] not in (
            "stop",
            "canned",
        ):
            failures.append({"id": case["id"], "arm": case["arm"]})
    return {
        "total": len(rows),
        "model_calls": sum(r["model_called"] for r in rows.values()),
        "canned_answers": sum(not r["model_called"] for r in rows.values()),
        "reference_or_completion_failures": failures,
        "semantic_support_checked": False,
    }


def resume_rows(previous, current, plan):
    """Only resume an interrupted prefix, preserving every existing response."""
    if previous["complete"]:
        raise ValueError("Completed runs must not be resumed")
    for key in current.keys() - {"cases", "complete"}:
        if previous[key] != current[key]:
            raise ValueError("Resume provenance does not match")
    rows = previous["cases"]
    if not isinstance(rows, list) or len(rows) >= len(plan):
        raise ValueError("Expected an incomplete response prefix")
    for row, case in zip(rows, plan, strict=False):
        if (row["id"], row["arm"], row["input_sha256"]) != (
            case["id"],
            case["arm"],
            digest(case),
        ):
            raise ValueError("Resume rows must be the original ordered prefix")
        if case["canned_answer"] is not None:
            if row["model_called"] or row["answer"] != case["canned_answer"]:
                raise ValueError("Changed canned response")
        elif (
            not row["model_called"]
            or row["request_sha256"]
            != digest(request_body(case, current["model_requested"]))
            or row["model_returned"] != current["model_requested"]
        ):
            raise ValueError("Changed model request")
        if row["citation_check"] != citation_check(row["answer"], case["citations"]):
            raise ValueError("Changed citation check")
    return list(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--resume-from", type=Path)
    args = parser.parse_args()
    if args.plan.exists() or args.output.exists():
        raise FileExistsError("Use new output paths")
    plan = build_plan()
    args.plan.write_bytes(encoded(plan))
    report = {
        "complete": False,
        "human_review_gate": "skipped_by_user_2026-09-22",
        "human_review_performed": False,
        "mode": "offline_fixed_evidence_answer_generation",
        "model_requested": args.model,
        "temperature": 0,
        "enable_thinking": False,
        "max_tokens": None,
        "base_url": args.base_url,
        "plan_sha256": hashlib.sha256(args.plan.read_bytes()).hexdigest(),
        "upstream_sha256": hashlib.sha256(DRAWS.read_bytes()).hexdigest(),
        "service_sha256": hashlib.sha256(SERVICE.read_bytes()).hexdigest(),
        "production_retrieval_executed": False,
        "production_promotion_approved": False,
        "cases": [],
    }
    if args.resume_from:
        previous = json.loads(args.resume_from.read_text(encoding="utf-8"))
        report["cases"] = resume_rows(previous, report, plan)
        report["resumed_from_sha256"] = hashlib.sha256(
            args.resume_from.read_bytes()
        ).hexdigest()
    args.output.write_bytes(encoded(report))
    for case in plan[len(report["cases"]) :]:
        row = {"id": case["id"], "arm": case["arm"], "input_sha256": digest(case)}
        if case["canned_answer"] is not None:
            row.update(
                answer=case["canned_answer"], model_called=False, finish_reason="canned"
            )
        else:
            body = request_body(case, args.model)
            started = time.monotonic()
            response = requests.post(
                args.base_url.rstrip("/") + "/chat/completions",
                headers={
                    "Authorization": "Bearer " + os.environ["MIAOJI_EVAL_API_KEY"]
                },
                json=body,
                timeout=60,
            )
            response.raise_for_status()
            data = response.json()
            choice = data["choices"][0]
            row.update(
                answer=choice["message"]["content"],
                finish_reason=choice["finish_reason"],
                model_called=True,
                model_returned=data.get("model"),
                usage=data.get("usage"),
                elapsed_seconds=round(time.monotonic() - started, 3),
                request_sha256=digest(body),
            )
        row["citation_check"] = citation_check(row["answer"], case["citations"])
        report["cases"].append(row)
        report["complete"] = len(report["cases"]) == len(plan)
        args.output.write_bytes(encoded(report))
        print(case["id"], case["arm"], row["finish_reason"], flush=True)  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
