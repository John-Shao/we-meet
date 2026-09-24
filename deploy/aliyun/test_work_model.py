"""Offline tests of Work model rollout gates; no provider or database access."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src/backend"))


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


overlay = load("configure-work-overlay")
probe = load("check-work-model")
runtime = load("check-work-runtime")
PROFILE = yaml.safe_load((ROOT / "src/helm/env.d/aliyun-prod/values.work.yaml.dist").read_text(encoding="utf8"))


class OverlayTest(unittest.TestCase):
    def test_partial_config_does_not_mix_providers(self):
        for key in overlay.MODEL_KEYS:
            original = {"backend": {"envVars": {key: "custom-provider"}}}
            with self.assertRaises(ValueError):
                overlay.configure(original, "prepare-communication", PROFILE["backend"]["envVars"])
            self.assertEqual(original["backend"]["envVars"], {key: "custom-provider"})

    def test_prepare_preserves_complete_custom_profile_and_other_settings(self):
        original = copy.deepcopy(PROFILE)
        original["backend"]["envVars"].update(WORK_MODEL="custom-model", WORK_MODEL_BASE_URL="https://example.invalid/v1",
                                             WORK_MODEL_API_KEY={"secretKeyRef": {"name": "custom-secret", "key": "token"}},
                                             WORK_DAILY_TOKEN_BUDGET="50000", UNRELATED="retained")
        expected = copy.deepcopy(original)
        result = overlay.configure(original, "prepare-communication", PROFILE["backend"]["envVars"])
        self.assertEqual(result, expected)
        self.assertEqual(original, expected)

    def test_plaintext_or_incomplete_secret_not_accepted(self):
        for value in ("secret-do-not-print", {"secretKeyRef": {"name": "missing-key"}}, {"secretKeyRef": {"name": "n", "key": " "}}):
            original = copy.deepcopy(PROFILE)
            original["backend"]["envVars"]["WORK_MODEL_API_KEY"] = value
            with self.assertRaises(ValueError):
                overlay.configure(original, "communication", {})

    def test_rolling_or_mismatched_worker_blocks_enable(self):
        entries = [{"name": key, "valueFrom" if isinstance(value, dict) else "value": value}
                   for key, value in PROFILE["backend"]["envVars"].items()]
        item = {"metadata": {"generation": 2}, "spec": {"replicas": 1, "template": {"spec": {"containers": [{"env": entries}]}}},
                "status": {"observedGeneration": 2, "replicas": 1, "updatedReplicas": 1, "availableReplicas": 1}}
        overlay.check_deployed(PROFILE, {"items": [item, copy.deepcopy(item)]})
        for field, value in (("observedGeneration", 1), ("updatedReplicas", 0), ("availableReplicas", 0), ("replicas", 2)):
            worker = copy.deepcopy(item)
            worker["status"][field] = value
            with self.assertRaises(ValueError):
                overlay.check_deployed(PROFILE, {"items": [item, worker]})
        worker = copy.deepcopy(item)
        worker["spec"]["template"]["spec"]["containers"][0]["env"] = []
        with self.assertRaises(ValueError):
            overlay.check_deployed(PROFILE, {"items": [item, worker]})


class ModelProbeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Explicit test settings, unreachable database; this suite never uses ORM.
        os.environ.update(DJANGO_SETTINGS_MODULE="meet.settings", DJANGO_CONFIGURATION="Test",
                          DJANGO_SECRET_KEY="work-probe-test-only", DATABASE_URL="postgresql://test:test@127.0.0.1:1/test")
        from configurations.importer import install
        install()
        import django
        django.setup()

    def setUp(self):
        self.settings = SimpleNamespace(WORK_MODEL="test-model", WORK_MODEL_BASE_URL="https://example.invalid/v1",
                                        WORK_MODEL_API_KEY="fixture-secret", WORK_MAX_OUTPUT_TOKENS=3000)
        self.output = {"facts": [{"text": "预算尚未确认", "source_id": "00000000-0000-4000-8000-000000000001",
                                  "line": 2, "quote": "预算尚未确认"}],
                       "agenda": ["建议核对演示安排"], "questions": ["建议询问预算"],
                       "talking_points": ["建议双方核对范围"], "missing_information": ["预算待确认"]}

    def execute(self, usage=True, raw=None):
        def generate(run, prompt, sink):
            self.assertLessEqual(run.max_output_tokens, 1200)
            self.assertEqual(json.loads(prompt)["materials"][0]["name"], "合成验收材料.txt")
            if usage:
                sink(model_code="test-model", input_tokens=120, output_tokens=80)
            return json.dumps(self.output) if raw is None else raw
        with patch("work.executor.CommunicationExecutor.generate", side_effect=generate) as mocked:
            result = probe.probe_model(self.settings)
        mocked.assert_called_once()
        self.assertNotIn("fixture-secret", json.dumps(result))
        return result

    def test_real_validator_and_usage_pass_without_business_acceptance_claim(self):
        result = self.execute()
        self.assertTrue(result["ok"])
        self.assertEqual(result["citation_count"], 1)
        self.assertEqual(result["input_tokens"], 120)
        self.assertFalse(result["business_acceptance"])

    def test_missing_usage_blocks_enable(self):
        self.assertEqual(self.execute(usage=False)["code"], "provider_usage_missing")

    def test_invalid_json_or_truncated_completion_blocks_enable(self):
        self.assertEqual(self.execute(raw='{"facts": [')["code"], "invalid_model_output")

    def test_fabricated_quote_blocks_enable(self):
        self.output["facts"][0]["quote"] = "预算已获批准"
        self.assertEqual(self.execute()["code"], "invalid_citation")

    def test_missing_sources_blocks_enable(self):
        self.output["facts"] = []
        self.assertEqual(self.execute()["code"], "probe_content_incomplete")

    def test_missing_configuration_does_not_call_provider(self):
        self.settings.WORK_MODEL_API_KEY = ""
        with patch("work.executor.CommunicationExecutor.generate") as mocked:
            result = probe.probe_model(self.settings)
        mocked.assert_not_called()
        self.assertEqual(result["code"], "work_model_not_configured")

    def test_provider_exception_text_is_not_disclosed(self):
        with patch("work.executor.CommunicationExecutor.generate", side_effect=RuntimeError("private-key signed-url")):
            result = probe.probe_model(self.settings)
        self.assertFalse(result["ok"])
        self.assertNotIn("private-key", json.dumps(result))
        self.assertEqual(result["error_type"], "OtherError")

    def test_runtime_require_model_and_generation_fail_closed(self):
        from django.conf import settings
        from unittest.mock import Mock

        migration = Mock()
        migration.loader.graph.leaf_nodes.return_value = [("work", "fixture")]
        migration.migration_plan.return_value = []
        storage = SimpleNamespace(client_config=None, bucket_name="fixture", endpoint_url="fixture",
                                  access_key="fixture", secret_key="fixture")
        with (patch("django.db.migrations.executor.MigrationExecutor", return_value=migration),
              patch("meet.celery_app.app.control.inspect") as inspect,
              patch("work.storage.material_storage", return_value=storage),
              patch.object(settings, "WORK_ENABLED", True),
              patch.object(settings, "WORK_MATERIALS_ENABLED", True),
              patch.object(settings, "WORK_COMMUNICATION_ENABLED", False),
              patch.object(settings, "WORK_MODEL", "fixture-model"),
              patch.object(settings, "WORK_MODEL_BASE_URL", "https://example.invalid/v1"),
              patch.object(settings, "WORK_MODEL_API_KEY", "")):
            inspect.return_value.active_queues.return_value = {"work@fixture": [{"name": "work"}]}
            self.assertTrue(runtime.inspect_runtime()["ok"])
            self.assertFalse(runtime.inspect_runtime(require_model=True)["ok"])
            with patch.object(settings, "WORK_MODEL_API_KEY", "fixture"):
                self.assertTrue(runtime.inspect_runtime(require_model=True)["ok"])
                self.assertFalse(runtime.inspect_runtime(require_communication=True)["ok"])
                with patch.object(settings, "WORK_COMMUNICATION_ENABLED", True):
                    self.assertTrue(runtime.inspect_runtime(require_communication=True)["ok"])


if __name__ == "__main__":
    unittest.main()
