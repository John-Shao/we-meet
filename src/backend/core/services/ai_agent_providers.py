"""AI assistant catalog service — DB-driven profile / model resolution.

Ops manage the entire catalog in Django admin (AIVendor, AIModel,
AIPrompt, AIVoice, AIAgentProfile). This module exposes:

* :func:`get_ai_agent_config` — payload for the ``/rooms/ai-agent-config/``
  endpoint (active profiles, voices grouped by profile, prompts, user
  preference if any).
* :func:`resolve_profile_context` — applies the *request → user pref →
  profile default* selection priority and returns the picked profile,
  voice, and prompt.
* :func:`build_agent_metadata` — packs the resolved context into the
  JSON metadata blob sent to the LiveKit agent worker, including the per-
  capability model ``code`` / ``endpoint`` / ``api_key_env`` / ``extra_config``
  so the worker stays oblivious to the DB.
* :func:`save_user_preference` — upsert ``UserAIPreference`` for
  authenticated users.
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _model_payload(model):
    """Serialise an ``AIModel`` row for inclusion in agent metadata."""
    return {
        "code": model.code,
        "vendor": model.vendor.code,
        "endpoint": model.endpoint,
        "api_key_env": model.api_key_env,
        "extra_config": model.extra_config or {},
    }


def _voice_payload(voice):
    return {
        "id": str(voice.id),
        "value": voice.value,
        "label": voice.label,
    }


def _prompt_payload(prompt):
    return {
        "id": str(prompt.id),
        "label": prompt.label,
        "content": prompt.content,
    }


# ---------------------------------------------------------------------------
# Config endpoint payload
# ---------------------------------------------------------------------------


def get_ai_agent_config(user=None):
    """Return the catalog payload consumed by the frontend selector.

    The shape is:

    ``{"profiles": [...], "prompts": [...], "user_preference": {...} | None}``

    Each profile carries its full voice list and resolved default-voice id.
    Falls back to an empty payload on DB errors so the frontend can still
    render an empty state instead of crashing.
    """
    try:
        from core.models import (
            AIAgentProfile,
            AIVoice,
        )
    except Exception:
        logger.exception("Failed to import AI catalog models")
        return _empty_config()

    try:
        profile_qs = (
            AIAgentProfile.objects.filter(is_active=True)
            .select_related(
                "omni_model__vendor",
                "tts_model__vendor",
                "default_voice",
            )
            .order_by("sort_order", "code")
        )

        # Pre-fetch voices grouped by TTS / Omni model id to avoid N+1.
        voice_qs = AIVoice.objects.filter(is_active=True).order_by(
            "sort_order", "label"
        )
        voices_by_model = {}
        for v in voice_qs:
            voices_by_model.setdefault(v.model_id, []).append(v)

        profiles_payload = []
        for profile in profile_qs:
            voice_source_model = profile.omni_model or profile.tts_model
            voices = voices_by_model.get(voice_source_model.id, []) if voice_source_model else []
            profiles_payload.append({
                "code": profile.code,
                "display_name": profile.display_name,
                "architecture": profile.architecture,
                "voices": [_voice_payload(v) for v in voices],
                "default_voice_id": (
                    str(profile.default_voice_id) if profile.default_voice_id else None
                ),
            })

        prompts = _all_prompts()

        return {
            "profiles": profiles_payload,
            "prompts": prompts,
            "user_preference": _user_preference_payload(user),
        }
    except Exception:
        logger.exception("Failed to load AI catalog from database")
        return _empty_config()


def _all_prompts():
    from core.models import AIPrompt

    return [
        _prompt_payload(p)
        for p in AIPrompt.objects.filter(is_active=True).order_by(
            "sort_order", "label"
        )
    ]


def _empty_config():
    return {
        "profiles": [],
        "prompts": [],
        "user_preference": None,
    }


def _user_preference_payload(user):
    if not user or not getattr(user, "is_authenticated", False):
        return None
    pref = getattr(user, "ai_preference", None)
    if not pref:
        return None
    return {
        "profile_code": pref.profile.code if pref.profile else None,
        "voice_id": str(pref.voice_id) if pref.voice_id else None,
        "prompt_id": str(pref.prompt_id) if pref.prompt_id else None,
    }


# ---------------------------------------------------------------------------
# Profile / voice / prompt resolution
# ---------------------------------------------------------------------------


def resolve_profile_context(
    profile_code: str,
    voice_id: Optional[str] = None,
    prompt_id: Optional[str] = None,
    user=None,
):
    """Resolve the (profile, voice, prompt) triple following the priority:

    Voice:  explicit ``voice_id`` → user preference → profile's ``default_voice``.
    Prompt: explicit ``prompt_id`` → user preference → ``None`` (model & prompt
            are decoupled — the profile no longer carries a default prompt).

    Returns ``(profile, voice, prompt)``. Profile is required; voice and
    prompt may be ``None`` if no fallback is available.
    """
    from core.models import AIAgentProfile, AIPrompt, AIVoice

    profile = (
        AIAgentProfile.objects.filter(code=profile_code, is_active=True)
        .select_related(
            "stt_model__vendor",
            "tts_model__vendor",
            "vlm_model__vendor",
            "llm_model__vendor",
            "omni_model__vendor",
            "default_voice",
        )
        .first()
    )
    if not profile:
        return None, None, None

    pref = None
    if user and getattr(user, "is_authenticated", False):
        pref = getattr(user, "ai_preference", None)

    voice = None
    if voice_id:
        voice = AIVoice.objects.filter(id=voice_id, is_active=True).first()
    if voice is None and pref and pref.voice and pref.voice.is_active:
        voice = pref.voice
    if voice is None:
        voice = profile.default_voice

    prompt = None
    if prompt_id:
        prompt = AIPrompt.objects.filter(id=prompt_id, is_active=True).first()
    if prompt is None and pref and pref.prompt and pref.prompt.is_active:
        prompt = pref.prompt
    # No profile-level prompt fallback by design: model and prompt are
    # decoupled. When neither the request nor the user preference picks a
    # prompt, the agent worker receives empty prompt strings and falls back
    # to its built-in behaviour.

    return profile, voice, prompt


def build_agent_metadata(profile, voice, prompt, requester_identity: str):
    """Pack the resolved context into the JSON metadata for the agent worker."""
    models_payload = {}
    for cap in ("stt", "tts", "vlm", "llm", "omni"):
        model = getattr(profile, f"{cap}_model", None)
        if model is not None:
            models_payload[cap] = _model_payload(model)

    return {
        "requester_identity": requester_identity,
        "profile_code": profile.code,
        "architecture": profile.architecture,
        "models": models_payload,
        "voice": voice.value if voice else None,
        "prompt_label": prompt.label if prompt else "",
        "prompt_content": prompt.content if prompt else "",
    }


def save_user_preference(
    user,
    profile_code: Optional[str] = None,
    voice_id: Optional[str] = None,
    prompt_id: Optional[str] = None,
):
    """Persist a user's last-used selection. No-op for anonymous users."""
    if not user or not getattr(user, "is_authenticated", False):
        return

    from core.models import AIAgentProfile, AIPrompt, AIVoice, UserAIPreference

    profile = (
        AIAgentProfile.objects.filter(code=profile_code).first() if profile_code else None
    )
    voice = AIVoice.objects.filter(id=voice_id).first() if voice_id else None
    prompt = AIPrompt.objects.filter(id=prompt_id).first() if prompt_id else None

    UserAIPreference.objects.update_or_create(
        user=user,
        defaults={"profile": profile, "voice": voice, "prompt": prompt},
    )
