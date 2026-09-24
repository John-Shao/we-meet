"""Offline acceptance-tool regression; no production DB, model or credentials."""

import contextlib
import base64
import copy
import hashlib
import inspect
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
    def test_v6_artifacts_require_matching_run_body_version_and_adoption(self):
        run = NS(executor_version="communication-v6")
        versions = [NS(run_id=audit.V6_CASE[2], version=i + 1, body=str(i), adopted_at=True) for i in range(2)]
        hashes = [hashlib.sha256(item.body.encode()).hexdigest() for item in versions]
        with patch.object(audit, "V6_ARTIFACT_HASHES", hashes):
            self.assertTrue(all(audit.inspect_v6_artifacts(run, versions).values()))
            for key, value in (("body", "changed"), ("version", 1), ("run_id", "other"), ("adopted_at", None)):
                changed = copy.deepcopy(versions)
                setattr(changed[1], key, value)
                self.assertFalse(all(audit.inspect_v6_artifacts(run, changed).values()))
            for items in ([], versions[:1], versions + [versions[1]]):
                self.assertFalse(all(audit.inspect_v6_artifacts(run, items).values()))
            self.assertFalse(all(audit.inspect_v6_artifacts(NS(executor_version="communication-v3"), versions).values()))
            self.assertFalse(all(audit.inspect_v6_artifacts(None, versions).values()))

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
    def test_v6_executor_check_rejects_changed_prompt_or_version_without_model_calls(self):
        with patch("work.executor.CommunicationExecutor.generate", side_effect=AssertionError("must not call model")):
            self.assertTrue(audit.audit_v6(executor_only=True)["ok"])
            with patch("work.executor.EXECUTOR_VERSION", "communication-v3"):
                self.assertFalse(audit.audit_v6(executor_only=True)["ok"])
            with patch("work.executor.SYSTEM", "changed"):
                self.assertFalse(audit.audit_v6()["ok"])

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

    def test_invalid_citation_keeps_bounded_synthetic_diagnostics_but_never_passes(self):
        case = evaluation.CASES[-1]
        for field, value, reason in (("source_id", "unknown", "source_not_found"),
                                     ("line", 2, "line_out_of_range"),
                                     ("quote", " ", "empty_quote"),
                                     ("quote", "not a source quote", "quote_not_on_line")):
            with self.subTest(reason=reason):
                output = self.output_for(case)
                output["facts"][0][field] = value
                result = self.generate(case, raw=json.dumps(output))
                self.assertFalse(result["contract_ok"])
                self.assertIsNone(result["semantic_passed"])
                self.assertEqual(result["output_status"], "rejected")
                self.assertEqual(result["rejected_output"], output)
                self.assertNotIn("output", result)
                self.assertEqual(result["citation_diagnostics"], [{"fact_index": 1, "reason": reason}])

    def test_invalid_schema_does_not_emit_unbounded_rejected_response(self):
        for raw in ('{', json.dumps({"unexpected": "x" * 50000})):
            result = self.generate(evaluation.CASES[-1], raw=raw)
            self.assertEqual(result["code"], "invalid_model_output")
            self.assertNotIn("rejected_output", result)

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

    def test_stale_deployed_prompt_blocks_all_paid_calls(self):
        from django.test import override_settings
        output = io.StringIO()
        with override_settings(**vars(self.settings)), contextlib.redirect_stdout(output), \
                patch.object(evaluation, "evaluate_case") as mock:
            self.assertEqual(evaluation.main(["--execute", "--expected-system-hash", "old-prompt"]), 1)
        mock.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())["code"], "deployed_prompt_mismatch")

    def test_candidate_runs_only_in_test_process_and_restores_deployed_prompt(self):
        from django.test import override_settings
        from work import executor
        original = executor.SYSTEM
        proposed = original + "\nCandidate fixture."
        profile = {"system": proposed, "version": "candidate-fixture", "adapter_hash": evaluation.adapter_hash(inspect.getsource(executor))}
        encoded = base64.b64encode(json.dumps(profile).encode()).decode()
        output = io.StringIO()
        def collect(case, settings):
            self.assertEqual(executor.SYSTEM, proposed)
            return {"contract_ok": True}
        with override_settings(**vars(self.settings)), contextlib.redirect_stdout(output), \
                patch.object(evaluation, "evaluate_case", side_effect=collect) as mock:
            self.assertEqual(evaluation.main(["--execute", "--case", "S01", "--candidate-profile", encoded]), 0)
        mock.assert_called_once()
        self.assertEqual(executor.SYSTEM, original)
        start = json.loads(output.getvalue().splitlines()[0])
        self.assertEqual(start["evaluation_mode"], "candidate")
        self.assertEqual(start["executor_version"], "candidate-fixture")
        self.assertEqual(start["deployed_system_hash"], hashlib.sha256(original.encode()).hexdigest())
        self.assertNotEqual(start["system_hash"], start["deployed_system_hash"])

    def test_adapter_fingerprint_excludes_only_prompt_and_version(self):
        base = 'SYSTEM = "old"\nEXECUTOR_VERSION = "v1"\nLIMIT = 12\n'
        self.assertEqual(evaluation.adapter_hash(base), evaluation.adapter_hash(base.replace('"old"', '"new"').replace('"v1"', '"v2"')))
        self.assertNotEqual(evaluation.adapter_hash(base), evaluation.adapter_hash(base.replace('12', '24')))

    def test_adapter_fingerprint_is_source_based_and_preserves_adjacent_code(self):
        source = 'SYSTEM = """中文\n提示词"""; LIMIT = 12\nEXECUTOR_VERSION = "v1"\ndef run():\n    return LIMIT\n'
        expected = hashlib.sha256(b'; LIMIT = 12\n\ndef run():\n    return LIMIT\n').hexdigest()
        with patch.object(evaluation.ast, "dump", side_effect=AssertionError("version-dependent AST dump")):
            self.assertEqual(evaluation.adapter_hash(source), expected)
            self.assertEqual(evaluation.adapter_hash(source.replace('\n', '\r\n')), expected)
            self.assertEqual(evaluation.adapter_hash(source.replace('中文\n提示词', 'new')), expected)
            self.assertNotEqual(evaluation.adapter_hash(source.replace('LIMIT = 12', 'LIMIT = 13')), expected)

    def test_candidate_with_different_adapter_or_invalid_profile_never_calls_model(self):
        from django.test import override_settings
        from work import executor
        original = executor.SYSTEM
        for profile in ({"system": "candidate", "version": "v3", "adapter_hash": "wrong"}, {"system": "candidate"}, []):
            encoded = base64.b64encode(json.dumps(profile).encode()).decode()
            with self.subTest(profile=profile), override_settings(**vars(self.settings)), \
                    contextlib.redirect_stdout(io.StringIO()), patch.object(evaluation, "evaluate_case") as mock:
                self.assertEqual(evaluation.main(["--execute", "--candidate-profile", encoded]), 1)
            mock.assert_not_called()
            self.assertEqual(executor.SYSTEM, original)


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
        source = self.root / "src/backend/work"
        source.mkdir(parents=True)
        (source / "executor.py").write_text('SYSTEM = "fixture prompt"\nEXECUTOR_VERSION = "fixture-v3"\n', encoding="utf8")
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "commit", "--allow-empty", "-qm", "fixture"], check=True)
        binary = self.root / "bin"
        binary.mkdir()
        python = binary / "python3"
        python.write_text('#!/usr/bin/env bash\nexec "$WORK_EVAL_PYTHON" "$@"\n', encoding="utf8")
        python.chmod(0o755)
        kubectl = binary / "kubectl"
        kubectl.write_text('#!/usr/bin/env bash\n'
                           'echo "$*" >> "$FAKE_KUBE_LOG"\n'
                           'if [[ "$*" == *"v6-executor"* && "${FAKE_WORKER_FAIL:-0}" == 1 ]]; then cat >/dev/null; echo \'{"ok":false}\'; exit 1; fi\n'
                           'case "$*" in\n'
                           '  *" get deployment "*) echo "fixture image:123" ;;\n'
                           '  *" exec -i "*) cat >/dev/null; echo \'{"fixture":true}\'; exit "${FAKE_FAIL:-0}" ;;\n'
                           '  *) exit 88 ;;\n'
                           'esac\n', encoding="utf8")
        kubectl.chmod(0o755)
        self.env = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                    "WORK_EVAL_PYTHON": Path(sys.executable).as_posix(),
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

    def test_v6_audit_checks_backend_business_and_worker_executor(self):
        result = self.call("audit-v6")
        self.assertEqual(result.returncode, 0, result.stderr)
        log = (self.root / "kubectl.log").read_text()
        self.assertIn("deployment/meet-backend -- python - --mode v6", log)
        self.assertIn("deployment/meet-celery-work -- python - --mode v6-executor", log)
        self.assertEqual(log.count("exec -i"), 2)
        receipt = next((self.root / ".work-acceptance").glob("*/results.jsonl"))
        self.assertEqual(len(receipt.read_text().splitlines()), 2)
        self.assertNotIn("paid calls", result.stdout)

    def test_v6_audit_stops_on_backend_failure_and_retains_evidence(self):
        self.env["FAKE_FAIL"] = "1"
        self.assertNotEqual(self.call("audit-v6").returncode, 0)
        log = (self.root / "kubectl.log").read_text()
        self.assertEqual(log.count("exec -i"), 1)
        self.assertTrue(list((self.root / ".work-acceptance").glob("*/results.jsonl")))

    def test_v6_audit_does_not_hide_worker_failure_after_backend_pass(self):
        self.env["FAKE_WORKER_FAIL"] = "1"
        self.assertNotEqual(self.call("audit-v6").returncode, 0)
        receipt = next((self.root / ".work-acceptance").glob("*/results.jsonl"))
        self.assertEqual(json.loads(receipt.read_text().splitlines()[-1]), {"ok": False})

    def test_evaluate_targets_worker_and_failure_retains_partial_evidence(self):
        self.env["FAKE_FAIL"] = "1"
        result = self.call("evaluate", "--case", "S01")
        self.assertNotEqual(result.returncode, 0)
        log = (self.root / "kubectl.log").read_text()
        expected = hashlib.sha256(b"fixture prompt").hexdigest()
        self.assertIn(f"exec -i deployment/meet-celery-work -- python - --execute --expected-system-hash {expected} --case S01", log)
        self.assertEqual(log.count("exec -i"), 1)
        self.assertEqual(len(list((self.root / ".work-acceptance").glob("*/results.jsonl"))), 1)

    def test_catalog_cannot_be_escalated_to_execute(self):
        for args in (("catalog", "--execute"), ("evaluate", "--case", "S21"), ("audit", "extra"), ("audit-v6", "extra")):
            with self.subTest(args=args):
                self.assertEqual(self.call(*args).returncode, 2)
        self.assertFalse((self.root / "kubectl.log").exists())

    def test_candidate_mode_passes_literal_profile_without_deployment_commands(self):
        result = self.call("evaluate-candidate", "--case", "S01")
        self.assertEqual(result.returncode, 0, result.stderr)
        log = (self.root / "kubectl.log").read_text()
        self.assertIn("exec -i deployment/meet-celery-work", log)
        encoded = log.split("--candidate-profile ")[1].strip()
        profile = json.loads(base64.b64decode(encoded))
        self.assertEqual(profile["system"], "fixture prompt")
        self.assertEqual(profile["version"], "fixture-v3")
        self.assertNotIn("apply", log)


if __name__ == "__main__":
    unittest.main()
