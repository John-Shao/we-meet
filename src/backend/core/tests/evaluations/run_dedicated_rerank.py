"""Explicit paid ranking of the frozen synthetic batch 66 inputs, no retries."""

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import requests

from core.tests.evaluations.dedicated_rerank import (
    ENDPOINT,
    MODEL,
    request_body,
    validate_response,
)
from core.tests.evaluations.structured_rerank import build_plan, digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Use a new output path")
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    if plan != build_plan() or len(plan) > 64:
        raise ValueError("Plan must match the frozen synthetic corpus")
    report = {
        "complete": False,
        "model": MODEL,
        "endpoint": ENDPOINT,
        "plan_sha256": hashlib.sha256(args.plan.read_bytes()).hexdigest(),
        "scores_are_request_relative": True,
        "cases": [],
    }
    for item in plan:
        body = request_body(item)
        started = time.monotonic()
        response = requests.post(
            ENDPOINT,
            headers={"Authorization": "Bearer " + os.environ["MIAOJI_EVAL_API_KEY"]},
            json=body,
            timeout=60,
        )
        row = {
            "id": item["id"],
            "request_sha256": digest(body),
            "status_code": response.status_code,
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }
        try:
            response.raise_for_status()
            row["response"] = response.json()
            row["ranked"] = validate_response(row["response"], item)
        except (requests.HTTPError, ValueError, TypeError):
            # Preserve a sanitized failed receipt; never silently switch models.
            row["invalid_response"] = True
            report["cases"].append(row)
            args.output.write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            raise
        report["cases"].append(row)
        report["complete"] = len(report["cases"]) == len(plan)
        args.output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        print(item["id"], len(row["ranked"]), flush=True)  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
