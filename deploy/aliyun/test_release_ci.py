"""No GitHub calls: validate fail-closed CI evidence selection."""

import importlib.util
import pathlib
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release_ci", pathlib.Path(__file__).with_name("check-release-ci.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)

SHA = "a" * 40
REPO = "example/meet"


def run(**changes):
    return {"id": 12, "run_attempt": 2, "head_sha": SHA, "event": "push",
            "head_repository": {"full_name": REPO}, "status": "completed",
            "conclusion": "success", **changes}


def jobs():
    return {"jobs": [dict(name=name, status="completed", conclusion="success", head_sha=SHA, run_id=12)
                     for name in ci.REQUIRED_JOBS]}


class ReleaseCITest(unittest.TestCase):
    def test_remote_repo_is_derived_from_origin(self):
        for origin in ("https://github.com/example/meet.git", "git@github.com:example/meet.git"):
            self.assertEqual(ci.repository(origin), REPO)
        with self.assertRaises(ci.CheckFailed):
            ci.repository("https://github.com.attacker.invalid/example/meet")

    def test_exact_sha_and_attempt_are_verified(self):
        with patch.object(ci, "api", side_effect=[{"workflow_runs": [run()]}, jobs()]) as api:
            self.assertIn("/12/attempts/2", ci.verify(REPO, SHA))
        self.assertIn(f"head_sha={SHA}", api.call_args_list[0].args[0])
        self.assertIn("/12/attempts/2/jobs", api.call_args_list[1].args[0])

    def test_failed_newer_run_cannot_fall_back_to_older_success(self):
        for status, conclusion in (("completed", "failure"), ("in_progress", None)):
            with self.subTest(status=status):
                with patch.object(ci, "api", return_value={"workflow_runs": [run(id=13, status=status, conclusion=conclusion), run()]}):
                    with self.assertRaises(ci.CheckFailed):
                        ci.verify(REPO, SHA)

    def test_missing_wrong_sha_fork_and_pr_runs_are_rejected(self):
        for candidates in ([], [run(head_sha="b" * 40)], [run(event="pull_request")], [run(head_repository={"full_name": "fork/meet"})]):
            with self.subTest(candidates=candidates):
                with patch.object(ci, "api", return_value={"workflow_runs": candidates}):
                    with self.assertRaises(ci.CheckFailed):
                        ci.verify(REPO, SHA)

    def test_required_job_must_succeed_in_current_attempt(self):
        for changes in ({"conclusion": "skipped"}, {"head_sha": "b" * 40}, {"run_attempt": 1}, {"run_id": 13}, {"status": "in_progress"}):
            evidence = jobs()
            evidence["jobs"][0].update(changes)
            with self.subTest(changes=changes):
                with patch.object(ci, "api", side_effect=[{"workflow_runs": [run()]}, evidence]):
                    with self.assertRaises(ci.CheckFailed):
                        ci.verify(REPO, SHA)

    def test_absent_required_jobs_rejected(self):
        with patch.object(ci, "api", side_effect=[{"workflow_runs": [run()]}, {"jobs": []}]):
            with self.assertRaises(ci.CheckFailed):
                ci.verify(REPO, SHA)

    def test_transport_failure_does_not_expose_command_output(self):
        result = subprocess.CompletedProcess(["gh"], 1, stdout="fixture-secret", stderr="fixture-secret")
        with patch.object(ci.subprocess, "run", return_value=result):
            with self.assertRaises(ci.CheckFailed) as error:
                ci.api("repos/example/meet/actions/runs")
        self.assertNotIn("fixture-secret", str(error.exception))

    def test_non_json_response_fails_closed(self):
        result = subprocess.CompletedProcess(["gh"], 0, stdout="not JSON", stderr="")
        with patch.object(ci.subprocess, "run", return_value=result):
            with self.assertRaises(ci.CheckFailed):
                ci.api("repos/example/meet/actions/runs")


if __name__ == "__main__":
    unittest.main()
