"""Shared interpretation control: exact meeting, finite languages and private subscriptions."""

from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from core import models
from core.services.meeting_records import RecordConflict
from core.services.meeting_translation import LANGUAGES, MODEL
from core.services.online_capture import can_control

ACTIVE = ("prepared", "starting", "translating", "stopping")
LISTENER_LEASE_SECONDS = 20
MAX_LISTENERS = 100
MAX_SOURCES = 16


def enabled():
    return bool(
        settings.MEETING_INTERPRETATION_ENABLED
        and settings.ROOM_INTERPRETATION_AGENT_NAME
        and settings.CELERY_ENABLED
    )


def present(session, user):
    """Actual authenticated human presence is separate from materials/manager access."""
    if (
        not user
        or not user.is_authenticated
        or not models.User.objects.filter(pk=user.pk, is_active=True).exists()
    ):
        return session.participations.none()
    if session.status != "active":
        return session.participations.none()
    if (
        session.room.organization_id
        and not models.Membership.objects.filter(
            user=user,
            organization_id=session.room.organization_id,
            status=models.MembershipStatusChoices.ACTIVE,
            organization__is_active=True,
        ).exists()
    ):
        return session.participations.none()
    return session.participations.filter(
        user=user, left_at__isnull=True, kind="standard"
    )


def serialize(channel):
    return {
        "id": str(channel.pk),
        "target": channel.target,
        "generation": channel.generation,
        "state": channel.state,
        "error_code": channel.error_code,
    }


def serialize_subscription(row):
    if row is None:
        return None
    remaining = (
        max(
            0.0,
            min(
                LISTENER_LEASE_SECONDS,
                (row.expires_at - timezone.now()).total_seconds(),
            ),
        )
        if row.active
        else 0.0
    )
    return {
        "id": str(row.pk),
        "channel_id": str(row.channel_id),
        "participation_id": str(row.participation_id),
        "revision": row.revision,
        "active": remaining > 0,
        "remaining_lease_seconds": remaining,
        "expires_at": row.expires_at.isoformat(),
    }


def _receipt(session, user, key, payload):
    previous = models.MeetingInterpretationCommand.objects.filter(
        user=user, key=key
    ).first()
    if previous and (previous.session_id != session.pk or previous.payload != payload):
        raise RecordConflict("Interpretation request key conflicts.")
    return previous


def _save_receipt(session, user, key, payload, result):
    models.MeetingInterpretationCommand.objects.create(
        session=session, user=user, key=key, payload=payload, result=result
    )
    return result, False


@transaction.atomic
def control(session_id, user, key, payload):
    session = (
        models.MeetingSession.objects.select_for_update()
        .select_related("room")
        .get(pk=session_id)
    )
    if not models.User.objects.filter(
        pk=user.pk, is_active=True
    ).exists() or not can_control(session, user):
        raise PermissionError
    previous = _receipt(session, user, key, payload)
    if previous:
        return previous.result, True
    target = payload["target"]
    if target not in LANGUAGES:
        raise RecordConflict("Unsupported target language.")
    last = (
        session.interpretation_channels.filter(target=target)
        .order_by("-generation")
        .first()
    )
    if payload["expected_channel_id"] != (str(last.pk) if last else None):
        raise RecordConflict("Interpretation channel changed.")
    if payload["operation"] == "start":
        if (
            not enabled()
            or session.status != "active"
            or (last and last.state in ACTIVE)
        ):
            raise RecordConflict("Interpretation cannot start.")
        last = models.MeetingInterpretationChannel.objects.create(
            session=session,
            requested_by=user,
            organization_id_snapshot=session.room.organization_id,
            target=target,
            generation=last.generation + 1 if last else 1,
            configuration={
                "model": MODEL,
                "target": target,
                "source": None,
                "audio": True,
                "scope": "meeting_channel",
                "max_sources": MAX_SOURCES,
                "max_listeners": MAX_LISTENERS,
            },
        )
    elif payload["operation"] == "stop" and last and last.state in ACTIVE:
        last.stop_requested_at = timezone.now()
        last.state = "stopping" if last.worker_id else "stopped"
        if not last.worker_id:
            last.ended_at = timezone.now()
        last.save(
            update_fields=["state", "stop_requested_at", "ended_at", "updated_at"]
        )
        if not last.worker_id:
            last.subscriptions.filter(active=True).update(
                active=False, updated_at=timezone.now()
            )
    else:
        raise RecordConflict("No active interpretation channel to stop.")
    return _save_receipt(session, user, key, payload, serialize(last))


@transaction.atomic
def subscribe(session_id, user, key, payload):  # noqa: PLR0912 -- join/leave revision checks share one transaction
    session = (
        models.MeetingSession.objects.select_for_update()
        .select_related("room")
        .get(pk=session_id)
    )
    participation = session.participations.filter(
        pk=payload["participation_id"], user=user
    ).first()
    if (
        participation is None
        or not models.User.objects.filter(pk=user.pk, is_active=True).exists()
    ):
        raise PermissionError
    row = models.MeetingInterpretationSubscription.objects.filter(
        participation=participation
    ).first()
    previous = _receipt(session, user, key, payload)
    if previous:
        return previous.result, True
    if payload["expected_revision"] != (row.revision if row else 0):
        raise RecordConflict("Listening choice changed.")
    if payload["operation"] == "leave":
        if row is None or str(row.channel_id) != payload["channel_id"]:
            raise RecordConflict("Listening channel changed.")
        row.active = False
        row.revision += 1
        row.save(update_fields=["active", "revision", "updated_at"])
    elif payload["operation"] == "join":
        if (
            not enabled()
            or not present(session, user).filter(pk=participation.pk).exists()
        ):
            raise PermissionError
        channel = session.interpretation_channels.filter(
            pk=payload["channel_id"], state__in=["prepared", "starting", "translating"]
        ).first()
        if (
            channel is None
            or channel.organization_id_snapshot != session.room.organization_id
        ):
            raise RecordConflict("Interpretation channel is unavailable.")
        active_count = (
            channel.subscriptions.filter(active=True, expires_at__gt=timezone.now())
            .exclude(participation=participation)
            .count()
        )
        if active_count >= MAX_LISTENERS:
            raise RecordConflict("Interpretation listener limit reached.")
        expires = timezone.now() + timedelta(seconds=LISTENER_LEASE_SECONDS)
        if row:
            row.channel, row.active, row.expires_at = channel, True, expires
            row.revision += 1
            row.save(
                update_fields=[
                    "channel",
                    "active",
                    "expires_at",
                    "revision",
                    "updated_at",
                ]
            )
        else:
            row = models.MeetingInterpretationSubscription.objects.create(
                channel=channel,
                participation=participation,
                user=user,
                expires_at=expires,
            )
        # Prepared channels do not consume audio before someone explicitly listens.
        if channel.state == "prepared":
            channel.state = "starting"
            channel.start_requested_at = timezone.now()
            channel.save(update_fields=["state", "start_requested_at", "updated_at"])
    else:
        raise RecordConflict("Unsupported listening operation.")
    return _save_receipt(session, user, key, payload, serialize_subscription(row))


@transaction.atomic
def renew(session_id, user, participation_id, channel_id, revision):
    session = (
        models.MeetingSession.objects.select_for_update()
        .select_related("room")
        .get(pk=session_id)
    )
    if not enabled() or not present(session, user).filter(pk=participation_id).exists():
        raise PermissionError
    row = (
        models.MeetingInterpretationSubscription.objects.select_related("channel")
        .filter(
            participation_id=participation_id,
            user=user,
            channel_id=channel_id,
            revision=revision,
            active=True,
            expires_at__gt=timezone.now(),
            channel__state__in=["starting", "translating"],
        )
        .first()
    )
    if (
        row is None
        or row.channel.organization_id_snapshot != session.room.organization_id
    ):
        raise RecordConflict("Listening lease expired or changed.")
    row.expires_at = timezone.now() + timedelta(seconds=LISTENER_LEASE_SECONDS)
    row.save(update_fields=["expires_at", "updated_at"])
    return serialize_subscription(row)


def grants(channel):
    """Internal worker-only membership, freshly filtered; never sent to room clients."""
    session = channel.session
    if (
        session.status != "active"
        or session.room.organization_id != channel.organization_id_snapshot
        or not models.User.objects.filter(
            pk=channel.requested_by_id, is_active=True
        ).exists()
        or not can_control(session, channel.requested_by)
    ):
        return {"sources": [], "listeners": [], "stop": True}
    sources = list(
        session.participations.filter(kind="standard", left_at__isnull=True)
        .exclude(identity="")
        .order_by("id")[: MAX_SOURCES + 1]
    )
    if len(sources) > MAX_SOURCES:
        raise RecordConflict("Interpretation source limit reached.")
    listeners = []
    for row in channel.subscriptions.filter(
        active=True, expires_at__gt=timezone.now()
    ).select_related("participation", "user"):
        if present(session, row.user).filter(pk=row.participation_id).exists():
            listeners.append(
                {
                    "identity": row.participation.identity,
                    "participant_sid": row.participation.livekit_participant_sid,
                    "subscription_id": str(row.pk),
                    "revision": row.revision,
                }
            )
    return {
        "sources": [
            {
                "identity": source.identity,
                "participant_sid": source.livekit_participant_sid,
                "participation_id": str(source.pk),
            }
            for source in sources
        ],
        "listeners": listeners,
        "stop": False,
    }
