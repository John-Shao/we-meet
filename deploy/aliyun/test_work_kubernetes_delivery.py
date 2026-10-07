"""Offline checks for the independent, namespace-separated K3s agent release."""

import copy
import importlib.util
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "work_agent_check", Path(__file__).with_name("check-work-agent.py")
)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def fixture_values():
    values = yaml.safe_load((ROOT / "src/helm/work-agent-k8s/values.yaml").read_text())
    agent = values["workAgent"]
    agent.update(enabled=True, engine="fixture", testFixtureAcknowledged=True)
    agent["image"] = {
        "repository": "fixture.invalid/gateway",
        "digest": "sha256:" + "a" * 64,
    }
    agent["runtime"]["workerImage"] = "fixture.invalid/worker@sha256:" + "b" * 64
    agent["tasks"].update(
        namespace="fixture-tasks",
        publicCA="-----BEGIN CERTIFICATE-----\npublic-test-placeholder\n-----END CERTIFICATE-----",
        apiServerCIDR="172.16.0.4/32",
    )
    agent["persistence"]["newStateAcknowledged"] = True
    agent["tls"]["existingSecret"] = "fixture-tls"
    agent["secrets"]["gatewaySecret"] = "fixture-token"
    return values


class KubernetesChartTests(unittest.TestCase):
    def test_disabled_release_renders_nothing(self):
        values = fixture_values()
        values["workAgent"]["enabled"] = False
        self.assertEqual(check.render_agent(values, "fixture-agent"), [])

    def test_enabled_release_separates_access_state_and_public_trust(self):
        resources = check.render_agent(fixture_values(), "fixture-agent")
        self.assertFalse(any(row["kind"] == "Secret" for row in resources))
        self.assertFalse(
            any(row["kind"].startswith("ClusterRole") for row in resources)
        )
        role = next(row for row in resources if row["kind"] == "Role")
        self.assertEqual(role["metadata"]["namespace"], "fixture-tasks")
        self.assertEqual(
            role["rules"],
            [
                {
                    "apiGroups": [""],
                    "resources": ["pods"],
                    "verbs": ["create", "get", "list", "delete"],
                }
            ],
        )
        task_sa = next(
            row
            for row in resources
            if row["kind"] == "ServiceAccount"
            and row["metadata"]["namespace"] == "fixture-tasks"
        )
        self.assertFalse(task_sa["automountServiceAccountToken"])
        task_ns = next(row for row in resources if row["kind"] == "Namespace")
        self.assertEqual(
            task_ns["metadata"]["labels"]["pod-security.kubernetes.io/enforce"],
            "restricted",
        )
        pod = next(row for row in resources if row["kind"] == "Deployment")["spec"][
            "template"
        ]["spec"]
        self.assertNotIn("hostNetwork", pod)
        self.assertFalse(any("hostPath" in row for row in pod["volumes"]))
        self.assertTrue(
            pod["containers"][0]["securityContext"]["readOnlyRootFilesystem"]
        )
        self.assertNotIn("docker", str(pod))
        policies = [row for row in resources if row["kind"] == "NetworkPolicy"]
        self.assertEqual(len(policies), 2)
        tasks = next(
            row for row in policies if row["metadata"]["namespace"] == "fixture-tasks"
        )
        self.assertEqual(tasks["spec"]["ingress"], [])
        self.assertEqual(len(tasks["spec"]["egress"]), 2)
        quota = next(row for row in resources if row["kind"] == "ResourceQuota")
        self.assertEqual(quota["spec"]["hard"]["pods"], "2")

    def test_invalid_or_unsafe_release_is_rejected(self):
        for section, key, value in (
            (None, "businessNamespace", "fixture-agent"),
            ("tasks", "namespace", "fixture-agent"),
            ("tasks", "apiServerCIDR", "0.0.0.0/0"),
            ("tasks", "apiServerCIDR", "999.0.0.1/32"),
            ("tasks", "apiServerCIDR", "172.16.0.0/16"),
            ("tasks", "publicCA", "PRIVATE KEY"),
            ("runtime", "workerImage", "worker:latest"),
            ("secrets", "gatewayToken", "literal-credential"),
            ("persistence", "newStateAcknowledged", False),
        ):
            values = copy.deepcopy(fixture_values())
            target = (
                values["workAgent"] if section is None else values["workAgent"][section]
            )
            target[key] = value
            with self.subTest(section=section, key=key), self.assertRaises(ValueError):
                check.render_agent(values, "fixture-agent")

    def test_legacy_literal_credentials_are_not_copied_into_kubernetes_values(self):
        values = fixture_values()
        result = check.scoped_values(
            values,
            {
                "workAgent": {
                    "secrets": {"gatewayToken": "private", "qwenApiKey": "private"}
                }
            },
        )
        self.assertEqual(result, values)

    def test_business_client_references_only_token_and_public_ca(self):
        values = fixture_values()
        agent = values["workAgent"]
        agent["engine"] = "pi"
        agent["secrets"]["clientSecret"] = "fixture-client-token"
        agent["tls"]["clientCASecret"] = "fixture-client-public-ca"
        values["backend"] = {
            "envVars": {
                "WORK_REVIEW_ENABLED": "True",
                "WORK_REVIEW_MODEL": agent["model"],
                "WORK_REVIEW_URL": "https://meet-work-review.fixture-agent.svc.cluster.local:8444",
                "WORK_REVIEW_TOKEN": {
                    "secretKeyRef": {
                        "name": "fixture-client-token",
                        "key": "WORK_AGENT_TOKEN",
                        "optional": False,
                    }
                },
                "WORK_REVIEW_CA_PEM": {
                    "secretKeyRef": {
                        "name": "fixture-client-public-ca",
                        "key": "ca.crt",
                        "optional": False,
                    }
                },
            }
        }
        check.check_client(values, "fixture-agent")
        values["backend"]["envVars"]["WORK_REVIEW_CA_PEM"]["secretKeyRef"]["name"] = (
            "fixture-tls"
        )
        with self.assertRaisesRegex(ValueError, "client_secret_reference_mismatch"):
            check.check_client(values, "fixture-agent")


if __name__ == "__main__":
    unittest.main()
