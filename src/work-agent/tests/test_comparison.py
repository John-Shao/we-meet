"""Comparison evidence must come from identical inputs and runtime pins."""

import copy
import importlib.util
import sys
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "compare_reviews",
    Path(__file__).resolve().parents[1] / "scripts/compare_reviews.py",
)
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class ComparisonTests(unittest.TestCase):
    def test_changed_inputs_runtime_or_failure_cannot_be_reported_as_pass(self):
        result = {
            "cases": [{"name": "sample", "snapshot_sha256": "a" * 64, "passed": True}],
            "review_deployment": {
                key: "pin"
                for key in (
                    "image",
                    "runtime_version",
                    "adapter_version",
                    "policy_sha256",
                )
            },
        }
        result["review_deployment"]["provider"] = "deepseek"
        qwen = copy.deepcopy(result)
        qwen["review_deployment"]["provider"] = "qwen"
        self.assertTrue(comparison.compare_evidence([result, qwen])["passed"])
        for change in ("snapshot", "runtime", "failure", "missing", "provider"):
            other = copy.deepcopy(qwen)
            if change == "snapshot":
                other["cases"][0]["snapshot_sha256"] = "b" * 64
            elif change == "runtime":
                other["review_deployment"]["image"] = "different"
            elif change == "failure":
                other["cases"][0]["passed"] = False
            elif change == "missing":
                other["cases"] = []
            else:
                other["review_deployment"]["provider"] = "deepseek"
            self.assertFalse(comparison.compare_evidence([result, other])["passed"])

    def baseline(self):
        identity = {
            "image": "sha256:" + "a" * 64,
            "runtime_version": comparison.PI_VERSION,
            "adapter_version": comparison.ADAPTER_VERSION,
            "policy_sha256": "a" * 64,
            "contract": comparison.CONTRACT,
            "engine": "pi",
            "execution": "docker",
        }
        cases = []
        for sample in comparison.samples():
            verdict = sample["expected_verdict"] or "no_issues"
            files = sample["files"]
            name = next(iter(files))
            report = {
                "verdict": verdict,
                "summary": "Synthetic test result.",
                "findings": [],
                "missing_information": [],
            }
            if verdict == "needs_changes":
                report["findings"] = [
                    {
                        "severity": "error",
                        "message": "Problem.",
                        "evidence": [
                            {
                                "file": name,
                                "sha256": comparison.digest(files[name].encode()),
                                "quote": files[name],
                            }
                        ],
                    }
                ]
            elif verdict == "inconclusive":
                report["missing_information"] = ["Missing source records."]
            cases.append(
                {
                    "name": sample["name"],
                    "snapshot_sha256": sample["snapshot_sha256"],
                    "expected_verdict": sample["expected_verdict"],
                    "report": report,
                    "passed": True,
                    "state": "succeeded",
                    "metering": {"calls": 1},
                    "input_unchanged": True,
                    "only_review_artifact": True,
                }
            )
        return {
            "synthetic_only": True,
            "dataset_version": comparison.DATASET_VERSION,
            "model": "deepseek-flash",
            "cases": cases,
            "review_deployment": {
                **identity,
                "provider": "deepseek",
                "thinking": "low",
                "model": "deepseek-flash",
                "features": ["readonly_review_v1"],
            },
        }, identity

    def test_baseline_reuse_rejects_drift_or_invented_evidence(self):
        baseline, identity = self.baseline()
        names = comparison.CASES
        validated = comparison.validate_baseline(
            baseline, identity, "deepseek-flash", names
        )
        self.assertEqual(len(validated["cases"]), 5)
        for change in (
            "model",
            "image",
            "dataset",
            "snapshot",
            "duplicate",
            "quote",
            "calls",
            "budget",
        ):
            other = copy.deepcopy(baseline)
            if change == "model":
                other["review_deployment"]["model"] = "other-model"
            elif change == "image":
                other["review_deployment"]["image"] = "other-image"
            elif change == "dataset":
                other["dataset_version"] = "old"
            elif change == "snapshot":
                other["cases"][0]["snapshot_sha256"] = "f" * 64
            elif change == "duplicate":
                other["cases"].append(copy.deepcopy(other["cases"][0]))
            elif change == "quote":
                other["cases"][1]["report"]["findings"][0]["evidence"][0]["quote"] = (
                    "Invented quote"
                )
            elif change == "calls":
                other["cases"][0]["metering"]["calls"] = 2
            else:
                other["cases"][0]["limits"] = {
                    **comparison.LIMITS,
                    "max_model_calls": 2,
                }
            with self.assertRaisesRegex(ValueError, "incompatible"):
                comparison.validate_baseline(other, identity, "deepseek-flash", names)

    def test_failed_baseline_stays_failed(self):
        baseline, identity = self.baseline()
        baseline["cases"][0].update(state="failed", report=None, passed=False)
        validated = comparison.validate_baseline(
            baseline, identity, "deepseek-flash", comparison.CASES
        )
        self.assertFalse(validated["cases"][0]["passed"])

    def test_invalid_baseline_stops_before_any_evaluation(self):
        import json
        from tempfile import TemporaryDirectory
        from unittest.mock import patch

        baseline, identity = self.baseline()
        baseline["cases"][0]["snapshot_sha256"] = "bad"
        with TemporaryDirectory() as directory:
            path = Path(directory) / "baseline.json"
            path.write_text(json.dumps(baseline), encoding="utf8")
            state = Path(directory) / "new-state"
            argv = [
                "compare_reviews",
                "--live",
                "--state",
                str(state),
                "--output",
                str(Path(directory) / "comparison.json"),
                "--deepseek-baseline",
                str(path),
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(comparison, "runtime_identity", return_value=identity),
                patch.object(comparison.subprocess, "run") as paid_run,
            ):
                with self.assertRaisesRegex(ValueError, "incompatible"):
                    comparison.main()
                paid_run.assert_not_called()
                self.assertFalse(state.exists())

    def test_reuse_runs_only_qwen_with_the_resolved_image(self):
        import json
        from tempfile import TemporaryDirectory
        from types import SimpleNamespace
        from unittest.mock import patch

        baseline, identity = self.baseline()
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "baseline.json"
            path.write_text(json.dumps(baseline), encoding="utf8")
            output = root / "comparison.json"
            argv = [
                "compare_reviews",
                "--live",
                "--state",
                str(root / "state"),
                "--output",
                str(output),
                "--deepseek-baseline",
                str(path),
            ]

            def evaluate(command, **kwargs):
                self.assertEqual(
                    command[command.index("--review-provider") + 1], "qwen"
                )
                self.assertEqual(
                    command[command.index("--pi-image") + 1], identity["image"]
                )
                value = copy.deepcopy(baseline)
                value["review_deployment"]["provider"] = "qwen"
                destination = Path(command[command.index("--output") + 1])
                destination.write_text(json.dumps(value), encoding="utf8")
                return SimpleNamespace(returncode=0)

            with (
                patch.object(sys, "argv", argv),
                patch.object(comparison, "runtime_identity", return_value=identity),
                patch.object(comparison, "Config") as config,
                patch("builtins.print"),
                patch.object(
                    comparison.subprocess, "run", side_effect=evaluate
                ) as calls,
            ):
                self.assertEqual(comparison.main(), 0)
                calls.assert_called_once()
                config.assert_called_once()
                self.assertEqual(config.call_args.kwargs["provider"], "qwen")
            result = json.loads(output.read_text(encoding="utf8"))
            self.assertTrue(result["deepseek_baseline_reused"])
            self.assertEqual(result["max_new_model_calls"], 5)
            self.assertEqual(json.loads(path.read_text(encoding="utf8")), baseline)
