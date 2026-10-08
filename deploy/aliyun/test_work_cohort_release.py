import copy
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

spec = importlib.util.spec_from_file_location(
    "guard", Path(__file__).with_name("check-work-cohort.py")
)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class CohortReleaseTests(unittest.TestCase):
    def setUp(self):
        self.values = {
            "backend": {
                "envVars": {
                    "WORK_LOCAL_AGENT_ENABLED": "True",
                    "WORK_AGENT_ROLLOUT_MODE": "allowlist",
                    "WORK_AGENT_ALLOWED_USER_IDS": "fixture-owner",
                    "WORK_REVIEW_ENABLED": "True",
                    "WORK_REVIEW_URL": "https://private.invalid",
                    "WORK_REVIEW_TOKEN": {
                        "secretKeyRef": {"name": "client", "key": "token"}
                    },
                    "WORK_REVIEW_CA_PEM": {
                        "secretKeyRef": {"name": "ca", "key": "ca.crt"}
                    },
                }
            }
        }
        self.snapshot = {"items": []}
        for suffix in guard.SUFFIXES:
            kind = (
                "CronJob"
                if suffix in ("-backend-docs-profiles", "-backend-reminders")
                else "Deployment"
            )
            env = [
                {
                    "name": k,
                    "valueFrom" if isinstance(v, dict) else "value": copy.deepcopy(v),
                }
                for k, v in self.values["backend"]["envVars"].items()
            ]
            spec_value = {
                "template": {
                    "spec": {"containers": [{"image": "original", "env": env}]}
                }
            }
            if kind == "CronJob":
                spec_value = {"jobTemplate": {"spec": spec_value}}
            self.snapshot["items"].append(
                {
                    "kind": kind,
                    "metadata": {
                        "name": "meet" + suffix,
                        "namespace": "meet",
                        "uid": suffix,
                    },
                    "spec": spec_value,
                }
            )

    def test_complete_overlay_and_immutable_secret_refs_match_all_consumers(self):
        rows, _ = guard.check(self.snapshot, self.values)
        self.assertEqual(len(rows), 7)
        live = copy.deepcopy(self.snapshot)
        live["items"][0]["spec"]["template"]["spec"]["containers"][0]["env"][5][
            "valueFrom"
        ]["secretKeyRef"]["optional"] = False
        guard.check_live(self.snapshot, live, "meet", "meet")
        guard.check_render(live["items"], self.snapshot, "meet", "meet")

    def test_inactive_legacy_chart_with_null_env_does_not_require_overlay(self):
        snapshot = copy.deepcopy(self.snapshot)
        for row in snapshot["items"]:
            spec = row["spec"]
            if row["kind"] == "CronJob":
                spec = spec["jobTemplate"]["spec"]
            spec["template"]["spec"]["containers"][0]["env"] = None
        _, env = guard.check(snapshot, None)
        self.assertEqual(env, {})

    def test_missing_partial_stale_or_unrelated_overlay_cannot_disable_live_pi(self):
        variants = [None, {"backend": {"envVars": {"WORK_REVIEW_ENABLED": "False"}}}]
        for key in ("WORK_REVIEW_URL", "WORK_REVIEW_TOKEN", "WORK_REVIEW_CA_PEM"):
            value = copy.deepcopy(self.values)
            del value["backend"]["envVars"][key]
            variants.append(value)
        value = copy.deepcopy(self.values)
        value["backend"]["envVars"]["DASHSCOPE_API_KEY"] = "unselected-fixture-secret"
        variants.append(value)
        for value in variants:
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ValueError, "^cohort_"),
            ):
                guard.check(self.snapshot, value)

    def test_render_drift_and_recreated_consumer_fail_before_helm_applies(self):
        live = copy.deepcopy(self.snapshot)
        live["items"][0]["metadata"]["uid"] = "new-owner"
        with self.assertRaisesRegex(ValueError, "cohort_changed_since_snapshot"):
            guard.check_live(self.snapshot, live, "meet", "meet")
        live = copy.deepcopy(self.snapshot)
        live["items"][0]["spec"]["template"]["spec"]["containers"][0]["env"][0][
            "value"
        ] = "False"
        with self.assertRaisesRegex(ValueError, "cohort_rendered_settings_changed"):
            guard.check_render(live["items"], self.snapshot, "meet", "meet")
        with self.assertRaisesRegex(ValueError, "cohort_consumer_settings_drift"):
            guard.check(live, self.values)

    def test_closed_but_configured_pi_still_requires_complete_overlay(self):
        for row in self.snapshot["items"]:
            spec = row["spec"]
            if row["kind"] == "CronJob":
                spec = spec["jobTemplate"]["spec"]
            for entry in spec["template"]["spec"]["containers"][0]["env"]:
                if entry["name"] in guard.FLAGS:
                    entry["value"] = "False"
                if entry["name"] == "WORK_AGENT_ROLLOUT_MODE":
                    entry["value"] = "closed"
        with self.assertRaisesRegex(ValueError, "cohort_complete_overlay_required"):
            guard.check(self.snapshot, None)

    def test_inline_credentials_are_never_exported(self):
        row = self.snapshot["items"][0]
        env = row["spec"]["template"]["spec"]["containers"][0]["env"]
        env[5] = {"name": "WORK_REVIEW_TOKEN", "value": "fixture-never-log"}
        with self.assertRaisesRegex(
            ValueError, "^cohort_inline_credentials_forbidden$"
        ):
            guard.agent_env(row)

    @unittest.skipUnless(shutil.which("helm"), "Helm render opt-in")
    def test_complete_overlay_survives_actual_chart_render(self):
        with tempfile.TemporaryDirectory() as directory:
            values = Path(directory) / "private-values.json"
            values.write_text(json.dumps(self.values), encoding="utf8")
            result = subprocess.run(
                [
                    shutil.which("helm"),
                    "template",
                    "meet",
                    str(Path(__file__).resolve().parents[2] / "src/helm/meet"),
                    "-n",
                    "meet",
                    "-f",
                    str(values),
                    "--set",
                    "aiBackend.enabled=true,workWorker.enabled=true,celeryBeat.enabled=true,backend.docsProfileSync.enabled=true,backend.reminders.enabled=true",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            resources = [v for v in yaml.safe_load_all(result.stdout) if v]
            guard.check_render(resources, self.snapshot, "meet", "meet")


if __name__ == "__main__":
    unittest.main()
