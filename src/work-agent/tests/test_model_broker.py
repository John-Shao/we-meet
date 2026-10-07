"""Provider admission, scoped credentials and real HTTP metering without charges."""

import io
import json
import os
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from work_agent.model_broker import ModelBroker, usage_from_provider
from work_agent.store import Store


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "jobs.sqlite3")
        self.run_id = str(uuid.uuid4())
        self.body = {
            "contract": "work-agent/v1",
            "run_id": self.run_id,
            "goal": "test",
            "files": [],
            "timeout_seconds": 30,
            "limits": {
                "max_model_calls": 2,
                "max_total_tokens": 10000,
                "max_output_tokens": 256,
            },
        }
        self.store.admit(self.body)
        self.store.claim()
        self.requests = []
        self.usage = {
            "prompt_tokens": 100,
            "completion_tokens": 30,
            "prompt_cache_hit_tokens": 80,
            "total_tokens": 130,
        }

        def provider(encoded, timeout):
            body = json.loads(encoded)
            self.requests.append(body)
            if body.get("stream"):
                data = b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
                data += (
                    b"data: "
                    + json.dumps({"choices": [], "usage": self.usage}).encode()
                    + b"\n\n"
                )
                return io.BytesIO(data + b"data: [DONE]\n\n")
            return io.BytesIO(json.dumps({"choices": [], "usage": self.usage}).encode())

        self.broker = ModelBroker(
            SimpleNamespace(model="test-model"), self.store, provider
        )
        self.broker.start()
        self.token, _ = self.broker.issue(self.run_id)
        self.url = f"http://127.0.0.1:{self.broker.server.server_port}/model/{self.run_id}/chat/completions"

    def tearDown(self):
        self.broker.close()
        self.store.close()
        self.temp.cleanup()

    def post(self, token=None, **extra):
        body = {
            "model": "test-model",
            "messages": [{"role": "user", "content": "test"}],
            "max_tokens": 500000,
            **extra,
        }
        request = Request(
            self.url,
            data=json.dumps(body).encode(),
            headers={
                "Authorization": "Bearer " + (token or self.token),
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, response.read()
        except HTTPError as exc:
            status = exc.code
            exc.close()
            return status, b""

    def test_provider_usage_and_output_cap_are_authoritative(self):
        self.assertEqual(self.post(stream=True)[0], 200)
        self.assertEqual(self.requests[0]["max_tokens"], 256)
        self.assertTrue(self.requests[0]["stream_options"]["include_usage"])
        meter = self.store.get(self.run_id)["metering"]
        self.assertTrue(meter["complete"])
        self.assertEqual(meter["held_tokens"], 130)
        self.assertEqual(
            meter["usage"],
            {
                "input_tokens": 20,
                "cache_read_tokens": 80,
                "cache_write_tokens": 0,
                "output_tokens": 30,
            },
        )

    def test_call_limit_under_concurrent_model_requests(self):
        with ThreadPoolExecutor(max_workers=5) as pool:
            statuses = list(pool.map(lambda _: self.post()[0], range(5)))
        self.assertEqual(statuses.count(200), 2)
        self.assertEqual(statuses.count(429), 3)
        self.assertEqual(len(self.requests), 2)

    def test_credential_revocation_and_other_model_fail_before_provider(self):
        self.assertEqual(self.post(token="wrong")[0], 401)
        self.assertEqual(self.post(model="other-model")[0], 403)
        self.broker.revoke(self.run_id)
        self.assertEqual(self.post()[0], 401)
        self.assertEqual(self.requests, [])

    def test_cancel_revokes_new_admission_but_keeps_late_usage(self):
        self.store.reserve_model_call(self.run_id, b"request")
        self.store.finish(self.run_id, "cancelled")
        self.assertEqual(self.post()[0], 409)
        self.store.record_model_usage(self.run_id, 1, usage_from_provider(self.usage))
        self.assertEqual(self.store.get(self.run_id)["metering"]["held_tokens"], 130)

    def test_missing_usage_retains_conservative_reservation(self):
        self.usage = None
        self.assertEqual(self.post()[0], 200)
        meter = self.store.get(self.run_id)["metering"]
        self.assertFalse(meter["complete"])
        self.assertIsNone(meter["usage"])
        self.assertGreater(meter["held_tokens"], 1000)

    def test_total_budget_rejects_request_before_charge(self):
        self.assertEqual(
            self.post(messages=[{"role": "user", "content": "x" * 10000}])[0], 429
        )
        self.assertEqual(self.requests, [])

    def test_review_tool_schemas_are_rejected_before_provider(self):
        # Update the test-only persisted job to exercise actual broker admission.
        self.body["operation"] = "review"
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE jobs SET request=? WHERE id=?",
                (json.dumps(self.body), self.run_id),
            )
        for options in (
            {"tools": [{"type": "function", "function": {"name": "write"}}]},
            {"functions": [{"name": "bash"}]},
            {"tool_choice": "required"},
        ):
            self.assertEqual(self.post(**options)[0], 403)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.store.metering(self.run_id)["calls"], 0)
        self.assertEqual(self.post()[0], 200)
        self.assertEqual(self.requests[0]["response_format"], {"type": "json_object"})


class UsageTests(unittest.TestCase):
    def test_malformed_usage_is_not_zero_cost(self):
        for value in [
            None,
            {},
            {"prompt_tokens": True, "completion_tokens": 0},
            {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 10},
            {"prompt_tokens": 5, "completion_tokens": 3, "prompt_cache_hit_tokens": 6},
        ]:
            self.assertIsNone(usage_from_provider(value))

    def test_qwen_cache_and_reasoning_are_not_double_counted(self):
        value = {
            "prompt_tokens": 100,
            "completion_tokens": 30,
            "total_tokens": 130,
            "prompt_tokens_details": {"cached_tokens": 80},
            "completion_tokens_details": {"reasoning_tokens": 20},
        }
        self.assertEqual(
            usage_from_provider(value, "qwen"),
            {
                "input_tokens": 20,
                "output_tokens": 30,
                "cache_read_tokens": 80,
                "cache_write_tokens": 0,
            },
        )
        for details in (None, [], {"cached_tokens": True}, {"cached_tokens": 101}):
            self.assertIsNone(
                usage_from_provider({**value, "prompt_tokens_details": details}, "qwen")
            )
        self.assertIsNone(usage_from_provider({**value, "total_tokens": True}, "qwen"))


class QwenBrokerTests(BrokerTests):
    """Run the same admission/cancel/budget suite against Qwen's usage shape."""

    def setUp(self):
        super().setUp()
        self.broker.provider_name = "qwen"
        self.broker.config.provider = "qwen"
        self.usage.pop("prompt_cache_hit_tokens")
        self.usage["prompt_tokens_details"] = {"cached_tokens": 80}

    def test_policy_cannot_be_widened_by_client_options(self):
        self.assertEqual(
            self.post(
                enable_thinking=True,
                enable_search=True,
                reasoning_effort="high",
                thinking={"type": "enabled"},
            )[0],
            200,
        )
        sent = self.requests[0]
        self.assertIs(sent["enable_thinking"], False)
        self.assertIs(sent["enable_search"], False)
        self.assertNotIn("reasoning_effort", sent)
        self.assertNotIn("thinking", sent)

    def test_upstream_uses_qwen_credential_not_deepseek(self):
        self.broker.config.base_url = "https://example.invalid/compatible-mode/v1"
        with (
            patch.dict(
                os.environ,
                {
                    "DASHSCOPE_API_KEY": "qwen-test-only",
                    "DEEPSEEK_API_KEY": "deepseek-test-only",
                },
            ),
            patch("work_agent.model_broker.build_opener") as opener,
        ):
            self.broker.open_provider(b"{}", 2)
        request = opener.return_value.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer qwen-test-only")
        self.assertEqual(
            request.full_url,
            "https://example.invalid/compatible-mode/v1/chat/completions",
        )
