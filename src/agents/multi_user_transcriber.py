"""Multi user transcription agent."""

import asyncio
import json
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
)
from livekit.agents import (
    room_io as lk_room_io,
)
from livekit.plugins import deepgram, silero

from plugins.qwen_asr import QwenASRConfig, QwenSTT
from transcript_writer import TranscriptWriter

load_dotenv()

logger = logging.getLogger("transcriber")

TRANSCRIBER_AGENT_NAME = os.getenv("TRANSCRIBER_AGENT_NAME", "multi-user-transcriber")
STT_PROVIDER = os.getenv("STT_PROVIDER", "deepgram")
ENABLE_SILERO_VAD = os.getenv("ENABLE_SILERO_VAD", "true").lower() == "true"

# Sprint 2.1: comma-separated ISO codes to translate each FINAL transcript
# into, beyond its original language. Empty/unset disables translation.
TRANSLATION_TARGET_LANGS = [
    lang.strip()
    for lang in os.getenv("TRANSLATION_TARGET_LANGS", "").split(",")
    if lang.strip()
]
TRANSLATION_DATACHANNEL_TOPIC = "lk.transcription.translation"


async def _get_livekit_room_sid(room: rtc.Room) -> str:
    """Resolve LiveKit's asynchronous Room.sid property to a wire-safe string."""
    room_sid = await room.sid
    return room_sid or ""


def create_stt_provider(*, on_final=None, on_failure=None):
    """Create STT provider based on environment configuration."""
    if STT_PROVIDER == "deepgram":
        # Note: Not all Deepgram API parameters are supported by the LiveKit plugin
        # detect_language is NOT supported for real-time streaming
        # Use language="multi" instead for automatic multilingual support
        _stt_instance = deepgram.STT(
            model=os.getenv("DEEPGRAM_STT_MODEL", "nova-3"),
            language=os.getenv("DEEPGRAM_STT_LANGUAGE", "multi"),
        )
    elif STT_PROVIDER == "qwen":
        _stt_instance = QwenSTT(
            QwenASRConfig.from_env(), on_final=on_final, on_failure=on_failure
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

    def __init__(self, *, participant_identity: str, on_final=None, on_failure=None):
        """Init transcription agent."""
        stt = create_stt_provider(on_final=on_final, on_failure=on_failure)

        super().__init__(
            instructions="not-needed",
            stt=stt,
        )
        self.participant_identity = participant_identity


class MultiUserTranscriber:
    """Manage transcription sessions for multiple room participants."""

    def __init__(
        self,
        ctx: JobContext,
        writer: TranscriptWriter,
        translator=None,
        target_langs: list[str] | None = None,
    ):
        """Init multi user transcription agent."""
        self.ctx = ctx
        self._writer = writer
        self._translator = translator
        self._target_langs = target_langs or []
        self._sessions: dict[str, AgentSession] = {}
        self._tasks: set[asyncio.Task] = set()
        self._writes: set[asyncio.Task] = set()
        self._starting: dict[str, asyncio.Task] = {}
        self._closing = False
        self._accepting_finals = True

    async def _publish_translation(
        self,
        *,
        speaker_identity: str,
        text: str,
        language: str,
        translations: dict,
        started_at: datetime,
    ) -> None:
        """Broadcast {original + translations} to the room via DataChannel.

        Front-end subscribers (Subtitles.tsx) filter by topic and pick the
        translation matching the local user's UI language.
        """
        payload = json.dumps(
            {
                "speaker_identity": speaker_identity,
                "text": text,
                "language": language,
                "translations": translations,
                "started_at": started_at.isoformat(),
            },
            ensure_ascii=False,
        ).encode("utf-8")
        try:
            await self.ctx.room.local_participant.publish_data(
                payload,
                reliable=True,
                topic=TRANSLATION_DATACHANNEL_TOPIC,
            )
        except Exception:
            logger.exception("Failed to publish translation DataChannel")

    def start(self):
        """Start listening for participant connection events."""
        self.ctx.room.on("participant_connected", self.on_participant_connected)
        self.ctx.room.on("participant_disconnected", self.on_participant_disconnected)

    async def aclose(self):
        """Drain producers before writes; interrupted drains remain incomplete."""
        self._closing = True
        self.ctx.room.off("participant_connected", self.on_participant_connected)
        self.ctx.room.off("participant_disconnected", self.on_participant_disconnected)
        try:
            async with asyncio.timeout(45):
                await self._drain_tasks(self._tasks)
                results = await asyncio.gather(
                    *[
                        self._close_session(session)
                        for session in self._sessions.values()
                    ],
                    return_exceptions=True,
                )
                if any(isinstance(result, BaseException) for result in results):
                    self._writer.mark_incomplete()
                await self._drain_tasks(self._writes)
        except TimeoutError:
            self._writer.mark_incomplete()
            logger.warning("Transcription shutdown timed out; delivery is incomplete")
        except asyncio.CancelledError:
            self._writer.mark_incomplete()
            raise
        finally:
            self._accepting_finals = False
            pending = self._tasks | self._writes
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            await self._writer.finish_delivery()

    async def _drain_tasks(self, collection: set) -> None:
        """Remove joined tasks explicitly; completed gather need not yield callbacks."""
        while collection:
            batch = list(collection)
            results = await asyncio.gather(*batch, return_exceptions=True)
            collection.difference_update(batch)
            # Startup callbacks install sessions that shutdown must close.
            await asyncio.sleep(0)
            if any(isinstance(result, BaseException) for result in results):
                self._writer.mark_incomplete()

    def _track(self, task: asyncio.Task, collection: set) -> None:
        """Observe all background failures, including callbacks fired during drain."""
        collection.add(task)

        def done(completed):
            collection.discard(completed)
            if completed.cancelled() or completed.exception() is not None:
                self._writer.mark_incomplete()
                logger.warning("Transcription background work did not finish")

        task.add_done_callback(done)

    def on_participant_connected(self, participant: rtc.RemoteParticipant):
        """Handle new participant connection by starting transcription session."""
        if (
            self._closing
            or participant.identity in self._sessions
            or participant.identity in self._starting
        ):
            return

        logger.info(f"starting session for {participant.identity}")
        task = asyncio.create_task(self._start_session(participant))
        self._starting[participant.identity] = task
        self._track(task, self._tasks)

        def on_task_done(task: asyncio.Task):
            try:
                if not task.cancelled() and task.exception() is None:
                    self._sessions[participant.identity] = task.result()
            finally:
                self._starting.pop(participant.identity, None)

        task.add_done_callback(on_task_done)

    def on_participant_disconnected(self, participant: rtc.RemoteParticipant):
        """Handle participant disconnection by closing transcription session."""
        if self._closing:
            return
        starting = self._starting.get(participant.identity)

        async def close_participant():
            if starting:
                await asyncio.shield(starting)
            session = self._sessions.pop(participant.identity, None)
            if session:
                await self._close_session(session)

        self._track(asyncio.create_task(close_participant()), self._tasks)

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

        # On each FINAL transcript: (1) translate concurrently to every
        # configured target language, (2) persist the original even when
        # translation fails, and (3) broadcast via DataChannel. Every FINAL
        # reserves a delivery sequence before this asynchronous work starts.
        room_id = self.ctx.room.name
        livekit_room_sid = await _get_livekit_room_sid(self.ctx.room)
        speaker_identity = participant.identity
        # Display name is mirrored into participant attributes by the
        # backend (core.utils.generate_token) because livekit-rtc doesn't
        # always surface the JWT ``name`` claim on RemoteParticipant.name.
        attrs = getattr(participant, "attributes", None) or {}
        speaker_name = attrs.get("name") or participant.name or ""
        writer = self._writer
        translator = self._translator
        target_langs = self._target_langs

        async def _process_final(  # noqa: PLR0913 -- explicit source time and identity
            text: str,
            language: str,
            started_at: datetime,
            sequence,
            *,
            ended_at=None,
            ingest_id=None,
        ):
            translations: dict[str, str] = {}
            if translator and target_langs:
                try:
                    async with asyncio.timeout(15):
                        translations = await translator.translate_many(
                            text,
                            source_lang=language,
                            target_langs=target_langs,
                        )
                except Exception:
                    logger.warning(
                        "Translation unavailable; preserving original transcript"
                    )
            await writer.write(
                room_id=room_id,
                livekit_room_sid=livekit_room_sid,
                speaker_identity=speaker_identity,
                speaker_name=speaker_name,
                text=text,
                language=language,
                started_at=started_at,
                ended_at=ended_at,
                ingest_id=ingest_id,
                translations=translations,
                sequence=sequence,
            )
            await self._publish_translation(
                speaker_identity=speaker_identity,
                text=text,
                language=language,
                translations=translations,
                started_at=started_at,
            )

        def _on_user_input_transcribed(event):
            # Qwen persists the source-aware event directly. The SDK event is
            # still used for live subtitles, but carries no source timestamps.
            if STT_PROVIDER == "qwen":
                return
            if not getattr(event, "is_final", False):
                return
            text = getattr(event, "transcript", "") or ""
            if not text.strip():
                return
            if not self._accepting_finals:
                writer.mark_incomplete()
                return
            language = getattr(event, "language", "") or ""
            sequence = writer.reserve_sequence()
            task = asyncio.create_task(
                _process_final(text, language, datetime.now(timezone.utc), sequence)
            )
            self._track(task, self._writes)

        session.on("user_input_transcribed", _on_user_input_transcribed)

        def _on_qwen_final(sentence, started_at, ended_at):
            if not self._accepting_finals:
                writer.mark_incomplete()
                return
            sequence = writer.reserve_sequence()
            self._track(
                asyncio.create_task(
                    _process_final(
                        sentence.text,
                        sentence.language,
                        started_at,
                        sequence,
                        ended_at=ended_at,
                        ingest_id=sentence.ingest_id,
                    )
                ),
                self._writes,
            )

        await session.start(
            agent=Transcriber(
                participant_identity=participant.identity,
                on_final=_on_qwen_final,
                on_failure=writer.mark_incomplete,
            )
        )
        return session

    async def _close_session(self, sess: AgentSession) -> None:
        """Close and cleanup transcription session."""
        try:
            try:
                await sess.drain()
            except RuntimeError as e:
                # livekit-agents 1.4.5 races: on participant disconnect the
                # framework auto-drains the session and a second drain() raises
                # "AgentSession isn't running". Treated as benign; everything
                # else still bubbles up.
                if "isn't running" not in str(e):
                    raise
                logger.debug("session already drained by the framework")
        finally:
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

    # Sprint 2.1: Doubao Pro LLM translator. Disabled gracefully if ARK
    # credentials are missing — the transcriber still runs and persists
    # untranslated transcripts.
    translator = None
    if TRANSLATION_TARGET_LANGS:
        from plugins.doubao_translate import DoubaoTranslator

        translator = DoubaoTranslator.from_env()
        if translator is None:
            logger.warning(
                "TRANSLATION_TARGET_LANGS=%s but ARK_API_KEY / "
                "DOUBAO_LLM_ENDPOINT not set — translations disabled.",
                TRANSLATION_TARGET_LANGS,
            )
        else:
            logger.info(
                "Translation enabled, target_langs=%s", TRANSLATION_TARGET_LANGS
            )

    transcriber = MultiUserTranscriber(
        ctx, writer, translator=translator, target_langs=TRANSLATION_TARGET_LANGS
    )
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    if os.getenv("AGENT_TRANSCRIPT_DELIVERY_ENABLED", "false").lower() == "true":
        await writer.begin_delivery(
            ctx.room.name, await _get_livekit_room_sid(ctx.room)
        )
    transcriber.start()
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
