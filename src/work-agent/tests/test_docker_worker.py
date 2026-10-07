"""Opt-in real Docker lifecycle tests, always using the offline fixture driver."""

import os
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from work_agent.config import Config
from work_agent.store import Store
from work_agent.worker import Worker


@unittest.skipUnless(os.environ.get("WORK_AGENT_DOCKER_TEST_IMAGE"), "Docker opt-in")
class DockerWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        original = Config(
            "fixture", root, "offline-fixture-gateway-token", execution="fixture"
        )
        # Test-only config: the real Config deliberately disallows this pairing.
        # Launch exactly the offline fixture through the production Docker worker.
        image = os.environ["WORK_AGENT_DOCKER_TEST_IMAGE"]
        caps = {**original.capabilities(), "execution": "docker", "image": image}
        config = SimpleNamespace(
            root=root,
            engine="fixture",
            execution="docker",
            model="offline",
            base_url="https://example.invalid",
            image=image,
            capabilities=lambda: caps,
        )
        self.credentials = patch.dict(
            os.environ, {"DEEPSEEK_API_KEY": "offline-not-a-key"}
        )
        self.credentials.start()
        self.store = Store(root / "jobs.sqlite3")
        self.worker = Worker(config, self.store)
        self.worker.start()

    def tearDown(self):
        self.worker.close()
        self.store.close()
        self.credentials.stop()
        self.temporary.cleanup()

    def submit(self, goal, timeout=15):
        run_id = str(uuid.uuid4())
        body = {
            "contract": "work-agent/v1",
            "run_id": run_id,
            "goal": goal,
            "files": [],
            "timeout_seconds": timeout,
        }
        self.store.admit(body, self.worker.config.capabilities())
        return run_id

    def wait(self, run_id):
        for _ in range(160):
            job = self.store.get(run_id)
            if job["state"] in {"succeeded", "failed", "cancelled"}:
                return job
            time.sleep(0.1)
        self.fail("docker task did not finish")

    def no_container(self, run_id):
        for _ in range(80):
            result = subprocess.run(
                ["docker", "inspect", "work-poc-" + run_id],
                capture_output=True,
                timeout=10,
            )
            if result.returncode != 0:
                return
            time.sleep(0.1)
        self.fail("container survived cancellation/deadline")

    def test_artifact_delivery_and_no_container_after_completion(self):
        run_id = self.submit("fixture")
        job = self.wait(run_id)
        self.assertEqual(job["state"], "succeeded")
        self.assertEqual(job["result"]["artifacts"][0]["name"], "report.md")
        self.no_container(run_id)

    def test_deadline_removes_container(self):
        run_id = self.submit("fixture:slow", timeout=3)
        self.assertEqual(self.wait(run_id)["error_code"], "deadline_exceeded")
        self.no_container(run_id)

    def test_cancel_removes_container_even_during_creation(self):
        run_id = self.submit("fixture:slow")
        for _ in range(100):
            if self.store.get(run_id)["state"] == "running":
                break
            time.sleep(0.01)
        self.store.finish(run_id, "cancelled")
        # Ensure cleanup has completed, including the create-before-start window.
        self.worker.close()
        self.no_container(run_id)
        self.assertEqual(self.store.get(run_id)["state"], "cancelled")
