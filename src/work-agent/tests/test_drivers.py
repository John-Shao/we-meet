"""Test upstream event semantics independently of the business HTTP contract."""

import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from work_agent import drivers


class FakeProcess:
    def __init__(self, records):
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO(
            b"".join(json.dumps(record).encode() + b"\n" for record in records)
        )

    def wait(self, timeout):
        return 0


class DriverTests(unittest.TestCase):
    def test_pi_waits_for_settled_and_authoritative_message(self):
        records = [
            {"type": "response", "id": "retry", "success": True},
            {
                "type": "response",
                "id": "task",
                "success": True,
                "data": {"disposition": "started"},
            },
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "stopReason": "stop",
                    "content": [{"type": "text", "text": "final"}],
                },
            },
            {"type": "agent_end"},
            {"type": "agent_settled"},
            {
                "type": "response",
                "id": "stats",
                "success": True,
                "data": {
                    "tokens": {
                        "input": 10,
                        "output": 20,
                        "cacheRead": 3,
                        "cacheWrite": 0,
                    }
                },
            },
        ]
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            cli = path / "package" / "dist" / "bundle" / "cli.js"
            cli.parent.mkdir(parents=True)
            (path / "package" / "package.json").write_text('{"version":"1.0.4"}')
            home = path / "home"
            home.mkdir()
            with (
                patch.dict(
                    os.environ,
                    {
                        "PI_CLI": str(cli),
                        "WORK_AGENT_MODEL": "test",
                        "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
                    },
                ),
                patch.object(
                    drivers.subprocess, "Popen", return_value=FakeProcess(records)
                ),
            ):
                result = drivers.pi({"goal": "test", "files": []}, path, home)
            self.assertEqual(result["summary"], "final")
            self.assertEqual(result["usage"]["cache_read_tokens"], 3)
            model_config = json.loads((home / "models.json").read_text("utf-8"))
            provider = model_config["providers"]["deepseek"]
            self.assertEqual(provider["apiKey"], "$DEEPSEEK_API_KEY")
            self.assertEqual(provider["modelOverrides"]["test"]["maxTokens"], 4096)

    def test_dsh_unknown_usage_and_incomplete_result(self):
        class Harness:
            reason = "completed"

            def __init__(self, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def run(self, *args, **kwargs):
                return SimpleNamespace(
                    finish_reason=self.reason, final_response="final"
                )

        with (
            patch.dict(
                "sys.modules",
                {"deepseek_harness": SimpleNamespace(DeepSeekHarness=Harness)},
            ),
            patch.object(
                drivers.importlib.metadata, "version", return_value="0.1.5rc1"
            ),
            patch.dict(
                os.environ,
                {
                    "WORK_AGENT_MODEL": "test",
                    "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
                },
            ),
        ):
            request = {
                "goal": "test",
                "files": [],
                "run_id": "test",
                "timeout_seconds": 5,
            }
            self.assertIsNone(drivers.dsh(request, Path("."), Path("."))["usage"])
            Harness.reason = "max-tokens"
            with self.assertRaises(RuntimeError):
                drivers.dsh(request, Path("."), Path("."))
