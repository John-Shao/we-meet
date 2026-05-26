"""AI assistant agent — multimodal voice/video bot for LiveKit rooms.

Backend hands us a fully-resolved JSON metadata blob built by
``core.services.ai_agent_providers.build_agent_metadata``:

* ``profile_code``       — wire-level identifier (qwen, doubao_s2s, doubao_pipeline, …)
* ``architecture``       — ``omni`` (single WS) or ``pipeline`` (STT/LLM/TTS components)
* ``models``             — per-capability dict (``stt`` / ``vlm`` / ``llm`` / ``tts`` /
                           ``omni``) with ``code``, ``vendor``, ``endpoint``,
                           ``api_key_env`` and ``extra_config``
* ``voice``              — voice value resolved by the backend
* ``prompt_content``     — full system prompt
* ``prompt_label``       — short label used as the agent participant name

Routing:

* ``architecture == "omni"`` → :func:`_run_ws_bridge_pipeline` with a per-
  vendor builder (``aliyun`` → Qwen-Omni plugin, ``volcengine`` → Doubao S2S
  plugin).
* ``architecture == "pipeline"`` → :func:`_run_doubao_component_pipeline`,
  the AgentSession-based STT + VLM/LLM-race + TTS stack.

New vendors plug in by adding a builder under ``_OMNI_BUILDERS_BY_VENDOR``;
no DB / wire-format changes are needed.
"""

import asyncio
import base64
import io
import json
import logging
import os

from dotenv import load_dotenv
from livekit import api, rtc
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    JobProcess,
    JobRequest,
    WorkerOptions,
    WorkerPermissions,
    cli,
    llm as lk_llm,
    room_io as lk_room_io,
)
from livekit.plugins import silero
from PIL import Image

load_dotenv()

logger = logging.getLogger("ai-assistant")

AI_AGENT_NAME = os.getenv("AI_AGENT_NAME", "ai-agent")

FRAME_CAPTURE_INTERVAL = float(os.getenv("FRAME_CAPTURE_INTERVAL", "1.0"))
FRAME_WIDTH = 430
FRAME_HEIGHT = 800


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _video_frame_to_base64_jpeg(frame: rtc.VideoFrame) -> str:
    """Convert a LiveKit VideoFrame to a base64-encoded JPEG string."""
    argb_frame = frame.convert(rtc.VideoBufferType.RGBA)
    img = Image.frombytes(
        "RGBA",
        (argb_frame.width, argb_frame.height),
        bytes(argb_frame.data),
    )
    img = img.convert("RGB")
    img = img.resize((FRAME_WIDTH, FRAME_HEIGHT), Image.LANCZOS)

    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=80)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


async def _wait_for_participant(
    room: rtc.Room,
    identity: str,
    timeout: float = 30.0,
) -> rtc.RemoteParticipant:
    for p in room.remote_participants.values():
        if p.identity == identity:
            return p

    future: asyncio.Future[rtc.RemoteParticipant] = asyncio.Future()

    def on_connected(participant: rtc.RemoteParticipant):
        if participant.identity == identity and not future.done():
            future.set_result(participant)

    room.on("participant_connected", on_connected)
    try:
        return await asyncio.wait_for(future, timeout=timeout)
    finally:
        room.off("participant_connected", on_connected)


async def _wait_for_audio_track(
    room: rtc.Room,
    participant: rtc.RemoteParticipant,
    timeout: float = 30.0,
) -> rtc.RemoteAudioTrack:
    for pub in participant.track_publications.values():
        if pub.track and isinstance(pub.track, rtc.RemoteAudioTrack):
            return pub.track

    future: asyncio.Future[rtc.RemoteAudioTrack] = asyncio.Future()

    def on_track_subscribed(track, publication, sub_participant):
        if (
            sub_participant.identity == participant.identity
            and isinstance(track, rtc.RemoteAudioTrack)
            and not future.done()
        ):
            future.set_result(track)

    room.on("track_subscribed", on_track_subscribed)
    try:
        return await asyncio.wait_for(future, timeout=timeout)
    finally:
        room.off("track_subscribed", on_track_subscribed)


async def _wait_for_video_track(
    room: rtc.Room,
    participant: rtc.RemoteParticipant,
    timeout: float = 30.0,
) -> rtc.RemoteVideoTrack:
    for pub in participant.track_publications.values():
        if pub.track and isinstance(pub.track, rtc.RemoteVideoTrack):
            return pub.track

    future: asyncio.Future[rtc.RemoteVideoTrack] = asyncio.Future()

    def on_track_subscribed(track, publication, sub_participant):
        if (
            sub_participant.identity == participant.identity
            and isinstance(track, rtc.RemoteVideoTrack)
            and not future.done()
        ):
            future.set_result(track)

    room.on("track_subscribed", on_track_subscribed)
    try:
        return await asyncio.wait_for(future, timeout=timeout)
    finally:
        room.off("track_subscribed", on_track_subscribed)


# ---------------------------------------------------------------------------
# Provider routing
# ---------------------------------------------------------------------------


class _ProviderBridge:
    """Common shape for Qwen / Doubao clients used by the I/O loops."""

    output_sample_rate: int
    supports_video: bool
    audio_send_mode: str  # "executor_b64" (Qwen) or "async_bytes" (Doubao)

    async def connect(self) -> None: ...
    async def close(self) -> None: ...


def _model_name_from_code(code: str) -> str:
    """Strip the ``vendor/`` prefix to recover the SDK-level model name.

    ``"aliyun/qwen3-omni-flash-realtime"`` → ``"qwen3-omni-flash-realtime"``.
    """
    return code.split("/", 1)[1] if "/" in code else code


def _build_qwen_bridge(omni: dict, voice: str | None, prompt_content: str | None):
    """Build a QwenOmniClient adapter from the resolved omni model info."""
    from plugins.qwen_omni_realtime import (
        DEFAULT_INSTRUCTIONS,
        DEFAULT_MODEL,
        DEFAULT_VOICE,
        OUTPUT_SAMPLE_RATE,
        QwenOmniClient,
    )

    api_key_env = omni.get("api_key_env") or "DASHSCOPE_API_KEY"
    api_key = os.getenv(api_key_env, "")
    if not api_key:
        raise RuntimeError(f"{api_key_env} is not configured")

    model_name = _model_name_from_code(omni.get("code", "")) or DEFAULT_MODEL

    client = QwenOmniClient(
        api_key=api_key,
        model=model_name,
        voice=voice or DEFAULT_VOICE,
        instructions=prompt_content or DEFAULT_INSTRUCTIONS,
    )
    client.output_sample_rate = OUTPUT_SAMPLE_RATE
    client.supports_video = True
    client.audio_send_mode = "executor_b64"
    return client


def _build_doubao_bridge(omni: dict, voice: str | None, prompt_content: str | None):
    """Build a DoubaoS2SClient adapter from the resolved omni model info."""
    from plugins.doubao_s2s_omni import (
        DEFAULT_BOT_NAME,
        DEFAULT_MODEL,
        DEFAULT_SPEAKING_STYLE,
        DEFAULT_SYSTEM_ROLE,
        DEFAULT_VOICE,
        OUTPUT_SAMPLE_RATE,
        DoubaoS2SClient,
    )

    app_id = os.getenv("DOUBAO_S2S_APP_ID", "")
    access_key_env = omni.get("api_key_env") or "DOUBAO_S2S_ACCESS_KEY"
    access_key = os.getenv(access_key_env, "")
    if not app_id or not access_key:
        raise RuntimeError(
            f"DOUBAO_S2S_APP_ID / {access_key_env} are not configured"
        )

    extra = omni.get("extra_config") or {}
    model_version = extra.get("model_version") or DEFAULT_MODEL

    client = DoubaoS2SClient(
        app_id=app_id,
        access_key=access_key,
        model=model_version,
        voice=voice or DEFAULT_VOICE,
        bot_name=extra.get("bot_name", DEFAULT_BOT_NAME),
        system_role=prompt_content or DEFAULT_SYSTEM_ROLE,
        speaking_style=extra.get("speaking_style", DEFAULT_SPEAKING_STYLE),
    )
    client.output_sample_rate = OUTPUT_SAMPLE_RATE
    client.supports_video = False
    client.audio_send_mode = "async_bytes"
    return client


# Adding a new omni provider only requires registering a builder here that
# accepts ``(omni_model_info, voice, prompt_content)``. The DB schema and
# wire format stay unchanged.
_OMNI_BUILDERS_BY_VENDOR = {
    "aliyun": _build_qwen_bridge,
    "volcengine": _build_doubao_bridge,
}


# ---------------------------------------------------------------------------
# Concurrent I/O loops
# ---------------------------------------------------------------------------


async def _audio_input_loop(
    room: rtc.Room,
    participant: rtc.RemoteParticipant,
    bridge,
) -> None:
    try:
        audio_track = await _wait_for_audio_track(room, participant)
    except asyncio.TimeoutError:
        logger.warning("No audio track from %s within timeout", participant.identity)
        return

    logger.info("Audio track acquired for %s", participant.identity)

    audio_stream = rtc.AudioStream(audio_track, sample_rate=16000, num_channels=1)
    loop = asyncio.get_running_loop()

    async for event in audio_stream:
        pcm_bytes = bytes(event.frame.data)
        if bridge.audio_send_mode == "executor_b64":
            pcm_b64 = base64.b64encode(pcm_bytes).decode("utf-8")
            await loop.run_in_executor(None, bridge.send_audio, pcm_b64)
        else:
            await bridge.send_audio(pcm_bytes)


async def _video_input_loop(
    room: rtc.Room,
    participant: rtc.RemoteParticipant,
    bridge,
    interval: float = FRAME_CAPTURE_INTERVAL,
) -> None:
    if not bridge.supports_video:
        return

    try:
        video_track = await _wait_for_video_track(room, participant)
    except asyncio.TimeoutError:
        logger.info(
            "No video track from %s, running audio-only", participant.identity
        )
        return

    logger.info("Video track acquired for %s", participant.identity)

    video_stream = rtc.VideoStream(video_track)
    last_capture_time = 0.0
    loop = asyncio.get_running_loop()

    async for event in video_stream:
        now = loop.time()
        if now - last_capture_time < interval:
            continue
        last_capture_time = now

        try:
            jpeg_b64 = _video_frame_to_base64_jpeg(event.frame)
            await loop.run_in_executor(None, bridge.send_video, jpeg_b64)
        except Exception:
            logger.exception("Frame capture/send error")


async def _audio_output_loop(bridge, audio_source: rtc.AudioSource) -> None:
    while True:
        audio_array = await bridge.audio_output_queue.get()
        try:
            frame = rtc.AudioFrame(
                data=audio_array.tobytes(),
                sample_rate=bridge.output_sample_rate,
                num_channels=1,
                samples_per_channel=len(audio_array),
            )
            await audio_source.capture_frame(frame)
        except Exception:
            logger.exception("Audio output error")


# ---------------------------------------------------------------------------
# Doubao component pipeline (STT + VLM/LLM dual-race + TTS)
#
# Distinct from the ws-bridge path because the component stack plugs into
# livekit-agents' AgentSession (which manages VAD, STT, TTS routing for us)
# and uses a custom ``llm_node`` to call the VLM+LLM dual-race in
# DoubaoVLM. See ``plugins/doubao/`` for the component implementations.
# ---------------------------------------------------------------------------


class _DoubaoPlaceholderLLM(lk_llm.LLM):
    """Stub LLM so AgentSession wires up the STT→LLM→TTS pipeline.

    Real inference is in :meth:`DoubaoAgent.llm_node`; this class only
    needs to exist so livekit-agents recognises that an LLM is present.
    """

    def chat(self, chat_ctx, **kwargs):  # type: ignore[override]
        raise RuntimeError("_DoubaoPlaceholderLLM.chat should never be called")


class DoubaoAgent(Agent):
    """livekit-agents Agent backed by Doubao STT/TTS/VLM components."""

    def __init__(
        self,
        *,
        participant_identity: str,
        conversation_ctx,
        vlm_handler,
        voice: str | None,
        prompt_content: str | None,
    ) -> None:
        from plugins.doubao_pipeline import DoubaoSTT, DoubaoTTS

        # STT/TTS credentials are paired (app_id + access_token), so we keep
        # them on hardcoded env names. The model catalog ``api_key_env`` only
        # tracks the primary token; the matching app_id env is conventional.
        stt = DoubaoSTT(
            app_id=os.getenv("DOUBAO_ASR_APP_ID", ""),
            access_token=os.getenv("DOUBAO_ASR_ACCESS_TOKEN", ""),
        )
        tts = DoubaoTTS(
            app_id=os.getenv("DOUBAO_TTS_APP_ID", ""),
            access_token=os.getenv("DOUBAO_TTS_ACCESS_TOKEN", ""),
            speaker=voice or "zh_female_vv_uranus_bigtts",
        )

        super().__init__(
            instructions=(
                prompt_content
                or "你是一个智能视频助手，可以看到用户的视频画面并与用户进行语音对话。"
            ),
            stt=stt,
            tts=tts,
            llm=_DoubaoPlaceholderLLM(),
        )
        self._identity = participant_identity
        self._ctx = conversation_ctx
        self._vlm = vlm_handler

    async def on_enter(self) -> None:
        logger.info("DoubaoAgent on_enter")
        self.session.say("你好，我是 AI 助手，有什么可以帮您？")

    async def llm_node(self, chat_ctx, tools=None, model_settings=None):
        """VLM + LLM dual-race, streamed token-by-token to the TTS pipeline."""
        msgs = (
            getattr(chat_ctx, "items", None)
            or getattr(chat_ctx, "messages", [])
            or []
        )

        user_text = ""
        for msg in reversed(msgs):
            if str(getattr(msg, "role", "")) != "user":
                continue
            text = getattr(msg, "text_content", None)
            if text is None:
                raw = getattr(msg, "content", None)
                if isinstance(raw, str):
                    text = raw
                elif isinstance(raw, list):
                    for part in raw:
                        if isinstance(part, str):
                            text = part
                            break
                        if isinstance(part, dict) and part.get("type") == "text":
                            text = part.get("text", "")
                            break
            if text:
                user_text = text
                break

        if not user_text:
            logger.warning("llm_node: no user text in chat context")
            return

        logger.info("User said: %s", user_text)
        frame_b64 = await self._ctx.get_latest_frame()
        history = await self._ctx.get_history_snapshot()

        full_response = ""
        async for token in self._vlm.dual_race_stream(
            user_text, frame_b64, history
        ):
            full_response += token
            yield token

        await self._ctx.append_message("user", user_text)
        await self._ctx.append_message("assistant", full_response)


async def _doubao_video_frame_capture_loop(
    room: rtc.Room,
    participant: rtc.RemoteParticipant,
    conversation_ctx,
    vlm,
    interval: float = FRAME_CAPTURE_INTERVAL,
) -> None:
    """Capture video frames, summarise with VLM, accumulate in conversation history."""
    try:
        video_track = await _wait_for_video_track(room, participant)
    except asyncio.TimeoutError:
        logger.info(
            "No video track from %s, running Doubao audio-only", participant.identity
        )
        return

    video_stream = rtc.VideoStream(video_track)
    last_capture_time = 0.0
    loop = asyncio.get_running_loop()

    async for event in video_stream:
        now = loop.time()
        if now - last_capture_time < interval:
            continue
        last_capture_time = now
        try:
            frame_b64 = _video_frame_to_base64_jpeg(event.frame)
            await conversation_ctx.update_frame(frame_b64)
            asyncio.create_task(vlm.summarize_and_store(conversation_ctx, frame_b64))
        except Exception:
            logger.exception("Doubao frame capture/summarise error")


async def _run_doubao_component_pipeline(
    ctx: JobContext,
    participant: rtc.RemoteParticipant,
    metadata: dict,
) -> None:
    """Run the AgentSession-based Doubao component stack."""
    from plugins.doubao_pipeline import DoubaoVLM
    from plugins.doubao_pipeline.vlm import ConversationContext

    models = metadata.get("models", {}) or {}
    vlm_info = models.get("vlm", {}) or {}
    llm_info = models.get("llm", {}) or {}
    prompt_content = metadata.get("prompt_content", "") or ""

    vlm_api_key_env = vlm_info.get("api_key_env") or "ARK_API_KEY"
    conversation_ctx = ConversationContext()
    vlm_handler = DoubaoVLM(
        api_key=os.getenv(vlm_api_key_env, ""),
        vlm_endpoint=vlm_info.get("endpoint") or os.getenv("DOUBAO_VLM_ENDPOINT", ""),
        llm_endpoint=llm_info.get("endpoint") or os.getenv("DOUBAO_LLM_ENDPOINT", ""),
        custom_llm_prompt=prompt_content,
    )

    vad = ctx.proc.userdata.get("vad", None)
    agent = DoubaoAgent(
        participant_identity=participant.identity,
        conversation_ctx=conversation_ctx,
        vlm_handler=vlm_handler,
        voice=metadata.get("voice"),
        prompt_content=prompt_content,
    )

    frame_task = asyncio.create_task(
        _doubao_video_frame_capture_loop(
            ctx.room, participant, conversation_ctx, vlm_handler
        ),
        name="doubao-frame-capture",
    )

    async def cleanup():
        frame_task.cancel()
        try:
            await frame_task
        except asyncio.CancelledError:
            pass

    ctx.add_shutdown_callback(cleanup)

    is_ingress = (
        participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_INGRESS
    )
    # INGRESS devices stream continuous audio that Silero VAD cannot keep
    # up with; Doubao STT detects end-of-utterance on its own.
    vad_to_use = None if is_ingress else vad
    participant_kinds = (
        [
            rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD,
            rtc.ParticipantKind.PARTICIPANT_KIND_SIP,
            rtc.ParticipantKind.PARTICIPANT_KIND_INGRESS,
        ]
        if is_ingress
        else None
    )

    session = AgentSession(vad=vad_to_use)
    await session.start(
        agent=agent,
        room=ctx.room,
        room_options=lk_room_io.RoomOptions(
            audio_input=True,
            audio_output=True,
            participant_identity=participant.identity,
            participant_kinds=participant_kinds,
        ),
    )


# ---------------------------------------------------------------------------
# WS bridge pipeline (Qwen-Omni / Doubao S2S)
# ---------------------------------------------------------------------------


async def _run_ws_bridge_pipeline(
    ctx: JobContext,
    participant: rtc.RemoteParticipant,
    metadata: dict,
) -> None:
    """Bridge LiveKit audio/video tracks to a realtime provider WebSocket."""
    omni = (metadata.get("models", {}) or {}).get("omni") or {}
    vendor = omni.get("vendor", "")
    builder = _OMNI_BUILDERS_BY_VENDOR.get(vendor)
    if builder is None:
        raise RuntimeError(
            f"No omni builder registered for vendor '{vendor}'. "
            f"Available: {sorted(_OMNI_BUILDERS_BY_VENDOR)}"
        )
    bridge = builder(
        omni,
        metadata.get("voice"),
        metadata.get("prompt_content"),
    )
    await bridge.connect()

    audio_source = rtc.AudioSource(bridge.output_sample_rate, 1)
    audio_track = rtc.LocalAudioTrack.create_audio_track(
        "ai-agent-audio", audio_source
    )
    publish_options = rtc.TrackPublishOptions(
        source=rtc.TrackSource.SOURCE_MICROPHONE
    )
    await ctx.room.local_participant.publish_track(audio_track, publish_options)
    logger.info("Audio output track published")

    tasks = [
        asyncio.create_task(
            _audio_input_loop(ctx.room, participant, bridge),
            name="audio-input",
        ),
        asyncio.create_task(
            _video_input_loop(ctx.room, participant, bridge),
            name="video-input",
        ),
        asyncio.create_task(
            _audio_output_loop(bridge, audio_source),
            name="audio-output",
        ),
    ]

    async def cleanup():
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
        await bridge.close()

    ctx.add_shutdown_callback(cleanup)

    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
    for t in done:
        if t.exception():
            logger.error("Task %s failed: %s", t.get_name(), t.exception())


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


_ARCH_PIPELINE = "pipeline"
_ARCH_OMNI = "omni"
_KNOWN_ARCHITECTURES = (_ARCH_PIPELINE, _ARCH_OMNI)


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_ALL)

    raw_metadata = ctx.job.metadata or ""
    try:
        metadata = json.loads(raw_metadata)
    except (json.JSONDecodeError, TypeError):
        metadata = {}

    profile_code = metadata.get("profile_code", "")
    architecture = metadata.get("architecture", "")
    requester_identity = metadata.get("requester_identity", "")
    prompt_label = metadata.get("prompt_label", "") or ""

    if architecture not in _KNOWN_ARCHITECTURES:
        logger.error(
            "Unsupported architecture: %r (profile_code=%r)",
            architecture,
            profile_code,
        )
        return

    if not requester_identity:
        logger.warning("No requester identity in metadata, picking first participant")
        while not ctx.room.remote_participants:
            await asyncio.sleep(0.5)
        requester_identity = next(
            iter(ctx.room.remote_participants.values())
        ).identity

    logger.info(
        "Starting AI assistant (profile=%s, architecture=%s, requester=%s)",
        profile_code,
        architecture,
        requester_identity,
    )

    try:
        participant = await _wait_for_participant(ctx.room, requester_identity)
    except asyncio.TimeoutError:
        logger.error("Target participant %s did not join in time", requester_identity)
        return

    agent_metadata = json.dumps(
        {
            "profile_code": profile_code,
            "prompt_label": prompt_label,
        }
    )
    await ctx.room.local_participant.set_metadata(agent_metadata)

    if prompt_label:
        await ctx.room.local_participant.set_name(prompt_label)

    if architecture == _ARCH_PIPELINE:
        await _run_doubao_component_pipeline(ctx, participant, metadata)
    else:
        await _run_ws_bridge_pipeline(ctx, participant, metadata)


def prewarm(proc: JobProcess) -> None:
    """Preload Silero VAD; only the Doubao component pipeline uses it,
    but loading is cheap and the model is shared per process."""
    if os.getenv("ENABLE_SILERO_VAD", "true").lower() == "true":
        proc.userdata["vad"] = silero.VAD.load()


# ---------------------------------------------------------------------------
# Job request handler
# ---------------------------------------------------------------------------


async def handle_job_request(job_req: JobRequest) -> None:
    """Accept job if no AI assistant exists in the room, otherwise reject."""
    room_name = job_req.room.name
    agent_identity = f"ai-agent-{room_name[:20]}"

    async with api.LiveKitAPI() as lkapi:
        try:
            response = await lkapi.room.list_participants(
                list=api.ListParticipantsRequest(room=room_name)
            )

            agent_exists = any(
                p.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
                and p.identity == agent_identity
                for p in response.participants
            )

            if agent_exists:
                logger.info("AI assistant already exists in %s — rejecting", room_name)
                await job_req.reject()
            else:
                logger.info("Accepting AI assistant job for %s", room_name)
                await job_req.accept(identity=agent_identity, name="AI 助手")
        except Exception:
            logger.exception("Error processing job request for %s", room_name)
            await job_req.reject()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            request_fnc=handle_job_request,
            prewarm_fnc=prewarm,
            agent_name=AI_AGENT_NAME,
            permissions=WorkerPermissions(hidden=False),
        )
    )
