"""A tool invocation must not reach the consumer before a bound native decision."""

import io
import json
import tempfile
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from work_agent.approvals import ApprovalGate, tool_calls
from work_agent.contract import ContractError
from work_agent.model_broker import ModelBroker
from work_agent.store import Store


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "jobs.sqlite3")
        self.run = str(uuid.uuid4())
        self.store.admit(
            {
                "contract": "work-agent/v1",
                "run_id": self.run,
                "goal": "approval fixture",
                "files": [],
                "timeout_seconds": 30,
                "limits": {
                    "max_model_calls": 6,
                    "max_total_tokens": 10000,
                    "max_output_tokens": 256,
                },
            }
        )
        self.store.claim()
        self.gate = ApprovalGate(self.store, timeout=2)
        self.response = {
            "choices": [
                {
                    "message": {
                        "tool_calls": [
                            {
                                "type": "function",
                                "function": {
                                    "name": "shell",
                                    "arguments": '{"script":"write fixture"}',
                                },
                            }
                        ]
                    }
                }
            ],
            "usage": {"prompt_tokens": 40, "completion_tokens": 10},
        }
        self.broker = ModelBroker(
            SimpleNamespace(model="fixture"),
            self.store,
            lambda *_: io.BytesIO(json.dumps(self.response).encode()),
            bind_host="127.0.0.1",
            approval_gate=self.gate,
        )
        self.broker.start()
        self.token, _ = self.broker.issue(self.run)
        self.consumed = threading.Event()

    def tearDown(self):
        self.broker.close()
        self.store.close()
        self.temp.cleanup()

    def consume(self):
        request = Request(
            f"http://127.0.0.1:{self.broker.server.server_port}/model/{self.run}/chat/completions",
            data=json.dumps(
                {
                    "model": "fixture",
                    "messages": [{"role": "user", "content": "test"}],
                    "tools": [{"type": "function", "function": {"name": "shell"}}],
                }
            ).encode(),
            headers={"Authorization": "Bearer " + self.token},
        )
        try:
            with urlopen(request, timeout=5) as response:
                value = json.loads(response.read())
                if value["choices"][0]["message"]["tool_calls"]:
                    self.consumed.set()
                return response.status
        except HTTPError as e:
            e.close()
            return e.code

    def pending(self):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if pending := self.gate.pending(self.run):
                return pending[0]
            time.sleep(0.01)
        self.fail("no pending approval")

    def test_release_only_after_exact_one_shot_decision(self):
        with ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(self.consume)
            approval = self.pending()
            self.assertFalse(result.done())
            self.assertFalse(self.consumed.is_set())
            self.assertEqual(
                self.store.metering(self.run)["usage"]["output_tokens"], 10
            )
            with self.assertRaises(ContractError):
                self.gate.decide(self.run, approval["id"], "wrong-hash", True)
            self.assertFalse(self.consumed.is_set())
            self.gate.decide(self.run, approval["id"], approval["sha256"], True)
            self.assertEqual(result.result(), 200)
            with self.assertRaises(ContractError):
                self.gate.decide(self.run, approval["id"], approval["sha256"], True)
        self.assertTrue(self.consumed.is_set())

    def test_reject_timeout_and_cancellation_never_release(self):
        for decision in ("reject", "timeout", "cancel"):
            with ThreadPoolExecutor(max_workers=1) as pool:
                result = pool.submit(self.consume)
                approval = self.pending()
                if decision == "reject":
                    self.gate.decide(
                        self.run, approval["id"], approval["sha256"], False
                    )
                elif decision == "cancel":
                    self.store.cancel(self.run)
                self.assertEqual(result.result(), 403)
                self.assertFalse(self.consumed.is_set())
        self.assertTrue(self.store.metering(self.run)["complete"])

    def test_restart_invalidates_pending_decision(self):
        with ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(self.consume)
            approval = self.pending()
            restarted = ApprovalGate(self.store)
            with self.assertRaises(ContractError):
                restarted.decide(self.run, approval["id"], approval["sha256"], True)
            self.assertEqual(result.result(), 403)

    def test_fragmented_stream_and_legacy_calls(self):
        records = [
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "type": "function",
                                    "function": {
                                        "name": "shell",
                                        "arguments": '{"script":',
                                    },
                                }
                            ]
                        }
                    }
                ]
            },
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "function": {"arguments": '"read fixture"}'},
                                }
                            ]
                        }
                    }
                ]
            },
        ]
        data = b"".join(b"data: " + json.dumps(r).encode() + b"\n\n" for r in records)
        self.assertEqual(
            tool_calls(data + b"data: [DONE]\n\n", True)[0]["arguments"],
            '{"script":"read fixture"}',
        )
        with self.assertRaises(ContractError):
            tool_calls(
                b'{"choices":[{"message":{"function_call":{"name":"shell"}}}]}', False
            )
