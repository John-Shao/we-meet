"""Dispatch only into the exact active occurrence with an eligible declaration."""

import asyncio
import json
import logging
from contextlib import closing
from dataclasses import dataclass
from time import time_ns
from uuid import uuid4

from django.conf import settings
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from asgiref.sync import async_to_sync
from livekit import api
from livekit.protocol.agent import JS_PENDING, JS_RUNNING

from core import models, utils
from core.services import voiceprint_sampling as sampling

logger = logging.getLogger(__name__)
RPC_SECONDS = 5
CLOSE_SECONDS = 2
LEASE_SECONDS = 15
RECHECK_SECONDS = 30


@dataclass(frozen=True)
class DispatchLease:
    identifier: object
    token: object
    revision: int
    room_name: str
    room_sid: str
    agent_name: str


class SamplingDispatchError(ValueError):
    """Retryable fixed error without media, credentials or participant identities."""


def reusable(dispatch):
    """An empty provider receipt is a brief launch window, not a live job."""
    jobs = dispatch.state.jobs
    if jobs:
        return any(job.state.status in {JS_PENDING, JS_RUNNING} for job in jobs)
    # LiveKit 1.13.1 uses UnixNano here. Unknown/future timestamps fail closed:
    # do not terminate an unproven launch, including during clock skew.
    created = dispatch.state.created_at
    return created <= 0 or time_ns() - created < RECHECK_SECONDS * 1_000_000_000


def same_dispatch(dispatch, room_sid, agent_name):
    """Only this agent and immutable room occurrence can be reused or replaced."""
    if dispatch.agent_name != agent_name or dispatch.state.deleted_at:
        return False
    try:
        return json.loads(dispatch.metadata) == {
            "voiceprint": {"livekit_room_sid": room_sid}
        }
    except (ValueError, TypeError):
        return False


@async_to_sync
async def send(room_name, room_sid, agent_name):
    try:
        client = utils.create_livekit_client()
        try:
            async with asyncio.timeout(RPC_SECONDS):
                rooms = await client.room.list_rooms(
                    api.ListRoomsRequest(names=[room_name])
                )
                if not any(room.sid == room_sid for room in rooms.rooms):
                    return "ended"
                dispatches = await client.agent_dispatch.list_dispatch(room_name)
                matching = [
                    dispatch
                    for dispatch in dispatches
                    if same_dispatch(dispatch, room_sid, agent_name)
                ]
                if any(reusable(dispatch) for dispatch in matching):
                    return "existing"
                # Replace at most one aged, empty receipt per bounded RPC batch.
                # Re-read it first: LaunchJob may have completed since the list.
                empty = next(
                    (dispatch for dispatch in matching if not dispatch.state.jobs), None
                )
                if empty is not None:
                    current = await client.agent_dispatch.get_dispatch(
                        empty.id, room_name
                    )
                    if current is not None and same_dispatch(
                        current, room_sid, agent_name
                    ):
                        if reusable(current):
                            return "existing"
                        if not current.state.jobs:
                            # A reusable business name can now refer to a new room.
                            rooms = await client.room.list_rooms(
                                api.ListRoomsRequest(names=[room_name])
                            )
                            if not any(room.sid == room_sid for room in rooms.rooms):
                                return "ended"
                            await client.agent_dispatch.delete_dispatch(
                                current.id, room_name
                            )
                await client.agent_dispatch.create_dispatch(
                    api.CreateAgentDispatchRequest(
                        agent_name=agent_name,
                        room=room_name,
                        metadata=json.dumps(
                            {"voiceprint": {"livekit_room_sid": room_sid}}
                        ),
                    )
                )
                return "created"
        finally:
            async with asyncio.timeout(CLOSE_SECONDS):
                await client.aclose()
    except Exception:  # noqa: BLE001 -- Transport and SDK failures become a fixed retryable code.
        raise SamplingDispatchError("sampling_dispatch_unavailable") from None


def configured():
    name = settings.MEETING_VOICEPRINT_SAMPLING_AGENT_NAME
    token = settings.MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN
    return (
        sampling.enabled()
        and isinstance(name, str)
        and 1 <= len(name) <= 128
        and name.strip() == name
        and isinstance(token, str)
        and token.isascii()
        and 32 <= len(token) <= 512
        and not any(char.isspace() for char in token)
    )


def eligible(session):
    """No profile keys or media; each eventual permit rechecks current authority."""
    tracks = (
        models.VoiceprintSamplingTrack.objects.select_related(
            "participation__user", "participation__session__room__organization"
        )
        .filter(
            participation__session=session,
            participation__left_at__isnull=True,
            unpublished_at__isnull=True,
            source="microphone",
            media_type="audio",
            participation__voiceprint_control__paused=False,
            participation__voiceprint_control__shared_microphone=False,
            participation__voiceprint_control__device_group__in=sampling.DEVICE_GROUPS,
        )
        .order_by("pk")
        .iterator(chunk_size=64)
    )
    # Close the PostgreSQL server cursor before this transaction exits/rolls back.
    with closing(tracks):
        for track in tracks:
            try:
                sampling.mapped_owner(track.participation)
                if (
                    sampling.state(track.participation, runtime=False)["state"]
                    == "ready"
                    and min(sampling.remaining(track.participation).values()) >= 3000
                ):
                    return True
            except sampling.VoiceprintError:
                continue
    return False


@transaction.atomic
def enlist(session_id):
    """Persist in the caller's transaction; a broker message is only a wakeup."""
    if not configured():
        return False
    session = (
        models.MeetingSession.objects.select_for_update().filter(pk=session_id).first()
    )
    if session is None or session.status != "active":
        return False
    row, created = models.VoiceprintSamplingDispatch.objects.get_or_create(
        session=session
    )
    if not created:
        changes = {
            "revision": F("revision") + 1,
            "next_attempt_at": timezone.now(),
            "updated_at": timezone.now(),
        }
        if row.status != "running":
            changes.update(status="queued", outcome="")
        models.VoiceprintSamplingDispatch.objects.filter(pk=row.pk).update(**changes)
    return True


@transaction.atomic
def claim(session_id, *, force=False):  # noqa: PLR0911 -- Keep locked lifecycle and lease rejection guards explicit.
    if not configured():
        return "disabled"
    session = (
        models.MeetingSession.objects.select_for_update(skip_locked=True, of=("self",))
        .select_related("room__organization")
        .filter(pk=session_id)
        .first()
    )
    if session is None:
        return (
            "busy"
            if models.MeetingSession.objects.filter(pk=session_id).exists()
            else "ended"
        )
    row = (
        models.VoiceprintSamplingDispatch.objects.select_for_update()
        .filter(session=session)
        .first()
    )
    if row is None:
        return "missing"
    now = timezone.now()
    if row.status == "running" and row.lease_until and row.lease_until > now:
        return "busy"
    if not force and row.next_attempt_at > now:
        return "deferred"
    if session.status != "active" or not session.livekit_room_sid:
        row.status, row.outcome = "ended", "ended"
    elif not eligible(session):
        row.status, row.outcome = "idle", "no_authorized_source"
    else:
        row.status, row.outcome = "running", ""
        row.room_sid = session.livekit_room_sid
        row.agent_name = settings.MEETING_VOICEPRINT_SAMPLING_AGENT_NAME
        row.lease_token = uuid4()
        row.lease_until = now + timezone.timedelta(seconds=LEASE_SECONDS)
        row.last_attempt_at = now
        row.save()
        return DispatchLease(
            row.pk,
            row.lease_token,
            row.revision,
            str(session.room_id),
            row.room_sid,
            row.agent_name,
        )
    row.lease_token = row.lease_until = None
    row.next_attempt_at = now + timezone.timedelta(seconds=RECHECK_SECONDS)
    row.save()
    return row.outcome


@transaction.atomic
def finish(lease, outcome):
    initial = (
        models.VoiceprintSamplingDispatch.objects.filter(pk=lease.identifier)
        .values("session_id")
        .first()
    )
    if initial is None:
        return "ended"
    session = (
        models.MeetingSession.objects.select_for_update(skip_locked=True)
        .filter(pk=initial["session_id"])
        .first()
    )
    if session is None:
        return (
            "busy"
            if models.MeetingSession.objects.filter(pk=initial["session_id"]).exists()
            else "ended"
        )
    row = (
        models.VoiceprintSamplingDispatch.objects.select_for_update()
        .filter(
            pk=lease.identifier,
            status="running",
            lease_token=lease.token,
            lease_until__gt=timezone.now(),
        )
        .first()
    )
    if row is None:
        return "stale"
    now = timezone.now()
    current = (
        configured()
        and session.status == "active"
        and session.livekit_room_sid == lease.room_sid
        and settings.MEETING_VOICEPRINT_SAMPLING_AGENT_NAME == lease.agent_name
        and eligible(session)
    )
    if not current or outcome == "ended":
        row.status = "ended" if session.status != "active" else "idle"
        row.outcome = (
            "ended"
            if row.status == "ended" or outcome == "ended"
            else "no_authorized_source"
        )
        delay = RECHECK_SECONDS
    elif outcome == "sampling_dispatch_unavailable":
        row.status, row.outcome = "failed", outcome
        row.failures = min(row.failures + 1, 6)
        delay = min(300, 5 * 2**row.failures)
    else:
        row.status, row.outcome = "ready", outcome
        row.failures = 0
        delay = RECHECK_SECONDS
    row.next_attempt_at = now + timezone.timedelta(
        seconds=delay if row.revision == lease.revision else 0
    )
    row.lease_token = row.lease_until = None
    row.save()
    return row.outcome


def process(session_id, *, force=False):
    lease = claim(session_id, force=force)
    if not isinstance(lease, DispatchLease):
        return lease
    # Neither a session row lock nor a source cursor spans provider IO.
    try:
        outcome = send(lease.room_name, lease.room_sid, lease.agent_name)
    except SamplingDispatchError:
        finish(lease, "sampling_dispatch_unavailable")
        raise
    return finish(lease, outcome)


def dispatch(session_id):
    """Compatible immediate dispatch; durable callbacks use the same lease."""
    if not enlist(session_id):
        return "disabled" if not configured() else "ended"
    return process(session_id, force=True)


@transaction.atomic
def reconcile(session_id):
    """Recover declarations made before durable dispatch was installed/enabled."""
    session = (
        models.MeetingSession.objects.select_for_update(skip_locked=True)
        .filter(pk=session_id, status="active")
        .first()
    )
    if session is None or not configured():
        return False
    _row, created = models.VoiceprintSamplingDispatch.objects.get_or_create(
        session=session
    )
    return created


@transaction.atomic
def defer_busy(session_id):
    # No session lock is acquired after this metadata-only lock. Rotate a busy
    # room behind other due rooms without blocking its current transaction.
    now = timezone.now()
    row = (
        models.VoiceprintSamplingDispatch.objects.select_for_update(skip_locked=True)
        .filter(session_id=session_id, next_attempt_at__lte=now)
        .first()
    )
    if row and not (
        row.status == "running" and row.lease_until and row.lease_until > now
    ):
        row.next_attempt_at = now + timezone.timedelta(seconds=RECHECK_SECONDS)
        row.save(update_fields=["next_attempt_at", "updated_at"])


def tick(limit=20):
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("sampling_dispatch_limit_invalid")
    counts = dict.fromkeys(
        (
            "created",
            "existing",
            "ended",
            "disabled",
            "busy",
            "missing",
            "deferred",
            "stale",
            "no_authorized_source",
            "failed",
            "reconciled",
        ),
        0,
    )
    if not configured():
        counts["disabled"] = 1
        return counts
    # Ineligible old declarations become idle, so they cannot starve later rooms.
    missing = list(
        models.MeetingSession.objects.filter(
            status="active",
            voiceprint_dispatch__isnull=True,
            participations__voiceprint_control__paused=False,
            participations__voiceprint_control__shared_microphone=False,
            participations__voiceprint_control__device_group__in=sampling.DEVICE_GROUPS,
        )
        .order_by("pk")
        .values_list("pk", flat=True)
        .distinct()[:limit]
    )
    for identifier in missing:
        counts["reconciled"] += int(reconcile(identifier))
    now = timezone.now()
    identifiers = list(
        models.VoiceprintSamplingDispatch.objects.filter(next_attempt_at__lte=now)
        .exclude(status="ended")
        .filter(
            ~Q(status="running") | Q(lease_until__lte=now) | Q(lease_until__isnull=True)
        )
        .order_by("next_attempt_at", "id")
        .values_list("session_id", flat=True)[:limit]
    )
    for identifier in identifiers:
        try:
            result = process(identifier)
        except Exception:  # noqa: BLE001 -- Durable leases recover crashes; diagnostics stay fixed.
            result = "failed"
        if result == "busy":
            defer_busy(identifier)
        counts[result if result in counts else "failed"] += 1
    return counts


def schedule(session_id):
    """Register a task only after the owner/source transaction has committed."""
    if enlist(session_id):
        from core.tasks.voiceprint_sampling import (  # noqa: PLC0415 -- Task registration may import source guards.
            dispatch_voiceprint_sampler,
        )

        def enqueue():
            try:
                dispatch_voiceprint_sampler.delay(str(session_id))
            except Exception:  # noqa: BLE001 -- Optional dispatch must not turn a committed owner edit into a failure.
                logger.warning("sampling_dispatch_enqueue_unavailable", exc_info=False)

        transaction.on_commit(enqueue)
