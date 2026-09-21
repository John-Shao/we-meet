"""Explicit paid generation of a fixed synthetic answer corpus; no production records."""

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import requests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    key = os.environ["MIAOJI_EVAL_API_KEY"]
    corpus = Path(__file__).with_name("meeting_qa_answer_cases.json")
    data = json.loads(corpus.read_text(encoding="utf-8"))
    templates = {
        name: path.read_text(encoding="utf-8")
        for name, path in (("before", args.before), ("after", args.after))
    }
    report = {
        "dataset": data["dataset"],
        "dataset_sha256": hashlib.sha256(corpus.read_bytes()).hexdigest(),
        "model_requested": args.model,
        "base_url": args.base_url.rstrip("/"),
        "enable_thinking": False if args.model.startswith("qwen3") else None,
        "temperature": 0.2,
        "max_tokens": 1200,
        "method": "one generation per arm/case; fixed evidence; assistant manual review pending",
        "templates": templates,
        "cases": [],
    }
    for case in data["cases"]:
        row = {**case, "outputs": {}}
        report["cases"].append(row)
        for arm, template in templates.items():
            system = template.format(context=case["context"])
            payload = {
                "model": args.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": case["question"]},
                ],
                "temperature": 0.2,
                "max_tokens": 1200,
            }
            if args.model.startswith("qwen3"):
                payload["enable_thinking"] = False
            start = time.monotonic()
            response = requests.post(
                args.base_url.rstrip("/") + "/chat/completions",
                headers={"Authorization": "Bearer " + key},
                json=payload,
                timeout=60,
            )
            response.raise_for_status()
            body = response.json()
            choice = body["choices"][0]
            row["outputs"][arm] = {
                "answer": choice["message"]["content"],
                "model_returned": body.get("model"),
                "finish_reason": choice["finish_reason"],
                "usage": body.get("usage"),
                "elapsed_seconds": round(time.monotonic() - start, 3),
                "system_sha256": hashlib.sha256(system.encode()).hexdigest(),
                "human_review": None,
            }
            args.output.write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            print(case["id"], arm, choice["finish_reason"], flush=True)  # noqa: T201 -- CLI progress
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
