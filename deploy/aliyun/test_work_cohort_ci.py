"""Offline Helm contract for the private Work cohort release overlay."""

import shutil
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


class WorkCohortChartTests(unittest.TestCase):
    def test_closed_cohort_overlay_reaches_every_backend_consumer(self):
        result = subprocess.run(
            [
                shutil.which("helm"),
                "template",
                "meet",
                str(ROOT / "src/helm/meet"),
                "-f",
                str(ROOT / "src/helm/env.d/aliyun-prod/values.work-cohort.yaml.dist"),
                "--set",
                "aiBackend.enabled=true,workWorker.enabled=true,celeryBeat.enabled=true,backend.docsProfileSync.enabled=true,backend.reminders.enabled=true",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        count = 0
        for row in yaml.safe_load_all(result.stdout):
            if not row or row["kind"] not in ("Deployment", "CronJob", "Job"):
                continue
            spec = row["spec"]
            if row["kind"] == "CronJob":
                spec = spec["jobTemplate"]["spec"]
            env = {
                item["name"]: item.get("value")
                for item in (spec["template"]["spec"]["containers"][0].get("env") or [])
            }
            if "WORK_AGENT_ROLLOUT_MODE" not in env:
                continue
            self.assertEqual(env["WORK_AGENT_ROLLOUT_MODE"], "closed")
            self.assertEqual(env["WORK_AGENT_ALLOWED_USER_IDS"], "")
            for flag in (
                "WORK_AGENT_ENABLED",
                "WORK_LOCAL_AGENT_ENABLED",
                "WORK_REMOTE_AGENT_ENABLED",
                "WORK_REVIEW_ENABLED",
            ):
                self.assertEqual(env[flag], "False")
            count += 1
        self.assertEqual(count, 9)


if __name__ == "__main__":
    unittest.main()
