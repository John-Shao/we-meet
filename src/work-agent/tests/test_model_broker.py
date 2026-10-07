"""Provider admission, scoped credentials and real HTTP metering without charges."""

import io
import json
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
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
