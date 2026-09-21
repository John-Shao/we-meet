"""Fail-closed rollout checks; no cluster or object storage access."""

import copy
import importlib.util
from pathlib import Path
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(name + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check = load("check_record_purge")


class RolloutChecks(unittest.TestCase):
    def setUp(self):
        self.image = "registry/backend:tested"
        self.deployment = {
            "metadata": {"generation": 2},
            "spec": {"replicas": 1},
            "status": {
                "observedGeneration": 2,
                "replicas": 1,
                "updatedReplicas": 1,
                "readyReplicas": 1,
                "availableReplicas": 1,
            },
        }
        self.pod = {
            "metadata": {"name": "backend-new"},
            "spec": {"containers": [{"name": "meet", "image": self.image}]},
            "status": {
                "phase": "Running",
                "conditions": [{"type": "Ready", "status": "True"}],
                "containerStatuses": [
                    {"name": "meet", "ready": True, "imageID": "sha256:new"}
                ],
            },
        }

    def run_check(self, pods=None):
        return check.checked_pods(self.deployment, pods or [self.pod], self.image)

    def test_fully_updated_ready_pod_passes(self):
        self.assertEqual([("backend-new", "meet", "sha256:new")], self.run_check())

    def test_terminating_old_pod_blocks_even_when_deployment_reports_ready(self):
        old = copy.deepcopy(self.pod)
        old["metadata"].update(
            name="backend-old", deletionTimestamp="2026-09-21T00:00:00Z"
        )
        with self.assertRaisesRegex(RuntimeError, "old_or_terminating"):
            self.run_check([self.pod, old])

    def test_old_image_blocks(self):
        self.pod["spec"]["containers"][0]["image"] = "registry/backend:old"
        with self.assertRaisesRegex(RuntimeError, "unexpected_pod_image"):
            self.run_check()

    def test_unobserved_generation_blocks(self):
        self.deployment["status"]["observedGeneration"] = 1
        with self.assertRaisesRegex(RuntimeError, "deployment_not_observed"):
            self.run_check()

    def test_each_incomplete_replica_counter_blocks(self):
        for field in (
            "replicas",
            "updatedReplicas",
            "readyReplicas",
            "availableReplicas",
        ):
            with self.subTest(field=field):
                self.deployment["status"][field] = 0
                with self.assertRaisesRegex(RuntimeError, "not_fully_rolled_out"):
                    self.run_check()
                self.deployment["status"][field] = 1

    def test_unready_container_or_missing_digest_blocks(self):
        state = self.pod["status"]["containerStatuses"][0]
        state["ready"] = False
        with self.assertRaisesRegex(RuntimeError, "container_not_ready"):
            self.run_check()
        state["ready"] = True
        state.pop("imageID")
        with self.assertRaisesRegex(RuntimeError, "container_not_ready"):
            self.run_check()


if __name__ == "__main__":
    unittest.main()
