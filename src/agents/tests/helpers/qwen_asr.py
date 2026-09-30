"""Shared qwen asr test fixtures."""

import asyncio
import json


class FakeSocket:
    """Reply only after the matching client action; tail text arrives at finish."""

    def __init__(self):
        """Keep protocol observations separate from audio or external credentials."""
        self.incoming = asyncio.Queue()
        self.sent = []
        self.task_id = None
        self.mode = "normal"
        self.closed = False

    def event(self, kind, payload=None, *, task_id=None):
        """Build an actual DashScope server envelope."""
        return json.dumps(
            {
                "header": {"event": kind, "task_id": task_id or self.task_id},
                "payload": payload or {},
            }
        )

    def sentence(self, **overrides):
        """Use provider offsets, including a final that arrives during shutdown."""
        return {
            "output": {
                "sentence": {
                    "sentence_id": 1,
                    "sentence_end": True,
                    "begin_time": 10,
                    "end_time": 80,
                    "text": "保留最后一句。",
                    **overrides,
                }
            },
            "usage": {"duration": 1},
        }

    async def send(self, data):
        """Acknowledge run, then emit final events when the client sends finish."""
        self.sent.append(data)
        if isinstance(data, bytes):
            if self.mode == "early_finish":
                self.incoming.put_nowait(self.event("task-finished"))
            return
        command = json.loads(data)
        self.task_id = command["header"]["task_id"]
        if command["header"]["action"] == "run-task":
            self.incoming.put_nowait(
                self.event(
                    "task-started",
                    task_id="wrong" if self.mode == "wrong_task" else None,
                )
            )
        else:
            self.incoming.put_nowait(
                self.event(
                    "result-generated",
                    self.sentence(sentence_end=False, text="partial"),
                )
            )
            self.incoming.put_nowait(
                self.event("result-generated", self.sentence(heartbeat=True))
            )
            self.incoming.put_nowait(self.event("result-generated", self.sentence()))
            self.incoming.put_nowait(self.event("result-generated", self.sentence()))
            if self.mode == "conflict":
                self.incoming.put_nowait(
                    self.event("result-generated", self.sentence(text="changed"))
                )
            elif self.mode == "error":
                self.incoming.put_nowait(
                    self.event("task-failed", {"sensitive": "do-not-log-this"})
                )
            elif self.mode == "invalid_time":
                self.incoming.put_nowait(
                    self.event(
                        "result-generated", self.sentence(sentence_id=2, end_time=-1)
                    )
                )
            elif self.mode != "no_finish":
                self.incoming.put_nowait(self.event("task-finished"))

    async def recv(self):
        """Wait for protocol progress rather than returning invented completion."""
        return await self.incoming.get()

    async def __aenter__(self):
        """Open a fake transport using the production client interface."""
        return self

    async def __aexit__(self, *args):
        """Observe cleanup on every success/failure path."""
        self.closed = True


async def pcm():
    """Two chunks at 16 kHz mono signed 16-bit, totaling 200 ms."""
    for _ in range(2):
        yield b"\x00" * 3200
        await asyncio.sleep(0)
