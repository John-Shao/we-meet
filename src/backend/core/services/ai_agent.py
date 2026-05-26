"""Service for managing the AI assistant agent in LiveKit rooms.

The catalog resolution (profile / voice / prompt) lives in
:mod:`core.services.ai_agent_providers`. This service is intentionally
narrow: dispatch a worker into a room, or remove the worker from a room.
"""

import json
from logging import getLogger

from django.conf import settings

from asgiref.sync import async_to_sync
from livekit.protocol.agent_dispatch import CreateAgentDispatchRequest
from livekit.protocol.room import RoomParticipantIdentity

from core import utils

logger = getLogger(__name__)


class AIAgentException(Exception):
    """Raised when AI assistant agent operations fail."""


def _agent_identity_for(room) -> str:
    """Return the participant identity used by the AI assistant for *room*.

    Mirrors the value chosen inside ``handle_job_request`` in
    ``src/agents/ai_assistant.py`` so the backend can address the right
    participant when stopping the agent.
    """
    return f"ai-agent-{str(room.id)[:20]}"


class AIAgentService:
    """Dispatch / remove the AI assistant agent in a LiveKit room.

    Callers are expected to resolve the profile / voice / prompt via
    :func:`core.services.ai_agent_providers.resolve_profile_context` and
    pack the metadata via :func:`build_agent_metadata` before invoking
    :meth:`start_ai_agent`.
    """

    @async_to_sync
    async def start_ai_agent(self, room, metadata: dict):
        """Dispatch the AI assistant agent into the given room.

        *metadata* is the dict produced by ``build_agent_metadata``; this
        method just JSON-encodes it and hands it to LiveKit Agent
        Dispatch.
        """
        metadata_json = json.dumps(metadata)
        lkapi = utils.create_livekit_client()
        try:
            await lkapi.agent_dispatch.create_dispatch(
                CreateAgentDispatchRequest(
                    agent_name=settings.AI_AGENT_NAME,
                    room=str(room.id),
                    metadata=metadata_json,
                )
            )
        except Exception as e:
            logger.exception(
                "Failed to create AI agent dispatch for room %s", room.id
            )
            raise AIAgentException("Failed to start AI assistant") from e
        finally:
            await lkapi.aclose()

    @async_to_sync
    async def stop_ai_agent(self, room):
        """Remove the AI assistant participant from the given room."""
        lkapi = utils.create_livekit_client()
        try:
            await lkapi.room.remove_participant(
                RoomParticipantIdentity(
                    room=str(room.id),
                    identity=_agent_identity_for(room),
                )
            )
        except Exception as e:
            logger.exception("Failed to remove AI agent for room %s", room.id)
            raise AIAgentException("Failed to stop AI assistant") from e
        finally:
            await lkapi.aclose()
