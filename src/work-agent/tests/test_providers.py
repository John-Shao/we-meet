"""Supplier configuration and task-container credential separation."""

import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

from work_agent.config import Config, load_env
from work_agent.contract import canonical, digest
from work_agent.review import REPORT_SCHEMA
from work_agent.store import Store
from work_agent.worker import Worker


class ProviderTests(unittest.TestCase):
    def test_review_format_is_scoped_to_verified_model_family(self):
        with patch.dict(os.environ, {"DASHSCOPE_API_KEY": "offline-only"}):
            for model, expected in (
                ("qwen3.8-flash", "json_schema"),
                ("qwen3.8-flash-0902", "json_schema"),
                ("qwen-plus", "json_object"),
                ("qwen3.7-flash", "json_object"),
                ("qwen3.8-flashish", "json_object"),
            ):
                config = Config("pi", Path("."), "x" * 32, provider="qwen", model=model)
                caps = config.capabilities()
                self.assertEqual(caps["review_output_format"], expected)
                self.assertEqual(
                    caps["review_schema_sha256"],
                    digest(canonical(REPORT_SCHEMA))
                    if expected == "json_schema"
                    else None,
                )

    def test_qwen_requires_its_own_credential_and_model(self):
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-deepseek"}, clear=True):
            with self.assertRaisesRegex(ValueError, "DASHSCOPE_API_KEY"):
                Config("pi", Path("."), "x" * 32, model="qwen-plus", provider="qwen")
        with patch.dict(os.environ, {"DASHSCOPE_API_KEY": "test-qwen"}, clear=True):
            for kwargs in (
                {"engine": "dsh", "model": "qwen-plus"},
                {"engine": "pi", "model": "deepseek-flash"},
                {
                    "engine": "pi",
                    "model": "qwen-plus",
                    "base_url": "http://example.com",
                },
                {
                    "engine": "pi",
                    "model": "qwen-plus",
                    "base_url": "https://user:pass@example.com",
                },
            ):
                with self.assertRaises(ValueError):
                    Config(root=Path("."), token="x" * 32, provider="qwen", **kwargs)

    def test_env_file_is_not_shell_evaluated(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
            path = Path(directory) / "env"
            path.write_text("DASHSCOPE_API_KEY=$(not-executed)\n", encoding="utf8")
            load_env(path)
            self.assertEqual(os.environ["DASHSCOPE_API_KEY"], "$(not-executed)")
            path.write_text("UNKNOWN_SECRET=invalid\n", encoding="utf8")
            with self.assertRaises(ValueError):
                load_env(path)

    def test_qwen_job_receives_only_scoped_broker_credential(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(
                os.environ,
                {
                    "DASHSCOPE_API_KEY": "supplier-secret-canary",
                    "DEEPSEEK_API_KEY": "other-supplier-canary",
                },
            ),
        ):
            config = Config(
                "pi", Path(directory), "x" * 32, provider="qwen", model="qwen-plus"
            )
            store = Store(Path(directory) / "state.sqlite3")
            try:
                run_id = str(uuid.uuid4())
                body = {
                    "contract": "work-agent/v1",
                    "run_id": run_id,
                    "goal": "Review",
                    "files": [],
                    "timeout_seconds": 30,
                    "operation": "review",
                }
                store.admit(body, config.capabilities())
                store.claim()
                broker = MagicMock()
                broker.issue.return_value = (
                    "job-token",
                    "http://host.docker.internal/model",
                )
                process = MagicMock()
                process.poll.return_value = 1
                process.returncode = 1
                with (
                    patch("work_agent.worker.subprocess.run") as command,
                    patch("work_agent.worker.subprocess.Popen", return_value=process),
                    patch("work_agent.worker.kill_tree"),
                ):
                    Worker(config, store, broker).execute(body)
                child_env = command.call_args_list[0].kwargs["env"]
                self.assertNotIn("DASHSCOPE_API_KEY", child_env)
                self.assertNotIn("supplier-secret-canary", child_env.values())
                self.assertNotIn("other-supplier-canary", child_env.values())
                self.assertEqual(child_env["WORK_AGENT_MODEL_TOKEN"], "job-token")
                self.assertEqual(child_env["WORK_AGENT_PROVIDER"], "qwen")
                broker.revoke.assert_called_once_with(run_id)
            finally:
                store.close()
