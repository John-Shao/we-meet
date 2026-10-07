"""Explicit live evaluation with synthetic data only; no desktop files are read."""

import argparse
import json
import secrets
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from scripts.review_samples import (  # noqa: E402
    DATASET_VERSION,
    GOAL,
    LIMITS,
    MATERIAL,
    STATUS_LEGEND,
    samples,
)
from work.agent_client import AgentClient  # noqa: E402
from work_agent.config import Config, load_env  # noqa: E402
from work_agent.server import Gateway  # noqa: E402


def terminal(client, run_id):
    deadline = time.monotonic() + 310
    while time.monotonic() < deadline:
        value = client.get(run_id)
        if value["state"] in {"succeeded", "failed", "cancelled"}:
            return value
        time.sleep(0.2)
    client.cancel(run_id)
    raise RuntimeError("evaluation_deadline")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", required=True)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pi-image", default="we-meet-work-agent:pi-review-poc")
    parser.add_argument("--dsh-image", default="we-meet-work-agent:dsh-poc")
    parser.add_argument(
        "--review-provider", choices=["deepseek", "qwen"], default="deepseek"
    )
    parser.add_argument("--review-model")
    parser.add_argument("--review-base-url")
    parser.add_argument(
        "--review-only",
        action="store_true",
        help="Use a correct synthetic report instead of a new dsh execution",
    )
    parser.add_argument(
        "--case",
        action="append",
        choices=[
            "synthetic_clean",
            "dsh_generated",
            "seeded_error",
            "missing_status",
            "injection",
            "insufficient_evidence",
        ],
    )
    args = parser.parse_args()
    if args.env_file:
        load_env(args.env_file)
    model = args.review_model or (
        "qwen3.8-flash" if args.review_provider == "qwen" else "deepseek-flash"
    )
    # A fresh state directory makes each evaluation explicit; no unknown replay.
    args.state.mkdir(parents=True, exist_ok=False)
    token = secrets.token_urlsafe(32)
    review_config = Config(
        "pi",
        args.state / "pi",
        token,
        model=model,
        image=args.pi_image,
        provider=args.review_provider,
        base_url=args.review_base_url,
    )
    evidence = {
        "synthetic_only": True,
        "dataset_version": DATASET_VERSION,
        "model": model,
        "cases": [],
    }
    if args.review_only:
        generated = {"result-01.md": "订单总计为300，B项目待验收。"}
        evidence["execution"] = {"state": "synthetic_fixture", "model_calls": 0}
    else:
        execution = Gateway(
            Config("dsh", args.state / "dsh", token, image=args.dsh_image)
        )
        execution.start()
        try:
            client = AgentClient(execution.url, token)
            run_id = uuid.uuid4()
            client.submit(
                run_id,
                GOAL + " 输出 report.md。",
                {"orders.csv": MATERIAL, "status-legend.md": STATUS_LEGEND},
                timeout_seconds=240,
            )
            value = terminal(client, run_id)
            evidence["execution"] = {
                "state": value["state"],
                "deployment": value["deployment"],
                "metering": value["metering"],
                "elapsed_ms": value["result"]["elapsed_ms"]
                if value["result"]
                else None,
            }
            if value["state"] != "succeeded":
                raise RuntimeError("dsh_evaluation_failed")
            generated = {
                f"result-{index:02}.{item['name'].rsplit('.', 1)[-1]}": item["text"]
                for index, item in enumerate(value["result"]["artifacts"], 1)
            }
        finally:
            execution.close()
    reviewer = Gateway(review_config)
    reviewer.start()
    try:
        client = AgentClient(reviewer.url, token)
        for sample in samples(None if args.review_only else generated):
            name = sample["name"]
            expected = sample["expected_verdict"]
            files = sample["files"]
            goal = sample["goal"]
            if args.case and name not in args.case:
                continue
            run_id = uuid.uuid4()
            client.submit(
                run_id,
                goal,
                files,
                timeout_seconds=180,
                operation="review",
                limits=LIMITS,
            )
            value = terminal(client, run_id)
            report = (
                json.loads(value["result"]["artifacts"][0]["text"])
                if value["state"] == "succeeded"
                else None
            )
            directory = args.state / "pi" / "jobs" / str(run_id) / "workspace"
            unchanged = all(
                (directory / file).read_text(encoding="utf-8") == text
                for file, text in files.items()
            )
            only_report = sorted(p.name for p in (directory / "output").iterdir()) == [
                "pi-review.json"
            ]
            passed = bool(
                report
                and (expected is None or report["verdict"] == expected)
                and unchanged
                and only_report
                and value["metering"]["calls"] == 1
            )
            evidence["cases"].append(
                {
                    "name": name,
                    "snapshot_sha256": sample["snapshot_sha256"],
                    "limits": LIMITS,
                    "expected_verdict": expected,
                    "passed": passed,
                    "state": value["state"],
                    "error_code": value["error_code"],
                    "report": report,
                    "input_unchanged": unchanged,
                    "only_review_artifact": only_report,
                    "metering": value["metering"],
                    "elapsed_ms": value["result"]["elapsed_ms"]
                    if value["result"]
                    else None,
                }
            )
            print(
                json.dumps(
                    {
                        "provider": args.review_provider,
                        "case": name,
                        "state": value["state"],
                        "passed": passed,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        evidence["review_deployment"] = reviewer.config.capabilities()
    finally:
        reviewer.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return (
        0
        if evidence["cases"] and all(item["passed"] for item in evidence["cases"])
        else 1
    )


if __name__ == "__main__":
    sys.exit(main())
