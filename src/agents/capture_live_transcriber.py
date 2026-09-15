"""Independent live ASR consumes verified uploaded PCM without a LiveKit room."""

import asyncio
import time
from collections import deque

from capture_transcriber import (
    FRAME_BYTES,
    MAX_CHUNKS,
    MAX_RUNS,
    CaptureAttempt,
    CaptureError,
    audio_runs,
    run_worker,
)
from plugins.qwen_asr import QwenASRSession

PAGE_SIZE = 50
INPUT_IDLE_SECONDS = 10
STOP_SEAL_SECONDS = 60
EXECUTION_SECONDS = 43260


def contiguous(previous, source):
    """Keep pauses and missing audio outside the provider's continuous clock."""
    return (
        source["sequence"] == previous["sequence"] + 1
        and source["start_ms"] == previous["start_ms"] + previous["duration_ms"]
    )


class LiveCaptureAttempt(CaptureAttempt):
    """One claimed execution, bounded metadata and one active provider task."""

    def __init__(self, *args, **kwargs):
        """Use the existing immutable final delivery queue and finish receipt."""
        kwargs.setdefault("session_factory", QwenASRSession)
        super().__init__(*args, **kwargs)
        self.pending = deque()
        self.cursor = 0
        self.closed_input = False
        self.previous = None
        self.seen = set()
        self.capture_status = "recording"
        self.stopping_at = None

    def accept_feed(self, feed):
        """Reject changed cursors and source identities before downloading audio."""
        entries = feed.get("entries")
        if (
            not isinstance(entries, list)
            or len(entries) > PAGE_SIZE
            or type(feed.get("closed")) is not bool
            or type(feed.get("input_count")) is not int
            or not self.cursor <= feed["input_count"] <= MAX_CHUNKS
            or type(feed.get("next_index")) is not int
            or feed["next_index"] != self.cursor + len(entries)
            or feed["next_index"] > feed["input_count"]
            or feed.get("capture_status")
            not in {"recording", "paused", "interrupted", "stopping", "stopped"}
        ):
            raise CaptureError("invalid_live_input_feed")
        previous = self.previous
        offered = []
        for offset, item in enumerate(entries, self.cursor + 1):
            if type(item.get("index")) is not int or item["index"] != offset:
                raise CaptureError("invalid_live_input_index")
            source = item["chunk"]
            audio_runs(
                {
                    "id": self.job["id"],
                    "configuration": {
                        "model": self.config.model,
                        "region": self.config.region,
                    },
                    "inputs": {"chunks": [source], "runs": 1},
                },
                self.config,
            )
            if source["id"] in self.seen or (
                previous
                and (
                    source["sequence"] <= previous["sequence"]
                    or source["start_ms"]
                    < previous["start_ms"] + previous["duration_ms"]
                )
            ):
                raise CaptureError("changed_live_input_order")
            self.seen.add(source["id"])
            offered.append((offset, source))
            previous = source
        self.previous = previous
        self.cursor = feed["next_index"]
        self.closed_input = feed["closed"] and self.cursor == feed["input_count"]
        self.capture_status = feed["capture_status"]
        if self.capture_status in {"stopping", "stopped"} and self.stopping_at is None:
            self.stopping_at = time.monotonic()
        self.pending.extend(offered)

    async def next_input(self, *, end_on_idle=False):
        """Pause idle provider tasks while retaining the original recording job."""
        started = time.monotonic()
        while not self.pending:
            if self.closed_input:
                return None
            result = await self.control("poll_inputs", after_index=self.cursor)
            self.accept_feed(result["feed"])
            if self.pending:
                break
            now = time.monotonic()
            if (
                self.stopping_at is not None
                and now - self.stopping_at > STOP_SEAL_SECONDS
            ):
                raise CaptureError("live_input_seal_timeout")
            if end_on_idle and (
                self.capture_status in {"paused", "interrupted"}
                or now - started >= INPUT_IDLE_SECONDS
            ):
                return None
            if not self.closed_input:
                await asyncio.sleep(0.5)
        return self.pending.popleft() if self.pending else None

    async def produce_live(self):
        """Feed each byte once; tasks handle new intervals without replay."""
        while (first := await self.next_input()) is not None:
            if len(self.sessions) >= MAX_RUNS:
                raise CaptureError("live_provider_task_limit")
            first_pcm = await self.download(*first)
            bounds = {"start": first[1]["start_ms"], "end": first[1]["start_ms"]}

            async def audio(initial=first, initial_pcm=first_pcm, interval=bounds):
                current, pcm = initial, initial_pcm
                while current is not None:
                    index, source = current
                    interval["end"] = source["start_ms"] + source["duration_ms"]
                    for offset in range(0, len(pcm), FRAME_BYTES):
                        frame = pcm[offset : offset + FRAME_BYTES]
                        yield frame
                        await asyncio.sleep(len(frame) / 32000)
                    await self.control(
                        "ack_input", index=index, checksum=source["checksum"]
                    )
                    current = await self.next_input(end_on_idle=True)
                    if current is not None and not contiguous(source, current[1]):
                        self.pending.appendleft(current)
                        return
                    if current is not None:
                        pcm = await self.download(*current)

            session = self.session_factory(self.config)
            self.sessions.append(session)
            await session.run(
                audio(),
                lambda sentence, interval=bounds: self.final(
                    sentence, interval["start"], interval["end"]
                ),
            )
            if not session.provider_finished:
                raise CaptureError("provider_finish_missing")
        await self.queue.put(None)

    async def process(self):
        """Begin once, observe permission and deliver confirmed text concurrently."""
        if self.job.get("started") is not False or self.job.get("configuration") != {
            "model": self.config.model,
            "region": self.config.region,
            "mode": "live",
        }:
            raise CaptureError("incompatible_live_execution")
        await self.control("begin")
        async with asyncio.timeout(EXECUTION_SECONDS):
            async with asyncio.TaskGroup() as group:
                group.create_task(self.produce_live())
                group.create_task(self.deliver())
                group.create_task(self.heartbeat())


if __name__ == "__main__":
    raise SystemExit(run_worker(live=True, attempt_type=LiveCaptureAttempt))
