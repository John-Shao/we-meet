"""Offline acceptance-tool regression; no production DB, model or credentials."""

import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace as NS
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src/backend"))


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit = load("check-work-acceptance")
evaluation = load("eval-work-communication")


class AuditTest(unittest.TestCase):
    def setUp(self):
        self.case = audit.CASES[0]
        _, task_id, run_id, inputs, outputs, sources = self.case
        now = datetime.now(timezone.utc)
        self.task = NS(pk=task_id, owner_id="owner", organization_id=None, sources=[{"id": key} for key in sources])
        self.run = NS(task=self.task, status="succeeded", input_tokens=inputs, output_tokens=outputs,
                      model="qwen3.8-flash", call_started_at=now, finished_at=now, created_at=now, usage_record_id="ledger")
        self.usage = NS(pk="ledger", ref_type="work_run", ref_id=run_id, user_id="owner", organization_id=None,
                        model_code="qwen3.8-flash", input_tokens=inputs, output_tokens=outputs)
        self.material = NS(owner_id="owner", organization_id=None, deleted_at=now, purged_at=now,
                           storage_key="", text="", locations=[], line_count=0)

    def test_matching_receipt_and_null_organization_pass(self):
        self.assertTrue(audit.inspect_run(self.case, self.run, [self.usage])["ok"])
        self.assertTrue(audit.inspect_material(self.case[5][0], self.material, self.task)["ok"])

    def test_missing_or_duplicate_ledger_does_not_pass_on_run_tokens_alone(self):
        for records in ([], [self.usage, copy.copy(self.usage)]):
            self.assertFalse(audit.inspect_run(self.case, self.run, records)["ok"])

    def test_every_ledger_mismatch_fails(self):
        for key, value in (("pk", "different-link"), ("ref_type", "meeting"), ("ref_id", "other-run"),
                           ("user_id", "other-owner"), ("organization_id", "other-org"),
                           ("model_code", "other-model"), ("input_tokens", 0), ("output_tokens", 0)):
            with self.subTest(key=key):
                usage = copy.copy(self.usage)
                setattr(usage, key, value)
                self.assertFalse(audit.inspect_run(self.case, self.run, [usage])["ok"])

    def test_missing_run_or_wrong_sources_or_timing_fails(self):
        self.assertFalse(audit.inspect_run(self.case, None, [self.usage])["ok"])
        self.task.sources = []
        self.assertFalse(audit.inspect_run(self.case, self.run, [self.usage])["ok"])
        self.task.sources = [{"id": key} for key in self.case[5]]
        self.run.call_started_at = None
        self.assertFalse(audit.inspect_run(self.case, self.run, [self.usage])["ok"])

    def test_soft_delete_is_not_purge_and_private_values_are_not_printed(self):
        for key, value in (("deleted_at", None), ("purged_at", None), ("storage_key", "private-object-key"),
                           ("text", "customer-content"), ("locations", ["private-location"]), ("line_count", 1),
                           ("owner_id", "other-owner"), ("organization_id", "other-org")):
            with self.subTest(key=key):
                item = copy.copy(self.material)
                setattr(item, key, value)
                result = audit.inspect_material(self.case[5][0], item, self.task)
                self.assertFalse(result["ok"])
                serialized = json.dumps(result)
                for secret in ("private-object-key", "customer-content", "private-location", "other-owner", "other-org"):
                    self.assertNotIn(secret, serialized)

    def test_missing_material_or_task_fails(self):
        self.assertFalse(audit.inspect_material(self.case[5][0], None, self.task)["ok"])
        self.assertFalse(audit.inspect_material(self.case[5][0], self.material, None)["ok"])


class SemanticTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.update(DJANGO_SETTINGS_MODULE="meet.settings", DJANGO_CONFIGURATION="Test",
                          DJANGO_SECRET_KEY="work-eval-test-only", DATABASE_URL="postgresql://test:test@127.0.0.1:1/test")
        from configurations.importer import install
        install()
        import django
        django.setup()

    def setUp(self):
        self.settings = NS(WORK_MODEL="fixture-model", WORK_MODEL_BASE_URL="https://example.invalid/v1",
                           WORK_MODEL_API_KEY="fixture-secret", WORK_MAX_OUTPUT_TOKENS=3000)

    def output_for(self, case):
        # Deliberately unsupported meaning with an exact valid quote: contract != semantics.
        return {"facts": [{"text": "预算已获批准", "source_id": "00000000-0000-4000-8000-000000000001",
                            "line": 1, "quote": case["materials"][0].splitlines()[0]}],
                "agenda": [], "questions": [], "talking_points": [], "missing_information": []}

    def generate(self, case, usage=True, raw=None):
        def fake(run, prompt, sink):
            self.assertLessEqual(run.max_output_tokens, 1600)
            if usage:
                sink(input_tokens=100, output_tokens=80)
            return json.dumps(self.output_for(case)) if raw is None else raw
        with patch("work.executor.CommunicationExecutor.generate", side_effect=fake) as mock:
            result = evaluation.evaluate_case(case, self.settings)
        mock.assert_called_once()
        return result

    def test_all_twenty_cases_fit_actual_prompt_and_validator(self):
        from work.executor import prompt_for
        self.assertEqual([case["id"] for case in evaluation.CASES], [f"S{i:02}" for i in range(1, 21)])
        for case in evaluation.CASES:
            with self.subTest(case=case["id"]):
                prompt_for(NS(recipient="test", goal=case["goal"], background=case.get("background", "")), evaluation.make_materials(case))
                result = self.generate(case)
                self.assertTrue(result["contract_ok"])
                self.assertIsNone(result["semantic_passed"])
                self.assertEqual(result["review_status"], "pending")
                self.assertTrue(all(value is None for value in result["review"].values()))

    def test_missing_usage_and_invalid_quote_or_json_fail(self):
        case = evaluation.CASES[0]
        self.assertFalse(self.generate(case, usage=False)["contract_ok"])
        self.assertEqual(self.generate(case, raw="{")["code"], "invalid_model_output")
        output = self.output_for(case)
        output["facts"][0]["quote"] = "source does not contain this"
        self.assertEqual(self.generate(case, raw=json.dumps(output))["code"], "invalid_citation")

    def test_provider_error_is_redacted(self):
        with patch("work.executor.CommunicationExecutor.generate", side_effect=RuntimeError("fixture-secret signed-url")):
            result = evaluation.evaluate_case(evaluation.CASES[0], self.settings)
        self.assertEqual(result["code"], "model_call_failed")
        self.assertNotIn("fixture-secret", json.dumps(result))
        self.assertNotIn("signed-url", json.dumps(result))

    def test_catalog_does_not_import_django_or_call_model(self):
        result = subprocess.run([sys.executable, str(Path(evaluation.__file__)), "--case", "S01"],
                                capture_output=True, text=True, check=True)
        data = json.loads(result.stdout)
        self.assertEqual(data["model_calls"], 0)
        self.assertEqual(len(data["cases"]), 1)

    def test_execute_fails_fast_and_keeps_pending_semantic_gate(self):
        from django.test import override_settings
        output = io.StringIO()
        result = {"contract_ok": False, "input_tokens": 5, "output_tokens": 0}
        with override_settings(**vars(self.settings)), contextlib.redirect_stdout(output), \
                patch.object(evaluation, "evaluate_case", return_value=result) as mock:
            self.assertEqual(evaluation.main(["--execute"]), 1)
        mock.assert_called_once()
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(rows[-1]["completed_cases"], 1)
        self.assertFalse(rows[-1]["release_gate_passed"])
        self.assertIsNone(rows[-1]["semantic_passed"])

    def test_duplicate_case_selection_does_not_repeat_paid_calls(self):
        from django.test import override_settings
        with override_settings(**vars(self.settings)), contextlib.redirect_stdout(io.StringIO()), \
                patch.object(evaluation, "evaluate_case", return_value={"contract_ok": True}) as mock:
            self.assertEqual(evaluation.main(["--execute", "--case", "S01", "--case", "S01"]), 0)
        mock.assert_called_once()


@unittest.skipUnless(os.environ.get("BASH_BIN") or shutil.which("bash"), "Bash required")
class ShellTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="we-meet-work-acceptance-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        deploy = self.root / "deploy/aliyun"
        deploy.mkdir(parents=True)
        for name in ("accept-work.sh", "check-work-acceptance.py", "eval-work-communication.py"):
            shutil.copyfile(Path(__file__).with_name(name), deploy / name)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "commit", "--allow-empty", "-qm", "fixture"], check=True)
        binary = self.root / "bin"
        binary.mkdir()
        kubectl = binary / "kubectl"
        kubectl.write_text('#!/usr/bin/env bash\n'
                           'echo "$*" >> "$FAKE_KUBE_LOG"\n'
                           'case "$*" in\n'
                           '  *" get deployment "*) echo "fixture image:123" ;;\n'
                           '  *" exec -i "*) cat >/dev/null; echo \'{"fixture":true}\'; exit "${FAKE_FAIL:-0}" ;;\n'
                           '  *) exit 88 ;;\n'
                           'esac\n', encoding="utf8")
        kubectl.chmod(0o755)
        self.env = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                    "FAKE_KUBE_LOG": (self.root / "kubectl.log").as_posix()}

    def call(self, *args):
        return subprocess.run([os.environ.get("BASH_BIN") or shutil.which("bash"),
                               (self.root / "deploy/aliyun/accept-work.sh").as_posix(), *args],
                              env=self.env, capture_output=True, text=True)

    def test_audit_targets_backend_and_saves_receipt(self):
        result = self.call("audit")
        self.assertEqual(result.returncode, 0, result.stderr)
        log = (self.root / "kubectl.log").read_text()
        self.assertIn("exec -i deployment/meet-backend -- python -", log)
        receipts = list((self.root / ".work-acceptance").glob("*/results.jsonl"))
        self.assertEqual(len(receipts), 1)
        self.assertEqual(json.loads(receipts[0].read_text()), {"fixture": True})

    def test_evaluate_targets_worker_and_failure_retains_partial_evidence(self):
        self.env["FAKE_FAIL"] = "1"
        result = self.call("evaluate", "--case", "S01")
        self.assertNotEqual(result.returncode, 0)
        log = (self.root / "kubectl.log").read_text()
        self.assertIn("exec -i deployment/meet-celery-work -- python - --execute --case S01", log)
        self.assertEqual(log.count("exec -i"), 1)
        self.assertEqual(len(list((self.root / ".work-acceptance").glob("*/results.jsonl"))), 1)

    def test_catalog_cannot_be_escalated_to_execute(self):
        for args in (("catalog", "--execute"), ("evaluate", "--case", "S21"), ("audit", "extra")):
            with self.subTest(args=args):
                self.assertEqual(self.call(*args).returncode, 2)
        self.assertFalse((self.root / "kubectl.log").exists())


if __name__ == "__main__":
    unittest.main()
