"""Project LiveKit room and participant events into durable meeting sessions."""

# Protobuf exports are assembled dynamically and are invisible to pylint.
# pylint: disable=no-member

from datetime import datetime
from datetime import timezone as datetime_timezone
from logging import getLogger

from django.db import transaction
from django.db.models import Case, DateTimeField, F, Value, When
from django.utils import timezone

from livekit import api

from core import models

logger = getLogger(__name__)


class MeetingSessionProjectionError(Exception):
    """A LiveKit event cannot be projected without violating session identity."""


class MeetingSessionRoomMismatch(MeetingSessionProjectionError):
    """A LiveKit room SID was already associated with a different Room."""


class MeetingParticipantMismatch(MeetingSessionProjectionError):
    """A participant SID was reused with a different identity."""


_START_SOURCE_PRIORITY = {
    models.MeetingSession.StartSource.LEGACY: 0,
    models.MeetingSession.StartSource.TRANSCRIPT: 1,
    models.MeetingSession.StartSource.WEBHOOK: 2,
    models.MeetingSession.StartSource.LIVEKIT_ROOM: 3,
}

_END_REASON_PRIORITY = {
    models.MeetingSession.EndReason.LEGACY: 0,
    models.MeetingSession.EndReason.RECONCILED: 1,
    models.MeetingSession.EndReason.SUPERSEDED: 2,
    models.MeetingSession.EndReason.OWNER_ENDED: 3,
    models.MeetingSession.EndReason.ROOM_FINISHED: 4,
}


def _aware(value):
    """Return an aware datetime, treating naive values as UTC."""

    if value is None:
        return None
    if timezone.is_naive(value):
        return timezone.make_aware(value, datetime_timezone.utc)
    return value


def _positive_number(value):
    """Return whether a protobuf scalar is a usable positive timestamp."""

    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def _unix_datetime(value, divisor=1):
    if not _positive_number(value):
        return None
    try:
        return datetime.fromtimestamp(value / divisor, tz=datetime_timezone.utc)
    except (OSError, OverflowError, ValueError):
        return None


def webhook_event_time(event):
    """Use LiveKit's event time and fall back to backend receipt time."""

    event_at = _unix_datetime(getattr(event, "created_at", None))
    return event_at or timezone.now()


def livekit_room_start(livekit_room, fallback=None):
    """Return the best available room start time and its provenance."""

    started_at = _unix_datetime(
        getattr(livekit_room, "creation_time_ms", None), divisor=1000
    )
    if started_at is not None:
        return started_at, models.MeetingSession.StartSource.LIVEKIT_ROOM

    started_at = _unix_datetime(getattr(livekit_room, "creation_time", None))
    if started_at is not None:
        return started_at, models.MeetingSession.StartSource.LIVEKIT_ROOM

    return _aware(fallback) or timezone.now(), models.MeetingSession.StartSource.WEBHOOK


def participant_join_time(participant, fallback=None):
    """Return the best available participant join time."""

    joined_at = _unix_datetime(getattr(participant, "joined_at_ms", None), divisor=1000)
    if joined_at is not None:
        return joined_at

    joined_at = _unix_datetime(getattr(participant, "joined_at", None))
    return joined_at or _aware(fallback) or timezone.now()


def _enum_label(enum_wrapper, value):
    """Persist known protobuf names while remaining forward-compatible."""

    try:
        return enum_wrapper.Name(int(value)).lower()
    except (TypeError, ValueError):
        try:
            number = int(value)
        except (TypeError, ValueError):
            return "unknown"
        return f"unknown:{number}"


def _latest(first, second):
    if first is None:
        return second
    if second is None:
        return first
    return max(first, second)


class MeetingSessionService:
    """The only write path for MeetingSession lifecycle projection."""

    @staticmethod
    def _validate_sid(livekit_room_sid):
        if not isinstance(livekit_room_sid, str) or not livekit_room_sid.strip():
            raise MeetingSessionProjectionError("LiveKit room SID is missing")
        if len(livekit_room_sid) > 64:
            raise MeetingSessionProjectionError("LiveKit room SID is too long")
        return livekit_room_sid.strip()

    @staticmethod
    def _close_open_participations(session, ended_at):
        models.MeetingParticipation.objects.filter(
            session=session, left_at__isnull=True
        ).update(
            left_at=Case(
                When(joined_at__gt=ended_at, then=F("joined_at")),
                default=Value(ended_at),
                output_field=DateTimeField(),
            )
        )

    def _finish_locked(self, session, ended_at, reason, event_at=None):
        ended_at = max(_aware(ended_at) or timezone.now(), session.started_at)
        event_at = _aware(event_at) or ended_at

        if session.status == models.MeetingSession.Status.ENDED:
            if _END_REASON_PRIORITY[reason] > _END_REASON_PRIORITY[session.end_reason]:
                session.ended_at = ended_at
                session.end_reason = reason
            session.last_event_at = _latest(session.last_event_at, event_at)
            session.save(
                update_fields=["ended_at", "end_reason", "last_event_at", "updated_at"]
            )
            self._close_open_participations(session, session.ended_at)
            return session, False

        session.status = models.MeetingSession.Status.ENDED
        session.ended_at = ended_at
        session.end_reason = reason
        session.last_event_at = _latest(session.last_event_at, event_at)
        session.save(
            update_fields=[
                "status",
                "ended_at",
                "end_reason",
                "last_event_at",
                "updated_at",
            ]
        )
        self._close_open_participations(session, ended_at)
        logger.info(
            "meeting_session.finished room_id=%s session_id=%s "
            "livekit_room_sid=%s end_reason=%s",
            session.room_id,
            session.id,
            session.livekit_room_sid,
            reason,
        )
        return session, True

    # pylint: disable-next=too-many-arguments
    def start_or_reconcile(
        self,
        *,
        room,
        livekit_room_sid,
        started_at,
        start_source,
        event_at=None,
    ):
        """Idempotently resolve a LiveKit SID to exactly one meeting session.

        A late event for an older SID creates an already-ended historical row
        instead of superseding a newer active session.
        """

        livekit_room_sid = self._validate_sid(livekit_room_sid)
        started_at = _aware(started_at) or timezone.now()
        event_at = _aware(event_at) or started_at

        with transaction.atomic():
            locked_room = models.Room.objects.select_for_update().get(pk=room.pk)
            existing = (
                models.MeetingSession.objects.select_for_update()
                .filter(livekit_room_sid=livekit_room_sid)
                .first()
            )
            if existing is not None:
                if existing.room_id != locked_room.id:
                    logger.error(
                        "meeting_session.room_sid_mismatch room_id=%s "
                        "existing_room_id=%s livekit_room_sid=%s",
                        locked_room.id,
                        existing.room_id,
                        livekit_room_sid,
                    )
                    raise MeetingSessionRoomMismatch(
                        "LiveKit room SID belongs to a different Room"
                    )

                update_fields = []
                if _START_SOURCE_PRIORITY[start_source] > _START_SOURCE_PRIORITY[
                    existing.start_source
                ] and (existing.ended_at is None or started_at <= existing.ended_at):
                    existing.started_at = started_at
                    existing.start_source = start_source
                    update_fields.extend(["started_at", "start_source"])

                latest_event = _latest(existing.last_event_at, event_at)
                if latest_event != existing.last_event_at:
                    existing.last_event_at = latest_event
                    update_fields.append("last_event_at")

                if update_fields:
                    existing.save(update_fields=[*update_fields, "updated_at"])
                return existing, False

            active = (
                models.MeetingSession.objects.select_for_update()
                .filter(room=locked_room, status=models.MeetingSession.Status.ACTIVE)
                .first()
            )

            create_values = {
                "room": locked_room,
                "livekit_room_sid": livekit_room_sid,
                "started_at": started_at,
                "start_source": start_source,
                "last_event_at": event_at,
            }
            if active is not None and started_at < active.started_at:
                create_values.update(
                    status=models.MeetingSession.Status.ENDED,
                    ended_at=active.started_at,
                    end_reason=models.MeetingSession.EndReason.SUPERSEDED,
                )
            else:
                if active is not None:
                    self._finish_locked(
                        active,
                        started_at,
                        models.MeetingSession.EndReason.SUPERSEDED,
                        event_at,
                    )
                    logger.warning(
                        "meeting_session.superseded room_id=%s session_id=%s "
                        "new_livekit_room_sid=%s",
                        locked_room.id,
                        active.id,
                        livekit_room_sid,
                    )
                create_values["status"] = models.MeetingSession.Status.ACTIVE

            session = models.MeetingSession.objects.create(**create_values)
            logger.info(
                "meeting_session.created room_id=%s session_id=%s "
                "livekit_room_sid=%s status=%s",
                locked_room.id,
                session.id,
                livekit_room_sid,
                session.status,
            )
            return session, True

    def start_from_livekit_room(self, *, room, livekit_room, event_at=None):
        """Resolve a protobuf Room object into a meeting session."""

        event_at = _aware(event_at) or timezone.now()
        started_at, source = livekit_room_start(livekit_room, event_at)
        return self.start_or_reconcile(
            room=room,
            livekit_room_sid=getattr(livekit_room, "sid", None),
            started_at=started_at,
            start_source=source,
            event_at=event_at,
        )

    def finish(self, *, session, ended_at, reason, event_at=None):
        """Idempotently end a session and close dangling participant intervals."""

        with transaction.atomic():
            locked = models.MeetingSession.objects.select_for_update().get(
                pk=session.pk
            )
            return self._finish_locked(locked, ended_at, reason, event_at)

    def record_participant_join(self, *, session, participant, event_at=None):
        """Upsert one participant connection without reopening a closed interval."""

        event_at = _aware(event_at) or timezone.now()
        sid = getattr(participant, "sid", None)
        identity = getattr(participant, "identity", None)
        if not isinstance(sid, str) or not sid.strip():
            raise MeetingSessionProjectionError("LiveKit participant SID is missing")
        if not isinstance(identity, str) or not identity:
            raise MeetingSessionProjectionError(
                "LiveKit participant identity is missing"
            )

        joined_at = participant_join_time(participant, event_at)
        display_name = getattr(participant, "name", "") or ""
        kind = _enum_label(api.ParticipantInfo.Kind, getattr(participant, "kind", 0))

        with transaction.atomic():
            locked_session = models.MeetingSession.objects.select_for_update().get(
                pk=session.pk
            )
            participation = (
                models.MeetingParticipation.objects.select_for_update()
                .filter(
                    session=locked_session,
                    livekit_participant_sid=sid.strip(),
                )
                .first()
            )
            if participation is not None:
                if participation.identity != identity:
                    raise MeetingParticipantMismatch(
                        "LiveKit participant SID was reused by another identity"
                    )
                participation.joined_at = min(participation.joined_at, joined_at)
                if display_name:
                    participation.display_name = display_name
                participation.kind = kind
                participation.save(
                    update_fields=["joined_at", "display_name", "kind", "updated_at"]
                )
            else:
                left_at = None
                if locked_session.status == models.MeetingSession.Status.ENDED:
                    left_at = max(locked_session.ended_at, joined_at)
                participation = models.MeetingParticipation.objects.create(
                    session=locked_session,
                    livekit_participant_sid=sid.strip(),
                    user=models.User.objects.filter(sub=identity).first(),
                    identity=identity,
                    display_name=display_name,
                    kind=kind,
                    joined_at=joined_at,
                    left_at=left_at,
                )

            latest_event = _latest(locked_session.last_event_at, event_at)
            if latest_event != locked_session.last_event_at:
                locked_session.last_event_at = latest_event
                locked_session.save(update_fields=["last_event_at", "updated_at"])
            return participation

    def record_participant_left(self, *, session, participant, event_at=None):
        """Close a participant interval, recovering a missing join when necessary."""

        event_at = _aware(event_at) or timezone.now()
        sid = getattr(participant, "sid", None)
        identity = getattr(participant, "identity", None)
        if not isinstance(sid, str) or not sid.strip():
            raise MeetingSessionProjectionError("LiveKit participant SID is missing")
        if not isinstance(identity, str) or not identity:
            raise MeetingSessionProjectionError(
                "LiveKit participant identity is missing"
            )

        joined_at = participant_join_time(participant, event_at)
        left_at = max(event_at, joined_at)
        display_name = getattr(participant, "name", "") or ""
        kind = _enum_label(api.ParticipantInfo.Kind, getattr(participant, "kind", 0))
        disconnect_reason = _enum_label(
            api.DisconnectReason,
            getattr(participant, "disconnect_reason", 0),
        )

        with transaction.atomic():
            locked_session = models.MeetingSession.objects.select_for_update().get(
                pk=session.pk
            )
            participation = (
                models.MeetingParticipation.objects.select_for_update()
                .filter(
                    session=locked_session,
                    livekit_participant_sid=sid.strip(),
                )
                .first()
            )
            if participation is None:
                participation = models.MeetingParticipation.objects.create(
                    session=locked_session,
                    livekit_participant_sid=sid.strip(),
                    user=models.User.objects.filter(sub=identity).first(),
                    identity=identity,
                    display_name=display_name,
                    kind=kind,
                    joined_at=joined_at,
                    left_at=left_at,
                    disconnect_reason=disconnect_reason,
                )
                logger.warning(
                    "meeting_participation.join_recovered room_id=%s "
                    "session_id=%s livekit_participant_sid=%s",
                    locked_session.room_id,
                    locked_session.id,
                    sid,
                )
            else:
                if participation.identity != identity:
                    raise MeetingParticipantMismatch(
                        "LiveKit participant SID was reused by another identity"
                    )
                participation.joined_at = min(participation.joined_at, joined_at)
                was_inferred_at_session_end = (
                    not participation.disconnect_reason
                    and locked_session.ended_at is not None
                    and participation.left_at == locked_session.ended_at
                )
                participation.left_at = (
                    left_at
                    if was_inferred_at_session_end
                    else _latest(participation.left_at, left_at)
                )
                if display_name:
                    participation.display_name = display_name
                participation.kind = kind
                participation.disconnect_reason = disconnect_reason
                participation.save(
                    update_fields=[
                        "joined_at",
                        "left_at",
                        "display_name",
                        "kind",
                        "disconnect_reason",
                        "updated_at",
                    ]
                )

            latest_event = _latest(locked_session.last_event_at, event_at)
            if latest_event != locked_session.last_event_at:
                locked_session.last_event_at = latest_event
                locked_session.save(update_fields=["last_event_at", "updated_at"])
            return participation
