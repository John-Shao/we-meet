"""Explicit paid frozen-corpus experiment, without selective quality retries."""

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import requests

from core.tests.evaluations.context_decisions import CASES_PATH
from core.tests.evaluations.context_decisions import build_plan as context_plan
from core.tests.evaluations.evidence_rerank import payload
from core.tests.evaluations.media_auto_evaluation import build_plan as media_plan
from core.tests.evaluations.media_auto_evaluation import (
    corpus_hash as media_corpus_hash,
)
from core.tests.evaluations.structured_rerank import (
    ARMS,
    PROMPTS,
    build_plan,
    digest,
    request_body,
    validate,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--corpus", choices=("b66", "b69", "b72"), default="b66")
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Use a new output path")
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    if args.corpus == "b69":
        canonical = context_plan()
    elif args.corpus == "b72":
        canonical = media_plan()
    else:
        canonical = build_plan()
    if plan != canonical or len(plan) > 64:
        raise ValueError("Plan must match the frozen corpus")
    report = {
        "complete": False,
        "corpus": args.corpus,
        "plan_sha256": hashlib.sha256(args.plan.read_bytes()).hexdigest(),
        "prompts": PROMPTS,
        "model": args.model,
        "base_url": args.base_url,
        "temperature": 0,
        "enable_thinking": False,
        "max_tokens": None,
        "response_format": "json_schema/strict",
        "cases": [],
    }
    if args.corpus == "b69":
        report["corpus_sha256"] = hashlib.sha256(CASES_PATH.read_bytes()).hexdigest()
    elif args.corpus == "b72":
        report["corpus_sha256"] = media_corpus_hash()
    for index, item in enumerate(plan):
        # Alternate arm order to reduce a consistent temporal ordering effect.
        for arm in ARMS if index % 2 == 0 else reversed(ARMS):
            body = request_body(item, arm, args.model)
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
            row = {
                "id": item["id"],
                "arm": arm,
                "input_sha256": digest(payload(item)),
                "schema_sha256": digest(body["response_format"]),
                "request_sha256": digest(body),
                "model_returned": data.get("model"),
                "usage": data.get("usage"),
                "raw": choice["message"]["content"],
                "finish_reason": choice["finish_reason"],
                "elapsed_seconds": round(time.monotonic() - started, 3),
            }
            try:
                if row["finish_reason"] != "stop":
                    raise ValueError("Incomplete output")
                row.update(validate(json.loads(row["raw"]), item))
            except (ValueError, TypeError):
                row.update(selected=[], decision="invalid", invalid_output=True)
            report["cases"].append(row)
            report["complete"] = len(report["cases"]) == len(plan) * len(ARMS)
            args.output.write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            print(item["id"], arm, row["decision"], flush=True)  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
