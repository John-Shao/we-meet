"""Explicit paid reranking of frozen synthetic candidates; no production access."""

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import requests

from core.tests.evaluations.evidence_rerank import PROMPT, payload, validate_selection


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("plan", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Use a new output path; do not overwrite prior draws")
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    report = {
        "plan_sha256": hashlib.sha256(args.plan.read_bytes()).hexdigest(),
        "prompt": PROMPT,
        "model": args.model,
        "base_url": args.base_url,
        "temperature": 0,
        "max_tokens": 1200,
        "enable_thinking": False if args.model.startswith("qwen3") else None,
        "cases": [],
        "complete": False,
    }
    for item in plan:
        query = payload(item)
        start = time.monotonic()
        request = {
            "model": args.model,
            "temperature": 0,
            "max_tokens": 1200,
            "messages": [
                {"role": "system", "content": PROMPT},
                {"role": "user", "content": json.dumps(query, ensure_ascii=False)},
            ],
        }
        if args.model.startswith("qwen3"):
            request["enable_thinking"] = False
        response = requests.post(
            args.base_url.rstrip("/") + "/chat/completions",
            headers={"Authorization": "Bearer " + os.environ["MIAOJI_EVAL_API_KEY"]},
            json=request,
            timeout=60,
        )
        response.raise_for_status()
        data = response.json()
        choice = data["choices"][0]
        raw = choice["message"]["content"]
        row = {
            "id": item["id"],
            "question": item["question"],
            "input_sha256": hashlib.sha256(
                json.dumps(query, ensure_ascii=False).encode()
            ).hexdigest(),
            "raw": raw,
            "usage": data.get("usage"),
            "model_returned": data.get("model"),
            "finish_reason": choice["finish_reason"],
            "elapsed_seconds": round(time.monotonic() - start, 3),
        }
        try:
            if choice["finish_reason"] != "stop":
                raise ValueError("Incomplete output")
            row["selected"] = validate_selection(json.loads(raw), item)
        except (ValueError, TypeError):
            row.update(selected=[], invalid_output=True)
        report["cases"].append(row)
        report["complete"] = len(report["cases"]) == len(plan)
        args.output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        print(  # noqa: T201 -- CLI progress
            item["id"],
            len(row["selected"]),
            "invalid" if row.get("invalid_output") else "valid",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
