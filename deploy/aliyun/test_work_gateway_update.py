import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "update", Path(__file__).with_name("update-work-gateway.py")
)
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)
PREFIX = "jusi-cn-guangzhou.cr.volces.com/we-meet/work-agent-"


class GatewayUpdateTests(unittest.TestCase):
    def test_only_image_references_change_no_credentials_network_or_storage(self):
        original = {
            "spec": {
                "template": {
                    "spec": {
                        "volumes": [
                            {
                                "name": "state",
                                "persistentVolumeClaim": {"claimName": "same"},
                            }
                        ],
                        "containers": [
                            {
                                "image": "old",
                                "args": ["--engine", "pi", "--image", "old-worker"],
                                "resources": {"limits": {"memory": "1Gi"}},
                                "env": [
                                    {"name": "WORK_AGENT_IMAGE", "value": "old-worker"},
                                    {
                                        "name": "DASHSCOPE_API_KEY",
                                        "valueFrom": {
                                            "secretKeyRef": {
                                                "name": "same",
                                                "key": "same",
                                            }
                                        },
                                    },
                                ],
                            }
                        ],
                    }
                }
            }
        }
        snapshot = copy.deepcopy(original)
        gw, worker = (
            PREFIX + "gateway@sha256:" + "a" * 64,
            PREFIX + "pi@sha256:" + "b" * 64,
        )
        target = update.target_for(original, gw, worker)
        self.assertEqual(original, snapshot)
        container = target["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(container["image"], gw)
        self.assertEqual(container["args"][-1], worker)
        container["image"] = "old"
        container["args"][-1] = "old-worker"
        self.assertEqual(target, snapshot)

    def test_mutable_images_and_unknown_environment_fail_before_patch(self):
        with self.assertRaisesRegex(RuntimeError, "immutable_agent_image_required"):
            update.target_for(
                {},
                PREFIX + "pi@sha256:" + "a" * 64,
                PREFIX + "gateway@sha256:" + "b" * 64,
            )
        with self.assertRaisesRegex(RuntimeError, "immutable_agent_image_required"):
            update.target_for({}, PREFIX + "gateway:latest", PREFIX + "pi:latest")
        with self.assertRaisesRegex(RuntimeError, "unexpected_worker_reference"):
            update.target_for(
                {"spec": {"template": {"spec": {"containers": [{"env": []}]}}}},
                PREFIX + "gateway@sha256:" + "a" * 64,
                PREFIX + "pi@sha256:" + "b" * 64,
            )
