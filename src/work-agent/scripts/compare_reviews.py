"""One bounded attempt per model per synthetic sample; no automatic paid retry."""

import argparse
import copy
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.review_samples import DATASET_VERSION, LIMITS, samples  # noqa: E402
from work_agent import ADAPTER_VERSION, CONTRACT, PI_VERSION  # noqa: E402
from work_agent.config import Config, load_env  # noqa: E402
from work_agent.contract import digest  # noqa: E402
from work_agent.review import validate_report  # noqa: E402

CASES = [sample["name"] for sample in samples()]


def runtime_identity(image):
    """Resolve the local tag before any paid calls; Gateway also pins this ID."""
    image_id = subprocess.check_output(
        ["docker", "image", "inspect", "--format", "{{.Id}}", image],
        timeout=10,
        stderr=subprocess.DEVNULL,
        text=True,
    ).strip()
    if not image_id.startswith("sha256:"):
        raise ValueError("invalid_runtime_image")
    return {
        "contract": CONTRACT,
        "engine": "pi",
        "execution": "docker",
        "adapter_version": ADAPTER_VERSION,
        "runtime_version": PI_VERSION,
        "policy_sha256": digest(
            (
                Path(__file__).resolve().parents[1] / "work_agent/dsh-policy.yml"
            ).read_bytes()
        ),
        "image": image_id,
    }


def validate_baseline(baseline, identity, model, selected):
    """Reject stale/material-changed evidence before Qwen can incur charges.

    Local evidence is trusted, not cryptographically signed. Failed cases remain
    failed; this function neither repairs nor cherry-picks model reports.
    """
    try:
        if (
            baseline["synthetic_only"] is not True
            or baseline["dataset_version"] != DATASET_VERSION
            or baseline["model"] != model
        ):
            raise ValueError
        deployment = baseline["review_deployment"]
        if any(deployment.get(key) != value for key, value in identity.items()):
            raise ValueError
        if (
            deployment.get("provider") != "deepseek"
            or deployment.get("thinking") != "low"
            or deployment.get("model") != model
            or "readonly_review_v1" not in deployment.get("features", [])
        ):
            raise ValueError
        cases = baseline["cases"]
        if not isinstance(cases, list) or len({case["name"] for case in cases}) != len(
            cases
        ):
            raise ValueError
        available = {case["name"]: case for case in cases}
        if set(selected) - available.keys():
            raise ValueError
        expected = {case["name"]: case for case in samples()}
        for name in selected:
            case, sample = available[name], expected[name]
            if (
                case["snapshot_sha256"] != sample["snapshot_sha256"]
                or case["expected_verdict"] != sample["expected_verdict"]
                or case.get("limits", LIMITS) != LIMITS
            ):
                raise ValueError
            calls = case["metering"]["calls"]
            if type(calls) is not int or not 0 <= calls <= 1:
                raise ValueError
            report = case["report"]
            if report is not None:
                validate_report(
                    report,
                    [
                        {"name": key, "text": text}
                        for key, text in sample["files"].items()
                    ],
                )
            passed = bool(
                case["state"] == "succeeded"
                and report
                and (
                    sample["expected_verdict"] is None
                    or report["verdict"] == sample["expected_verdict"]
                )
                and case["input_unchanged"] is True
                and case["only_review_artifact"] is True
                and calls == 1
            )
            if type(case["passed"]) is not bool or case["passed"] != passed:
                raise ValueError
        result = copy.deepcopy(baseline)
        result["cases"] = [available[name] for name in selected]
        return result
    except (KeyError, TypeError, ValueError, IndexError):
        raise ValueError("invalid_or_incompatible_deepseek_baseline") from None


def compare_evidence(results):
    """A changed snapshot or runtime invalidates the cross-model comparison."""
    left, right = results
    left_cases = {case["name"]: case for case in left["cases"]}
    right_cases = {case["name"]: case for case in right["cases"]}
    matched = (
        bool(left_cases)
        and left.get("dataset_version") == right.get("dataset_version")
        and left_cases.keys() == right_cases.keys()
        and all(
            case["snapshot_sha256"] == right_cases[name]["snapshot_sha256"]
            and case.get("expected_verdict")
            == right_cases[name].get("expected_verdict")
            for name, case in left_cases.items()
        )
    )
    deployments = [result["review_deployment"] for result in results]
    same_runtime = all(
        deployments[0][key] == deployments[1][key]
        for key in ("image", "runtime_version", "adapter_version", "policy_sha256")
    )
    provider_pair = (
        deployments[0].get("provider") == "deepseek"
        and deployments[1].get("provider") == "qwen"
    )
    return {
        "synthetic_only": True,
        "matched_snapshots": matched,
        "same_runtime": same_runtime,
        "expected_provider_pair": provider_pair,
        "passed": matched
        and same_runtime
        and provider_pair
        and all(case["passed"] for result in results for case in result["cases"]),
        "max_model_calls": 2 * len(left_cases),
        "dataset_version": left.get("dataset_version", "unspecified"),
        "limitations": [
            "Single attempt per case; no statistical quality or cost conclusion.",
            "DeepSeek thinking=low; Qwen thinking=off for reliable JSON mode.",
            "Model aliases can change upstream; requested IDs are recorded.",
            "Injection sample checks execution boundaries, not a reference verdict.",
        ],
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", required=True)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pi-image", default="we-meet-work-agent:pi-qwen-poc")
    parser.add_argument("--deepseek-model", default="deepseek-flash")
    parser.add_argument("--qwen-model", default="qwen3.8-flash")
    parser.add_argument("--qwen-base-url")
    parser.add_argument(
        "--deepseek-baseline",
        type=Path,
        help="Reuse compatible local evidence; no new DeepSeek calls",
    )
    parser.add_argument("--case", action="append", choices=CASES)
    args = parser.parse_args()
    if args.env_file:
        load_env(args.env_file)
    selected = list(dict.fromkeys(args.case or CASES))
    identity = runtime_identity(args.pi_image)
    results = []
    if args.deepseek_baseline:
        if args.deepseek_baseline.stat().st_size > 2_000_000:
            raise ValueError("baseline_too_large")
        baseline = json.loads(args.deepseek_baseline.read_text(encoding="utf8"))
        results.append(
            validate_baseline(baseline, identity, args.deepseek_model, selected)
        )
    # Check credentials/endpoints before either model can incur charges.
    for provider, model, base_url in (
        ("deepseek", args.deepseek_model, None),
        ("qwen", args.qwen_model, args.qwen_base_url),
    ):
        if provider == "deepseek" and args.deepseek_baseline:
            continue
        Config(
            "pi",
            args.state,
            "preflight-token-not-used-123456789",
            model=model,
            provider=provider,
            base_url=base_url,
        )
    args.state.mkdir(parents=True, exist_ok=False)
    for provider, model in (
        ("deepseek", args.deepseek_model),
        ("qwen", args.qwen_model),
    ):
        if provider == "deepseek" and args.deepseek_baseline:
            continue
        output = args.state / (provider + ".json")
        command = [
            sys.executable,
            str(Path(__file__).with_name("evaluate_reviews.py")),
            "--live",
            "--review-only",
            "--review-provider",
            provider,
            "--review-model",
            model,
            "--pi-image",
            identity["image"],
            "--state",
            str(args.state / provider),
            "--output",
            str(output),
        ]
        if provider == "qwen" and args.qwen_base_url:
            command += ["--review-base-url", args.qwen_base_url]
        for case in selected:
            command += ["--case", case]
        # Fixed dataset, fresh job IDs, failures retained; no automatic paid retry.
        completed = subprocess.run(command, check=False)
        if completed.returncode not in (0, 1) or not output.exists():
            raise RuntimeError("comparison_execution_failed")
        results.append(json.loads(output.read_text(encoding="utf8")))
    evidence = compare_evidence(results)
    evidence["deepseek_baseline_reused"] = bool(args.deepseek_baseline)
    evidence["max_new_model_calls"] = len(selected) * (
        1 if args.deepseek_baseline else 2
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )
    print(
        json.dumps(
            {
                key: evidence[key]
                for key in ("matched_snapshots", "same_runtime", "passed")
            }
        )
    )
    return 0 if evidence["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
