"""LiveKit Events Service"""

# pylint: disable=no-member

import re
import uuid
from enum import Enum
from logging import getLogger

from django.conf import settings

from livekit import api

from core import models, utils
from core.recording.services.metadata_collector import (
    MetadataCollectorException,
    MetadataCollectorService,
)
from core.recording.services.recording_events import (
    RecordingEventsError,
    RecordingEventsService,
)

from .lobby import LobbyService
from .meeting_sessions import (
    MeetingSessionProjectionError,
    MeetingSessionService,
    webhook_event_time,
)
from .telephony import TelephonyException, TelephonyService

logger = getLogger(__name__)


class LiveKitWebhookError(Exception):
    """Base exception for LiveKit webhook processing errors."""

    status_code = 500


class AuthenticationError(LiveKitWebhookError):
    """Authentication failed."""

    status_code = 401


class InvalidPayloadError(LiveKitWebhookError):
    """Invalid webhook payload."""

    status_code = 400


class UnsupportedEventTypeError(LiveKitWebhookError):
    """Unsupported event type."""

    status_code = 422


class ActionFailedError(LiveKitWebhookError):
    """Webhook action fails to process or complete."""

    status_code = 500


class LiveKitWebhookEventType(Enum):
    """LiveKit webhook event types."""

    # Room events
    ROOM_STARTED = "room_started"
    ROOM_FINISHED = "room_finished"

    # Participant events
    PARTICIPANT_JOINED = "participant_joined"
    PARTICIPANT_LEFT = "participant_left"

    # Track events
    TRACK_PUBLISHED = "track_published"
    TRACK_UNPUBLISHED = "track_unpublished"

    # Egress events
    EGRESS_STARTED = "egress_started"
    EGRESS_UPDATED = "egress_updated"
    EGRESS_ENDED = "egress_ended"

    # Ingress events
    INGRESS_STARTED = "ingress_started"
    INGRESS_ENDED = "ingress_ended"


class LiveKitEventsService:
    """Service for processing and handling LiveKit webhook events and notifications."""

    def __init__(self):
        """Initialize with required services."""

        token_verifier = api.TokenVerifier(
            settings.LIVEKIT_CONFIGURATION["api_key"],
            settings.LIVEKIT_CONFIGURATION["api_secret"],
        )
        self.webhook_receiver = api.WebhookReceiver(token_verifier)
        self.lobby_service = LobbyService()
        self.telephony_service = TelephonyService()
        self.recording_events = RecordingEventsService()
        self.meeting_sessions = MeetingSessionService()

        self._filter_regex = None
        if settings.LIVEKIT_WEBHOOK_EVENTS_FILTER_REGEX:
            try:
                self._filter_regex = re.compile(
                    settings.LIVEKIT_WEBHOOK_EVENTS_FILTER_REGEX
                )
            except re.error:
                logger.exception(
                    "Invalid LIVEKIT_WEBHOOK_EVENTS_FILTER_REGEX. Webhook filtering disabled."
                )

    def receive(self, request):
        """Process webhook and route to appropriate handler."""

        auth_token = request.headers.get("Authorization")
        if not auth_token:
            raise AuthenticationError("Authorization header missing")

        try:
            data = self.webhook_receiver.receive(
                request.body.decode("utf-8"), auth_token
            )
        except Exception as e:
            raise InvalidPayloadError("Invalid webhook payload") from e

        room_name = data.room.name or data.egress_info.room_name

        if self._filter_regex and not self._filter_regex.search(room_name):
            logger.info("Filtered webhook event for room '%s'", room_name)
            return

        try:
            webhook_type = LiveKitWebhookEventType(data.event)
        except ValueError as e:
            raise UnsupportedEventTypeError(
                f"Unknown webhook type: {data.event}"
            ) from e

        handler_name = f"_handle_{webhook_type.value}"
        handler = getattr(self, handler_name, None)

        if not handler or not callable(handler):
            return

        logger.info(
            "livekit_webhook.received webhook_event_id=%s event_type=%s "
            "livekit_room_sid=%s room_name=%s",
            data.id,
            data.event,
            data.room.sid,
            room_name,
        )

        # pylint: disable=not-callable
        handler(data)

    def _handle_egress_updated(self, data):
        """Handle 'egress_updated' event."""

        egress_id = data.egress_info.egress_id
        try:
            recording = models.Recording.objects.get(worker_id=egress_id)
        except models.Recording.DoesNotExist as err:
            raise ActionFailedError(
                f"Recording with worker ID {egress_id} does not exist"
            ) from err

        self._bind_recording_session_from_egress(recording, data)

        egress_status = data.egress_info.status
        self.recording_events.handle_update(recording, egress_status)

    def _handle_egress_ended(self, data):
        """Handle 'egress_ended' event."""

        try:
            recording = models.Recording.objects.select_related("room").get(
                worker_id=data.egress_info.egress_id
            )
        except models.Recording.DoesNotExist as err:
            raise ActionFailedError(
                f"Recording with worker ID {data.egress_info.egress_id} does not exist"
            ) from err

        self._bind_recording_session_from_egress(recording, data)

        try:
            room_name = str(recording.room.id)
            utils.update_room_metadata(
                room_name, {}, ["recording_mode", "recording_status"]
            )
        except utils.MetadataUpdateException as e:
            logger.exception("Failed to update room's metadata: %s", e)

        if recording.options.get("metadata_collector_dispatch_id", None) is not None:
            try:
                MetadataCollectorService().stop(recording)
            except MetadataCollectorException:
                logger.warning("Failed to stop the MetadataCollectorService")

        if (
            data.egress_info.status == api.EgressStatus.EGRESS_LIMIT_REACHED
            and recording.status == models.RecordingStatusChoices.ACTIVE
        ):
            try:
                self.recording_events.handle_limit_reached(recording)
            except RecordingEventsError as e:
                raise ActionFailedError(
                    f"Failed to process limit reached event for recording {recording}"
                ) from e

    def _handle_room_started(self, data):
        """Handle 'room_started' event."""

        try:
            room_id = uuid.UUID(data.room.name)
        except ValueError as e:
            logger.warning(
                "Ignoring room event: room name '%s' is not a valid UUID format.",
                data.room.name,
            )
            raise ActionFailedError("Failed to process room started event") from e

        try:
            room = models.Room.objects.get(id=room_id)
        except models.Room.DoesNotExist as err:
            raise ActionFailedError(f"Room with ID {room_id} does not exist") from err

        event_at = webhook_event_time(data)
        try:
            session, _ = self.meeting_sessions.start_from_livekit_room(
                room=room,
                livekit_room=data.room,
                event_at=event_at,
            )
        except MeetingSessionProjectionError as err:
            raise ActionFailedError(
                f"Failed to project meeting session for room {room_id}"
            ) from err

        self._bind_pending_recordings(room, session)

        if settings.ROOM_TELEPHONY_ENABLED:
            try:
                self.telephony_service.create_dispatch_rule(room)
            except TelephonyException as e:
                raise ActionFailedError(
                    f"Failed to create telephony dispatch rule for room {room_id}"
                ) from e

    def _handle_room_finished(self, data):
        """Handle 'room_finished' event."""

        try:
            room_id = uuid.UUID(data.room.name)
        except ValueError as e:
            logger.warning(
                "Ignoring room event: room name '%s' is not a valid UUID format.",
                data.room.name,
            )
            raise ActionFailedError("Failed to process room finished event") from e

        event_at = webhook_event_time(data)
        room = models.Room.objects.filter(id=room_id).first()
        if room is None:
            # A Room may have been deleted while LiveKit was still draining it.
            # Preserve the existing cleanup behaviour without manufacturing an
            # orphan MeetingSession.
            logger.warning(
                "meeting_session.room_missing room_id=%s webhook_event_id=%s",
                room_id,
                data.id,
            )
        else:
            try:
                session, _ = self.meeting_sessions.start_from_livekit_room(
                    room=room,
                    livekit_room=data.room,
                    event_at=event_at,
                )
                self.meeting_sessions.finish(
                    session=session,
                    ended_at=event_at,
                    reason=models.MeetingSession.EndReason.ROOM_FINISHED,
                    event_at=event_at,
                )
            except MeetingSessionProjectionError as err:
                raise ActionFailedError(
                    f"Failed to project meeting session for room {room_id}"
                ) from err

        if settings.ROOM_TELEPHONY_ENABLED:
            try:
                self.telephony_service.delete_dispatch_rule(room_id)
            except TelephonyException as e:
                raise ActionFailedError(
                    f"Failed to delete telephony dispatch rule for room {room_id}"
                ) from e

        try:
            self.lobby_service.clear_room_cache(room_id)
        except Exception as e:
            raise ActionFailedError(
                f"Failed to clear room cache for room {room_id}"
            ) from e

        # Sprint 2.2.b — auto-generate meeting summary + action items
        # once the room is finished. 30s countdown so any in-flight FINAL
        # transcripts land in the DB first. Failures here are logged but
        # never propagate: the summary is a "nice to have" and must not
        # fail the webhook ack.
        try:
            from core.tasks.summary import generate_meeting_summary

            generate_meeting_summary.apply_async(
                args=[str(room_id)], countdown=30
            )
            logger.info(
                "Scheduled meeting summary for room %s (countdown=30s)",
                room_id,
            )
        except Exception:
            logger.exception(
                "Failed to schedule auto summary for room %s — continuing", room_id
            )

    def _resolve_participant_event_session(self, data):
        """Resolve the Room and MeetingSession shared by participant events."""

        try:
            room_id = uuid.UUID(data.room.name)
        except (TypeError, ValueError) as err:
            logger.warning(
                "Ignoring participant event: room name '%s' is not a valid UUID.",
                data.room.name,
            )
            raise ActionFailedError("Failed to process participant event") from err

        try:
            room = models.Room.objects.get(id=room_id)
        except models.Room.DoesNotExist as err:
            raise ActionFailedError(f"Room with ID {room_id} does not exist") from err

        event_at = webhook_event_time(data)
        try:
            session, _ = self.meeting_sessions.start_from_livekit_room(
                room=room,
                livekit_room=data.room,
                event_at=event_at,
            )
        except MeetingSessionProjectionError as err:
            raise ActionFailedError(
                f"Failed to project meeting session for room {room_id}"
            ) from err
        self._bind_pending_recordings(room, session)
        return session, event_at

    @staticmethod
    def _bind_pending_recordings(room, session):
        """Attach recordings created before the first lifecycle webhook arrived."""

        updated = models.Recording.objects.filter(
            room=room,
            session__isnull=True,
            status__in=[
                models.RecordingStatusChoices.INITIATED,
                models.RecordingStatusChoices.ACTIVE,
            ],
        ).update(session=session)
        if updated:
            logger.info(
                "recording.pending_sessions_bound room_id=%s session_id=%s count=%s",
                room.id,
                session.id,
                updated,
            )

    def _bind_recording_session_from_egress(self, recording, data):
        """Use EgressInfo.room_id (the LiveKit room SID) to correct ownership."""

        livekit_room_sid = getattr(data.egress_info, "room_id", None)
        if not isinstance(livekit_room_sid, str) or not livekit_room_sid.strip():
            livekit_room_sid = None
        try:
            self.meeting_sessions.bind_recording(
                recording=recording,
                livekit_room_sid=livekit_room_sid,
                # Egress events may arrive long after a newer room lifecycle
                # has started. Recording creation time preserves late-event
                # ordering and avoids superseding the current session.
                artifact_at=recording.created_at,
            )
        except MeetingSessionProjectionError as err:
            raise ActionFailedError(
                f"Failed to bind recording {recording.id} to a meeting session"
            ) from err

    def _handle_participant_joined(self, data):
        """Handle 'participant_joined' and create one connection interval."""

        session, event_at = self._resolve_participant_event_session(data)
        try:
            self.meeting_sessions.record_participant_join(
                session=session,
                participant=data.participant,
                event_at=event_at,
            )
        except MeetingSessionProjectionError as err:
            raise ActionFailedError(
                "Failed to process participant joined event"
            ) from err

    def _handle_participant_left(self, data):
        """Handle 'participant_left' and close or recover its interval."""

        session, event_at = self._resolve_participant_event_session(data)
        try:
            self.meeting_sessions.record_participant_left(
                session=session,
                participant=data.participant,
                event_at=event_at,
            )
        except MeetingSessionProjectionError as err:
            raise ActionFailedError("Failed to process participant left event") from err
