"""One worker per shared channel; bounded start/stop and current recipient grants."""

import asyncio
import json
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from asgiref.sync import async_to_sync
from livekit.protocol.agent_dispatch import CreateAgentDispatchRequest

from core import models, utils
from core.services import meeting_interpretation as channels
from core.services.meeting_records import RecordConflict


def _locked(channel_id):
    row = models.MeetingInterpretationChannel.objects.get(pk=channel_id)
    models.MeetingSession.objects.select_for_update().get(pk=row.session_id)
    return models.MeetingInterpretationChannel.objects.select_related(
        "session__room", "requested_by"
    ).get(pk=channel_id)


def _end(row, state, error=""):
    row.state, row.error_code, row.ended_at = state, error, timezone.now()
    row.save(update_fields=["state", "error_code", "ended_at", "updated_at"])
    row.subscriptions.filter(active=True).update(
        active=False, updated_at=timezone.now()
    )


def _stop(row, error="", *, revoke=True):
    if row.state not in channels.ACTIVE:
        return
    if not row.worker_id:
        _end(row, "stopped", error)
        return
    if row.state != "stopping":
        row.state, row.stop_requested_at = "stopping", timezone.now()
    if error:
        row.error_code = error
    row.save(update_fields=["state", "stop_requested_at", "error_code", "updated_at"])
    if revoke:
        row.subscriptions.filter(active=True).update(
            active=False, updated_at=timezone.now()
        )


def _expire(row):
    if row.state not in channels.ACTIVE:
        return
    now = timezone.now()
    if row.worker_id:
        deadline = (row.heartbeat_at or row.updated_at) + timedelta(seconds=15)
        if row.stop_requested_at:
            deadline = min(deadline, row.stop_requested_at + timedelta(seconds=25))
        if deadline <= now:
            _end(row, "incomplete", "interpretation_worker_expired")
    elif (
        row.state == "starting"
        and (row.start_requested_at or row.created_at) + timedelta(seconds=60) <= now
    ):
        _end(row, "incomplete", "interpretation_start_expired")


def _current_grants(row):
    try:
        result = channels.grants(row)
    except RecordConflict:
        _stop(row, "interpretation_source_limit")
        return {"sources": [], "listeners": [], "stop": True}
    if result["stop"] or not channels.enabled():
        _stop(row, "interpretation_access_changed")
        return {"sources": [], "listeners": [], "stop": True}
    if row.state != "prepared" and not result["listeners"]:
        _stop(row, "interpretation_no_listeners")
        return {"sources": [], "listeners": [], "stop": True}
    return result


@transaction.atomic
def agent_control(channel_id, data):
    row = _locked(channel_id)
    if (
        str(row.session.room_id) != str(data["room_id"])
        or row.session.livekit_room_sid != data["livekit_room_sid"]
        or row.generation != data["generation"]
    ):
        raise RecordConflict("Interpretation source or generation mismatch.")
    _expire(row)
    operation = data["operation"]
    if operation == "claim" and row.worker_id is None:
        if row.state != "starting":
            return {"state": row.state}
        grant = _current_grants(row)
        if grant["stop"] or not grant["listeners"]:
            return {"state": row.state}
        row.worker_id, row.state, row.heartbeat_at = (
            data["worker_id"],
            "translating",
            timezone.now(),
        )
        row.error_code = ""
        row.save(
            update_fields=[
                "worker_id",
                "state",
                "heartbeat_at",
                "error_code",
                "updated_at",
            ]
        )
    if row.worker_id != data["worker_id"]:
        raise RecordConflict("Interpretation belongs to a different worker.")
    if operation == "finish":
        receipt = data["receipt"]
        if row.finish_receipt is not None:
            if row.finish_receipt != receipt:
                raise RecordConflict("Interpretation finish receipt conflicts.")
        elif row.state in channels.ACTIVE:
            row.finish_receipt = receipt
            row.save(update_fields=["finish_receipt", "updated_at"])
            complete = receipt["provider_finished"] and receipt["consumer_finished"]
            _end(
                row,
                "stopped" if complete else "incomplete",
                row.error_code if complete else "interpretation_incomplete",
            )
        return {"state": row.state}
    if row.state not in channels.ACTIVE:
        return {"state": row.state}
    grant = _current_grants(row)
    row.heartbeat_at = timezone.now()
    row.save(update_fields=["heartbeat_at", "updated_at"])
    result = {"state": row.state, "lease_seconds": 15}
    if row.state == "translating":
        result.update(
            configuration=row.configuration,
            sources=grant["sources"],
            listeners=grant["listeners"],
        )
    elif row.state == "stopping" and not grant["stop"]:
        result.update(deliver_tail=True, sources=[], listeners=grant["listeners"])
    return result


@async_to_sync
async def _send_dispatch(row):
    client = utils.create_livekit_client()
    try:
        async with asyncio.timeout(8):
            await client.agent_dispatch.create_dispatch(
                CreateAgentDispatchRequest(
                    agent_name=settings.ROOM_INTERPRETATION_AGENT_NAME,
                    room=str(row.session.room_id),
                    metadata=json.dumps(
                        {
                            "interpretation": {
                                "channel_id": str(row.pk),
                                "generation": row.generation,
                                "livekit_room_sid": row.session.livekit_room_sid,
                            }
                        }
                    ),
                )
            )
    finally:
        await client.aclose()


def dispatch(channel_id):
    with transaction.atomic():
        row = _locked(channel_id)
        _expire(row)
        if row.state not in channels.ACTIVE:
            return False
        grant = _current_grants(row)
        # Rotate inspected idle/live rows; prepared channels must not starve later work.
        # Startup and worker deadlines use their own immutable start/heartbeat fields.
        row.save(update_fields=["updated_at"])
        if row.state != "starting" or row.worker_id or grant["stop"]:
            return False
        if (
            row.dispatched_at
            and row.dispatched_at + timedelta(seconds=15) > timezone.now()
        ):
            return False
        row.dispatched_at = timezone.now()
        row.save(update_fields=["dispatched_at", "updated_at"])
    try:
        _send_dispatch(row)
    except Exception:  # noqa: BLE001 -- external errors can contain connection credentials
        models.MeetingInterpretationChannel.objects.filter(
            pk=channel_id, state="starting"
        ).update(error_code="interpretation_dispatch_unavailable")
        return False
    return True


def tick_interpretations():
    if not settings.CELERY_ENABLED:
        return 0
    ids = list(
        models.MeetingInterpretationChannel.objects.filter(state__in=channels.ACTIVE)
        .order_by("updated_at", "id")
        .values_list("pk", flat=True)[:20]
    )
    for channel_id in ids:
        dispatch(channel_id)
    return len(ids)
