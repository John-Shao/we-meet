"""Shared-node capacity/PID fail-closed checks and read-only command boundaries."""

import copy
import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "k3s_preflight", Path(__file__).with_name("preflight-work-k3s.py")
)
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class Inventory:
    def __init__(self):
        self.calls = []
        self.limit = 512
        self.namespaces = {
            "items": [
                {
                    "metadata": {
                        "name": name,
                        "labels": {"pod-security.kubernetes.io/enforce": "restricted"},
                    },
                    "status": {"phase": "Active"},
                }
                for name in ("gateway", "tasks", "meet")
            ]
        }
        self.node = {
            "metadata": {"name": "shared-node"},
            "status": {
                "conditions": [{"type": "Ready", "status": "True"}],
                "allocatable": {"cpu": "4"},
            },
        }
        self.pods = {
            "items": [
                {
                    "spec": {
                        "nodeName": "shared-node",
                        "containers": [{"resources": {"requests": {"cpu": "3600m"}}}],
                    },
                    "status": {"phase": "Running"},
                }
            ]
        }

    def inventory(self, kind):
        self.calls.append(kind)
        return {
            "nodes": {"items": [self.node]},
            "pods": self.pods,
            "namespaces": self.namespaces,
        }[kind]

    def kubelet(self, node):
        self.calls.append("configz")
        return {"kubeletconfig": {"podPidsLimit": self.limit}}


class SharedNodePreflightTests(unittest.TestCase):
    def test_structural_pass_never_claims_production_deployment_ready(self):
        reader = Inventory()
        report = preflight.preflight(reader, "gateway", "tasks")
        self.assertTrue(report["passed"])
        self.assertFalse(report["deployment_ready"])
        self.assertFalse(report["deployment_performed"])
        self.assertFalse(report["secrets_read"])
        self.assertEqual(report["cpu"]["conservative_existing_requests_m"], 3600)
        self.assertEqual(set(reader.calls), {"nodes", "pods", "namespaces", "configz"})

    def test_unlimited_unknown_or_wide_pid_budget_fails_closed(self):
        for limit in (-1, 0, 513, None, "512", True):
            reader = Inventory()
            reader.limit = limit
            with self.subTest(limit=limit):
                report = preflight.preflight(reader, "gateway", "tasks")
                self.assertFalse(report["passed"])
                self.assertIn("bounded_pod_pids_required", str(report))

    def test_capacity_includes_init_overhead_and_ignores_terminal_other_node(self):
        reader = Inventory()
        pod = reader.pods["items"][0]
        pod["spec"]["initContainers"] = [{"resources": {"requests": {"cpu": "150m"}}}]
        pod["spec"]["overhead"] = {"cpu": "51m"}
        other = copy.deepcopy(pod)
        other["spec"]["nodeName"] = "other-node"
        terminal = copy.deepcopy(pod)
        terminal["status"]["phase"] = "Succeeded"
        reader.pods["items"] += [other, terminal]
        report = preflight.preflight(reader, "gateway", "tasks")
        self.assertEqual(report["cpu"]["conservative_existing_requests_m"], 3801)
        self.assertFalse(report["passed"])

    def test_missing_namespace_restricted_policy_pressure_and_unreadable_api_fail(self):
        for mutate in (
            lambda reader: reader.namespaces["items"].pop(),
            lambda reader: reader.namespaces["items"][1]["metadata"]["labels"].clear(),
            lambda reader: reader.node["status"]["conditions"].append(
                {"type": "PIDPressure", "status": "True"}
            ),
        ):
            reader = Inventory()
            mutate(reader)
            self.assertFalse(preflight.preflight(reader, "gateway", "tasks")["passed"])
        reader = Inventory()
        with patch.object(reader, "kubelet", side_effect=RuntimeError("private-value")):
            report = preflight.preflight(reader, "gateway", "tasks")
        self.assertFalse(report["passed"])
        self.assertNotIn("private-value", str(report))

    def test_namespace_and_context_are_explicit_and_only_get_commands_execute(self):
        for context in ("", "--server=unexpected", "bad\ncontext"):
            with self.assertRaises(ValueError):
                preflight.Reader(context)
        reader = preflight.Reader("explicit-fixture")
        with patch(
            "subprocess.run",
            return_value=subprocess.CompletedProcess(
                [], 0, json.dumps({"items": []}).encode(), b""
            ),
        ) as run:
            reader.inventory("nodes")
            reader.kubelet("shared-node")
            for call in run.call_args_list:
                self.assertIn("--context=explicit-fixture", call.args[0])
                self.assertEqual(call.args[0][3], "get")
            with self.assertRaises(ValueError):
                reader.inventory("secrets")
        with self.assertRaises(ValueError):
            preflight.preflight(Inventory(), "meet", "tasks")


if __name__ == "__main__":
    unittest.main()
