"""Real pinned Pi RPC -> broker -> fixture SSE; no supplier network calls."""

import io
import json
import os
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from work.agent_client import AgentClient  # noqa: E402

from work_agent.config import Config  # noqa: E402
from work_agent.contract import digest  # noqa: E402
from work_agent.server import Gateway  # noqa: E402


@unittest.skipUnless(os.environ.get("WORK_AGENT_PI_TEST_IMAGE"), "Pi Docker opt-in")
class QwenDockerTests(unittest.TestCase):
    def test_pinned_pi_custom_provider_review_and_usage(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(
                os.environ, {"DASHSCOPE_API_KEY": "offline-provider-key-never-used"}
            ),
        ):
            gateway = Gateway(
                Config(
                    "pi",
                    Path(directory),
                    "offline-gateway-token-123456789",
                    provider="qwen",
                    model="qwen3.8-flash",
                    image=os.environ["WORK_AGENT_PI_TEST_IMAGE"],
                )
            )
            requests = []
            report = {
                "verdict": "needs_changes",
                "summary": "The original inputs were not supplied.",
                "findings": [
                    {
                        "severity": "warning",
                        "message": "Check against original inputs",
                        "evidence": [
                            {
                                "file": "report.md",
                                "sha256": digest(b"Total: 3"),
                                "quote": "Total: 3",
                            }
                        ],
                    }
                ],
                "missing_information": ["Original input records"],
            }

            def provider(encoded, timeout):
                body = json.loads(encoded)
                requests.append(body)
                choice = {
                    "index": 0,
                    "delta": {"role": "assistant", "content": json.dumps(report)},
                    "finish_reason": None,
                }
                end = {"index": 0, "delta": {}, "finish_reason": "stop"}
                usage = {
                    "prompt_tokens": 100,
                    "completion_tokens": 30,
                    "total_tokens": 130,
                    "prompt_tokens_details": {"cached_tokens": 80},
                }
                chunks = [
                    {
                        "id": "chat-offline",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "qwen3.8-flash",
                        "choices": [choice],
                    },
                    {
                        "id": "chat-offline",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "qwen3.8-flash",
                        "choices": [end],
                        "usage": usage,
                    },
                ]
                return io.BytesIO(
                    b"".join(
                        b"data: " + json.dumps(chunk).encode() + b"\n\n"
                        for chunk in chunks
                    )
                    + b"data: [DONE]\n\n"
                )

            gateway.broker.provider = provider
            gateway.start()
            try:
                client = AgentClient(gateway.url, gateway.config.token)
                run_id = uuid.uuid4()
                client.submit(
                    run_id,
                    "Verify total 3. Return JSON.",
                    {"report.md": "Total: 3"},
                    operation="review",
                    timeout_seconds=45,
                )
                deadline = time.monotonic() + 55
                while time.monotonic() < deadline:
                    job = client.get(run_id)
                    if job["state"] in {"succeeded", "failed", "cancelled"}:
                        break
                    time.sleep(0.1)
                self.assertEqual(job["state"], "succeeded", job["error_code"])
                self.assertEqual(len(requests), 1)
                self.assertEqual(requests[0]["model"], "qwen3.8-flash")
                self.assertIs(requests[0]["enable_thinking"], False)
                self.assertNotIn("tools", requests[0])
                fmt = requests[0]["response_format"]
                self.assertEqual(fmt["type"], "json_schema")
                self.assertIs(fmt["json_schema"]["strict"], True)
                self.assertEqual(
                    gateway.config.capabilities()["review_output_format"],
                    "json_schema",
                )
                self.assertEqual(job["result"]["usage"]["cache_read_tokens"], 80)
                self.assertEqual(job["result"]["usage"]["input_tokens"], 20)
                artifacts = job["result"]["artifacts"]
                self.assertEqual([a["name"] for a in artifacts], ["pi-review.json"])
                self.assertEqual(
                    json.loads(artifacts[0]["text"]),
                    {**report, "verdict": "inconclusive"},
                )
                workspace = Path(directory) / "jobs" / str(run_id) / "workspace"
                self.assertEqual((workspace / "report.md").read_text(), "Total: 3")
            finally:
                gateway.close()
