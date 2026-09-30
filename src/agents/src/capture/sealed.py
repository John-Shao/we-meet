"""Transcribe sealed WAV captures with the file ASR provider."""

import asyncio

from capture.common import FRAME_BYTES, BaseCaptureAttempt, CaptureError, audio_runs
from plugins.qwen.filetrans import QwenFileASRConfig, QwenFileASRSession
from transcription.diagnostics import stage


class CaptureAttempt(BaseCaptureAttempt):
    """Process one sealed capture without replaying audio through realtime ASR."""

    def __init__(self, backend, config, job, *, session_factory=QwenFileASRSession):
        """Use file transcription unless a test supplies a protocol session."""
        super().__init__(backend, config, job, session_factory=session_factory)

    async def produce(self, runs, first):
        """Each disconnected source interval owns a separate provider task."""
        for run in runs:
            start = run[0][1]["start_ms"]
            end = run[-1][1]["start_ms"] + run[-1][1]["duration_ms"]

            async def audio(current=run):
                for index, source in current:
                    pcm = first if index == 1 else await self.download(index, source)
                    for offset in range(0, len(pcm), FRAME_BYTES):
                        frame = pcm[offset : offset + FRAME_BYTES]
                        yield frame
                        await asyncio.sleep(0)
                    await self.control(
                        "ack_input", index=index, checksum=source["checksum"]
                    )

            session = self.session_factory(self.config)
            self.sessions.append(session)

            async def file_final(sentence, a=start, b=end):
                while self.queue.full():
                    await asyncio.sleep(0.01)
                with stage("result_parse"):
                    self.final(sentence, a, b)

            await session.run(
                audio(),
                file_final
                if isinstance(session, QwenFileASRSession)
                else lambda sentence, a=start, b=end: self.final(sentence, a, b),
            )
            if not session.provider_finished:
                raise CaptureError("provider_finish_missing")
        await self.queue.put(None)

    async def process(self):
        """Process the original sealed snapshot with no provider replay."""
        with stage("manifest"):
            runs = audio_runs(self.job, self.config)
            if self.job.get("started") is not False:
                raise CaptureError("provider_execution_already_started")
        first = await self.download(*runs[0][0])
        await self.control("begin")
        duration = sum(item[1]["duration_ms"] for run in runs for item in run)
        async with asyncio.timeout(
            86400
            if isinstance(self.config, QwenFileASRConfig)
            else duration / 500 + 240
        ):
            async with asyncio.TaskGroup() as group:
                group.create_task(self.produce(runs, first))
                group.create_task(self.deliver())
                group.create_task(self.heartbeat())
