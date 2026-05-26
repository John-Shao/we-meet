"""Multi user transcription agent."""

import asyncio
import logging
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from lasuite.plugins import kyutai
from livekit import api, rtc
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    JobProcess,
    JobRequest,
    RoomIO,
    WorkerOptions,
    WorkerPermissions,
    cli,
    utils,
)
from livekit.agents import (
    room_io as lk_room_io,
)
from livekit.plugins import deepgram, silero

from transcript_writer import TranscriptWriter

load_dotenv()

logger = logging.getLogger("transcriber")

TRANSCRIBER_AGENT_NAME = os.getenv("TRANSCRIBER_AGENT_NAME", "multi-user-transcriber")
STT_PROVIDER = os.getenv("STT_PROVIDER", "deepgram")
ENABLE_SILERO_VAD = os.getenv("ENABLE_SILERO_VAD", "true").lower() == "true"


def create_stt_provider():
    """Create STT provider based on environment configuration."""
    if STT_PROVIDER == "deepgram":
        # Note: Not all Deepgram API parameters are supported by the LiveKit plugin
        # detect_language is NOT supported for real-time streaming
        # Use language="multi" instead for automatic multilingual support
        _stt_instance = deepgram.STT(
            model=os.getenv("DEEPGRAM_STT_MODEL", "nova-3"),
            language=os.getenv("DEEPGRAM_STT_LANGUAGE", "multi"),
        )
    elif STT_PROVIDER == "kyutai":
        _stt_instance = kyutai.STT(base_url=os.getenv("KYUTAI_STT_BASE_URL"))
    elif STT_PROVIDER == "doubao":
        # Doubao Seed-ASR — bigmodel streaming WebSocket protocol.
        # Requires DOUBAO_ASR_APP_ID and DOUBAO_ASR_ACCESS_TOKEN.
        from plugins.doubao_pipeline.stt import DoubaoSTT

        _stt_instance = DoubaoSTT(
            app_id=os.getenv("DOUBAO_ASR_APP_ID", ""),
            access_token=os.getenv("DOUBAO_ASR_ACCESS_TOKEN", ""),
            model_name=os.getenv("DOUBAO_ASR_MODEL", "bigmodel"),
        )
    else:
        raise ValueError(f"Unknown STT_PROVIDER: {STT_PROVIDER}")

    return _stt_instance


class Transcriber(Agent):
    """Create a transcription agent for a specific participant."""

    def __init__(self, *, participant_identity: str):
        """Init transcription agent."""
        stt = create_stt_provider()

        super().__init__(
            instructions="not-needed",
            stt=stt,
        )
        self.participant_identity = participant_identity


class MultiUserTranscriber:
    """Manage transcription sessions for multiple room participants."""

    def __init__(self, ctx: JobContext, writer: TranscriptWriter):
        """Init multi user transcription agent."""
        self.ctx = ctx
        self._writer = writer
        self._sessions: dict[str, AgentSession] = {}
        self._tasks: set[asyncio.Task] = set()

    def start(self):
        """Start listening for participant connection events."""
        self.ctx.room.on("participant_connected", self.on_participant_connected)
        self.ctx.room.on("participant_disconnected", self.on_participant_disconnected)

    async def aclose(self):
        """Close all sessions and cleanup resources."""
        await utils.aio.cancel_and_wait(*self._tasks)

        await asyncio.gather(
            *[self._close_session(session) for session in self._sessions.values()]
        )

        self.ctx.room.off("participant_connected", self.on_participant_connected)
        self.ctx.room.off("participant_disconnected", self.on_participant_disconnected)

    def on_participant_connected(self, participant: rtc.RemoteParticipant):
        """Handle new participant connection by starting transcription session."""
        if participant.identity in self._sessions:
            return

        logger.info(f"starting session for {participant.identity}")
        task = asyncio.create_task(self._start_session(participant))
        self._tasks.add(task)

        def on_task_done(task: asyncio.Task):
            try:
                self._sessions[participant.identity] = task.result()
            finally:
                self._tasks.discard(task)

        task.add_done_callback(on_task_done)

    def on_participant_disconnected(self, participant: rtc.RemoteParticipant):
        """Handle participant disconnection by closing transcription session."""
        if (session := self._sessions.pop(participant.identity)) is None:
            return

        logger.info(f"closing session for {participant.identity}")
        task = asyncio.create_task(self._close_session(session))
        self._tasks.add(task)
        task.add_done_callback(lambda _: self._tasks.discard(task))

    async def _start_session(self, participant: rtc.RemoteParticipant) -> AgentSession:
        """Create and start transcription session for participant."""
        if participant.identity in self._sessions:
            return self._sessions[participant.identity]

        vad = self.ctx.proc.userdata.get("vad", None)
        session = AgentSession(vad=vad)
        room_io = RoomIO(
            agent_session=session,
            room=self.ctx.room,
            participant=participant,
            options=lk_room_io.RoomOptions(
                text_input=False, audio_output=False, text_output=True
            ),
        )
        await room_io.start()

        # Persist FINAL transcripts to the backend. Best-effort: failures
        # log but never crash the transcription session.
        room_id = self.ctx.room.name
        speaker_identity = participant.identity
        speaker_name = participant.name or ""
        writer = self._writer

        def _on_user_input_transcribed(event):
            if not getattr(event, "is_final", False):
                return
            text = getattr(event, "transcript", "") or ""
            if not text.strip():
                return
            language = getattr(event, "language", "") or ""
            task = asyncio.create_task(
                writer.write(
                    room_id=room_id,
                    speaker_identity=speaker_identity,
                    speaker_name=speaker_name,
                    text=text,
                    language=language,
                    started_at=datetime.now(timezone.utc),
                )
            )
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

        session.on("user_input_transcribed", _on_user_input_transcribed)

        await session.start(
            agent=Transcriber(
                participant_identity=participant.identity,
            )
        )
        return session

    async def _close_session(self, sess: AgentSession) -> None:
        """Close and cleanup transcription session."""
        await sess.drain()
        await sess.aclose()


async def entrypoint(ctx: JobContext):
    """Initialize and run the multi-user transcriber."""
    writer = TranscriptWriter.from_env()
    if not writer.is_configured:
        logger.warning(
            "TranscriptWriter not configured "
            "(AGENT_BACKEND_API_URL / AGENT_INTERNAL_API_TOKEN); "
            "transcripts will NOT be persisted to the backend."
        )
    transcriber = MultiUserTranscriber(ctx, writer)
    transcriber.start()

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    for participant in ctx.room.remote_participants.values():
        transcriber.on_participant_connected(participant)

    async def cleanup():
        await transcriber.aclose()

    ctx.add_shutdown_callback(cleanup)


async def handle_transcriber_job_request(job_req: JobRequest) -> None:
    """Accept job if no transcriber exists in room, otherwise reject."""
    room_name = job_req.room.name
    transcriber_id = f"{TRANSCRIBER_AGENT_NAME}-{room_name}"

    async with api.LiveKitAPI() as lkapi:
        try:
            response = await lkapi.room.list_participants(
                list=api.ListParticipantsRequest(room=room_name)
            )

            transcriber_exists = any(
                p.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
                and p.identity == transcriber_id
                for p in response.participants
            )

            if transcriber_exists:
                logger.info(f"Transcriber exists in {room_name} - rejecting")
                await job_req.reject()
            else:
                logger.info(f"Accepting job for {room_name}")
                await job_req.accept(identity=transcriber_id)

        except Exception:
            logger.exception(f"Error processing job for {room_name}")
            await job_req.reject()


def prewarm(proc: JobProcess):
    """Preload voice activity detection model."""
    if ENABLE_SILERO_VAD:
        proc.userdata["vad"] = silero.VAD.load()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            request_fnc=handle_transcriber_job_request,
            prewarm_fnc=prewarm,
            agent_name=TRANSCRIBER_AGENT_NAME,
            permissions=WorkerPermissions(hidden=True),
        )
    )
