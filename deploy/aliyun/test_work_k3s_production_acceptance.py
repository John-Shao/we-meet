import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "acceptance", Path(__file__).with_name("accept-work-k3s-production.py")
)
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


class ProductionAcceptanceTests(unittest.TestCase):
    def test_task_probe_has_no_client_or_provider_secret(self):
        pod = acceptance.pod(
            "fixed", "meet-work-review-tasks", "repo@sha256:abc", "marker", task=True
        )
        self.assertFalse(pod["spec"]["automountServiceAccountToken"])
        self.assertEqual(
            pod["spec"]["volumes"],
            [{"name": "ca", "configMap": {"name": "work-agent-ca"}}],
        )
        self.assertEqual(
            pod["spec"]["imagePullSecrets"], [{"name": "work-agent-registry"}]
        )
        resources = pod["spec"]["containers"][0]["resources"]
        self.assertIn("ephemeral-storage", resources["requests"])
        self.assertIn("ephemeral-storage", resources["limits"])

    def test_business_probe_uses_correct_secret_volume_field(self):
        pod = acceptance.pod("fixed", "meet", "repo@sha256:abc", "marker", client=True)
        self.assertEqual(
            pod["spec"]["volumes"][0]["secret"],
            {"secretName": "meet-work-review-client-ca"},
        )
        self.assertEqual(
            pod["spec"]["volumes"][1]["secret"],
            {"secretName": "meet-work-review-client"},
        )

    def test_synthetic_requests_bound_one_call_and_no_user_files(self):
        denied = acceptance.request("synthetic", budget=True)
        self.assertEqual(denied["limits"]["max_model_calls"], 1)
        self.assertEqual(denied["limits"]["max_total_tokens"], 1)
        self.assertEqual(denied["files"], [])
        paid = acceptance.request("synthetic", "2 + 2 = 4")
        self.assertEqual(paid["limits"]["max_output_tokens"], 4096)
        self.assertEqual(paid["limits"]["max_model_calls"], 1)

    def test_cleanup_refuses_changed_uid(self):
        item = {"name": "fixed", "namespace": "ns", "uid": "mine"}
        changed = {"metadata": {"uid": "other", "labels": {acceptance.OWNER: "marker"}}}
        with patch.object(acceptance, "api", return_value=changed):
            with patch.object(acceptance, "run") as run:
                with self.assertRaisesRegex(
                    acceptance.AcceptanceError, "cleanup_ownership_mismatch"
                ):
                    acceptance.cleanup(item, "marker")
                run.assert_not_called()

    def test_submit_has_no_implicit_post_retry(self):
        body = acceptance.request("synthetic")
        with patch.object(acceptance, "call", side_effect=TimeoutError) as call:
            with self.assertRaises(TimeoutError):
                acceptance.submit({}, body)
        self.assertEqual(call.call_count, 1)


if __name__ == "__main__":
    unittest.main()
