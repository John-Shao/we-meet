"""Contract/failure tests at the actual HTTP + process boundary, no model calls."""

import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from work.agent_client import AgentBoundaryError, AgentClient  # noqa: E402

from work_agent.config import Config  # noqa: E402
from work_agent.contract import (  # noqa: E402
    ContractError,
    digest,
    validate_request,
    validate_result,
)
from work_agent.runner import collect_artifacts  # noqa: E402
from work_agent.server import Gateway  # noqa: E402
from work_agent.store import Store  # noqa: E402


def request(run_id=None, goal="fixture", timeout=10):
    return {
        "contract": "work-agent/v1",
        "run_id": run_id or str(uuid.uuid4()),
        "goal": goal,
        "files": [
            {"name": "材料.md", "text": "材料", "sha256": digest("材料".encode())}
        ],
        "timeout_seconds": timeout,
    }


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.token = "offline-contract-test-token-123456"
        self.config = Config(
            "fixture", Path(self.temp.name), self.token, execution="fixture"
        )
        self.gateway = Gateway(self.config)
        self.gateway.start()
        self.client = AgentClient(self.gateway.url, self.token)

    def tearDown(self):
        self.gateway.close()
        self.temp.cleanup()

    def terminal(self, run_id):
        for _ in range(100):
            job = self.client.get(run_id)
            if job["state"] in {"succeeded", "failed", "cancelled"}:
                return job
            time.sleep(0.05)
        self.fail("job did not finish")

    def test_http_process_delivery_and_duplicate_admission(self):
        run_id = str(uuid.uuid4())
        for files in (
            {"材料.md": "内容", "notes.md": "notes"},
            {"notes.md": "notes", "材料.md": "内容"},
        ):
            self.client.submit(run_id, "fixture", files)
        job = self.terminal(run_id)
        self.assertEqual(job["state"], "succeeded")
        self.assertIsNone(job["result"]["usage"])
        artifact = job["result"]["artifacts"][0]
        self.assertEqual(artifact["sha256"], digest(artifact["text"].encode()))
        self.assertEqual([event["seq"] for event in job["events"]], [1, 2, 3])
        self.assertEqual(len(self.client.get(run_id, after=2)["events"]), 1)
        with self.assertRaises(AgentBoundaryError) as error:
            self.client.submit(run_id, "changed", {"材料.md": "内容"})
        self.assertEqual(error.exception.code, "agent_http_409")

    def test_cancel_before_admission_is_a_durable_tombstone(self):
        run_id = str(uuid.uuid4())
        self.assertEqual(self.client.cancel(run_id)["state"], "cancelled")
        job = self.client.submit(run_id, "fixture", {"notes.md": "do not run"})
        self.assertEqual(job["state"], "cancelled")
        self.assertIsNone(job["result"])
        self.assertEqual(job["metering"]["calls"], 0)
        self.assertEqual([event["seq"] for event in job["events"]], [1])

    def test_unicode_material_uses_utf8_wire_budget(self):
        run_id = str(uuid.uuid4())
        self.client.submit(run_id, "fixture", {"材料.md": "文" * 100000})
        self.assertEqual(self.terminal(run_id)["state"], "succeeded")

    def test_authentication_and_contract_rejection(self):
        with self.assertRaises(AgentBoundaryError) as error:
            AgentClient(self.gateway.url, "wrong").capabilities()
        self.assertEqual(error.exception.code, "agent_http_401")
        body = request()
        body["contract"] = "work-agent/v2"
        with self.assertRaises(AgentBoundaryError) as error:
            self.client._request("POST", "/v1/jobs", body)
        self.assertEqual(error.exception.code, "agent_http_409")

    def test_cancel_wins_and_is_idempotent(self):
        run_id = str(uuid.uuid4())
        self.client.submit(run_id, "fixture:slow", {})
        for _ in range(50):
            if self.client.get(run_id)["state"] == "running":
                break
            time.sleep(0.02)
        self.assertEqual(self.client.cancel(run_id)["state"], "cancelled")
        self.assertEqual(self.client.cancel(run_id)["state"], "cancelled")
        self.assertFalse(self.gateway.store.finish(run_id, "succeeded", result={}))
        self.assertIsNone(self.client.get(run_id)["result"])

    def test_deadline_and_process_crash(self):
        for goal, expected in [
            ("fixture:slow", "deadline_exceeded"),
            ("fixture:crash", "agent_failed"),
        ]:
            run_id = str(uuid.uuid4())
            self.client.submit(run_id, goal, {}, timeout_seconds=1)
            job = self.terminal(run_id)
            self.assertEqual(job["state"], "failed")
            self.assertEqual(job["error_code"], expected)

    def test_only_one_gateway_owns_state_directory(self):
        with self.assertRaises(RuntimeError):
            Gateway(self.config)

    def test_additive_capabilities_dont_break_business_client(self):
        original = Config.capabilities
        with patch.object(
            Config,
            "capabilities",
            lambda cfg: {**original(cfg), "new_optional_feature": {"value": True}},
        ):
            self.assertTrue(self.client.capabilities()["new_optional_feature"]["value"])

    def test_queued_job_does_not_silently_change_runtime(self):
        body = request()
        deployment = {**self.config.capabilities(), "runtime_version": "older"}
        self.gateway.store.admit(body, deployment)
        job = self.terminal(body["run_id"])
        self.assertEqual(job["error_code"], "deployment_changed")


class PersistenceTests(unittest.TestCase):
    def test_restart_does_not_replay_unknown_execution(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "ledger.sqlite3"
            store = Store(path)
            running, queued = request(), request()
            store.admit(running)
            store.claim()
            store.admit(queued)
            store.close()
            store = Store(path)
            store.recover()
            self.assertEqual(
                store.get(running["run_id"])["error_code"], "execution_unknown"
            )
            self.assertFalse(store.admit(running))
            self.assertEqual(store.claim()["run_id"], queued["run_id"])
            self.assertIsNone(store.claim())
            store.close()


class ValidationTests(unittest.TestCase):
    def test_business_client_rejects_corrupt_or_unknown_job_response(self):
        run_id = str(uuid.uuid4())
        client = AgentClient("http://127.0.0.1:8881", "test")
        good = {
            "contract": "work-agent/v1",
            "run_id": run_id,
            "state": "succeeded",
            "error_code": "",
            "events": [],
            "result": {
                "summary": "done",
                "artifacts": [
                    {"name": "result.md", "text": "result", "sha256": "wrong"}
                ],
            },
        }
        with patch.object(client, "_request", return_value=good):
            with self.assertRaises(AgentBoundaryError):
                client.get(run_id)
            good["result"]["artifacts"][0]["sha256"] = digest(b"result")
            good["new_optional_field"] = True
            self.assertTrue(client.get(run_id)["new_optional_field"])
            good["state"] = "new_terminal_meaning"
            with self.assertRaises(AgentBoundaryError):
                client.get(run_id)

    def test_no_paths_secrets_or_runtime_options_in_request(self):
        for name in ["../escape.md", "C:\\secret.md", "NUL.txt", ".env", "a:b.md"]:
            body = request()
            body["files"][0]["name"] = name
            with self.assertRaises(ContractError):
                validate_request(body)
        for key in ["api_key", "plugins", "cwd", "engine"]:
            body = request()
            body[key] = "not allowed"
            with self.assertRaises(ContractError):
                validate_request(body)

    def test_checksum_and_timeout_validation(self):
        body = request()
        body["files"][0]["sha256"] = "0" * 64
        with self.assertRaises(ContractError):
            validate_request(body)
        for value in [0, 301, True, "10"]:
            with self.assertRaises(ContractError):
                validate_request(request(timeout=value))

    def test_symlink_and_hardlink_artifacts_are_rejected(self):
        import os

        with tempfile.TemporaryDirectory() as root:
            workspace = Path(root)
            (workspace / "output").mkdir()
            source = workspace / "private.md"
            source.write_text("private")
            os.link(source, workspace / "output" / "linked.md")
            with self.assertRaises(RuntimeError):
                collect_artifacts(workspace)

    def test_result_checksum_validation(self):
        result = {
            "summary": "result",
            "usage": None,
            "elapsed_ms": 1,
            "artifacts": request()["files"],
        }
        result["artifacts"][0]["sha256"] = "bad"
        with self.assertRaises(ContractError):
            validate_result(result)

    def test_remote_plaintext_endpoint_rejected(self):
        with self.assertRaises(ValueError):
            AgentClient("http://agent.example.com", "token")


if __name__ == "__main__":
    unittest.main()
