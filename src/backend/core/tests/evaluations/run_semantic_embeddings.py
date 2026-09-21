"""Explicit paid embedding generation for a frozen synthetic-only experiment plan."""

import argparse
import gzip
import hashlib
import json
import math
import os
import time
from pathlib import Path

import requests


def validate_vector(vector):
    if not isinstance(vector, list) or len(vector) != 1024:
        raise ValueError("Expected 1024-dimensional vector")
    if any(
        isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
        for v in vector
    ):
        raise ValueError("Nonfinite/non-numeric vector")
    if not any(vector):
        raise ValueError("Zero vector")
    return vector


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("plan", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Use a new output path; preserve completed requests")
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    if not isinstance(plan, list) or len(plan) > 256:
        raise ValueError("Expected small bounded synthetic experiment")
    seen = set()
    for item in plan:
        if (
            set(item) != {"id", "text"}
            or not isinstance(item["text"], str)
            or not item["text"].strip()
        ):
            raise ValueError("Expected text-only plan")
        if (
            item["id"] != hashlib.sha256(item["text"].encode()).hexdigest()
            or item["id"] in seen
        ):
            raise ValueError("Invalid or duplicate text hash")
        seen.add(item["id"])
    result = {
        "model": args.model,
        "base_url": args.base_url,
        "dimensions": 1024,
        "plan_sha256": hashlib.sha256(args.plan.read_bytes()).hexdigest(),
        "vectors": {},
        "requests": [],
        "complete": False,
    }
    for item in plan:
        start = time.monotonic()
        response = requests.post(
            args.base_url.rstrip("/") + "/embeddings",
            headers={"Authorization": "Bearer " + os.environ["MIAOJI_EVAL_API_KEY"]},
            json={
                "model": args.model,
                "input": [item["text"]],
                "dimensions": 1024,
                "encoding_format": "float",
            },
            timeout=60,
        )
        response.raise_for_status()
        data = response.json()
        if len(data["data"]) != 1:
            raise ValueError("Expected one embedding")
        result["vectors"][item["id"]] = validate_vector(data["data"][0]["embedding"])
        result["requests"].append(
            {
                "text_id": item["id"],
                "elapsed_seconds": round(time.monotonic() - start, 3),
                "usage": data.get("usage"),
                "model_returned": data.get("model"),
            }
        )
        result["complete"] = len(result["vectors"]) == len(plan)
        args.output.write_bytes(
            gzip.compress(
                (json.dumps(result, ensure_ascii=False) + "\n").encode(), mtime=0
            )
        )
        print(len(result["vectors"]), "/", len(plan), flush=True)  # noqa: T201 -- CLI progress
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
