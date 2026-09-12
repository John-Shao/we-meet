"""Private, exact-session translation control with one claimed worker per generation."""

import asyncio
import json
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from asgiref.sync import async_to_sync
from livekit.protocol.agent_dispatch import CreateAgentDispatchRequest

from core import models, utils
from core.services.meeting_records import RecordConflict
from core.services.online_capture import can_control

ACTIVE = ("starting", "translating", "stopping")
LANGUAGES = ("zh", "en")
MODEL = "qwen3.5-livetranslate-flash-realtime"


def enabled():
    """Unconfigured workers cannot create an apparently available product feature."""
    return bool(
        settings.MEETING_TRANSLATION_ENABLED
        and settings.ROOM_TRANSLATION_AGENT_NAME
        and settings.CELERY_ENABLED
    )


def latest(session, user):
    """Never return another controller's private translation metadata."""
    return (
        models.MeetingTranslationRun.objects.filter(session=session, requested_by=user)
        .order_by("-generation")
        .first()
    )


def serialize(run):
    """No worker credential, audio, transcript or destination identity is public."""
    if run is None:
        return None
    return {
        "id": str(run.pk),
        "generation": run.generation,
        "state": run.state,
        "configuration": run.configuration,
        "source_participant_sid": run.source_participation.livekit_participant_sid
        if run.source_participation
        else None,
        "error_code": run.error_code,
    }


def _source_valid(run, session):
    source = run.source_participation
    return bool(
        session.status == "active"
        and session.room.organization_id == run.organization_id_snapshot
        and can_control(session, run.requested_by)
        and source
        and source.session_id == session.pk
        and source.user_id == run.requested_by_id
        and source.left_at is None
        and source.kind == "standard"
    )


@transaction.atomic
def control(session_id, user, key, payload):
    """Serialize starts/stops against the exact meeting and immutable intent key."""
    session = models.MeetingSession.objects.select_for_update().get(pk=session_id)
    if not can_control(session, user):
        raise PermissionError
    command = models.MeetingTranslationCommand.objects.filter(
        user=user, key=key
    ).first()
    run = latest(session, user)
    if command:
        if command.session_id != session.pk or command.payload != payload:
            raise RecordConflict("Translation key has a different intent.")
        return command.result, run, True
    if payload["expected_run_id"] != (str(run.pk) if run else None):
        raise RecordConflict("Translation generation changed; refresh first.")
    if payload["operation"] == "start":
        if not enabled() or session.status != "active":
            raise RecordConflict("Translation is unavailable.")
        if run and run.state in ACTIVE:
            raise RecordConflict("Stop the current translation before switching.")
        source = models.MeetingParticipation.objects.filter(
            pk=payload["source_participation_id"],
            session=session,
            user=user,
            left_at__isnull=True,
            kind="standard",
        ).first()
        if source is None:
            raise RecordConflict("An active personal source connection is required.")
        source_language, target_language = payload["source"], payload["target"]
        if (
            source_language not in LANGUAGES
            or target_language not in LANGUAGES
            or source_language == target_language
        ):
            raise RecordConflict("Unsupported translation language pair.")
        if payload["mode"] not in ("simultaneous", "push_to_talk"):
            raise RecordConflict("Unsupported translation mode.")
        run = models.MeetingTranslationRun.objects.create(
            session=session,
            requested_by=user,
            source_participation=source,
            organization_id_snapshot=session.room.organization_id,
            generation=run.generation + 1 if run else 1,
            configuration={
                "source": source_language,
                "target": target_language,
                "mode": payload["mode"],
                "audio": payload["audio"],
                "model": MODEL,
                "scope": "controller_only",
            },
        )
        transaction.on_commit(lambda run_id=run.pk: dispatch(run_id))
    elif payload["operation"] == "stop" and run:
        _request_stop(run)
    else:
        raise RecordConflict("There is no translation to stop.")
    result = serialize(run)
    models.MeetingTranslationCommand.objects.create(
        session=session,
        user=user,
        key=key,
        payload=payload,
        result=result,
    )
    return result, run, False


def _request_stop(run):
    if run.state in ("starting", "translating"):
        run.state = "stopping"
        run.stop_requested_at = timezone.now()
        run.save(update_fields=["state", "stop_requested_at", "updated_at"])


def _locked(run_id):
    identity = models.MeetingTranslationRun.objects.get(pk=run_id)
    session = models.MeetingSession.objects.select_for_update().get(
        pk=identity.session_id
    )
    return models.MeetingTranslationRun.objects.get(pk=run_id), session


def _expire(run):
    if run.state not in ACTIVE:
        return
    now = timezone.now()
    deadline = (run.heartbeat_at or run.created_at) + timedelta(
        seconds=30 if run.worker_id else 60
    )
    if run.stop_requested_at:
        deadline = min(deadline, run.stop_requested_at + timedelta(seconds=30))
    if now > deadline:
        run.state, run.error_code, run.ended_at = (
            "incomplete",
            "translation_timeout",
            now,
        )
        run.save(update_fields=["state", "error_code", "ended_at", "updated_at"])


@transaction.atomic
def agent_control(run_id, data):
    """Claim once; subsequent actions must carry the worker and source generation."""
    run, session = _locked(run_id)
    if (
        str(session.room_id) != str(data["room_id"])
        or session.livekit_room_sid != data["livekit_room_sid"]
        or run.generation != data["generation"]
    ):
        raise RecordConflict("Translation source or generation conflicts.")
    _expire(run)
    if data["operation"] == "claim" and run.worker_id is None:
        if run.state != "starting" or not enabled() or not _source_valid(run, session):
            _request_stop(run)
            return {"state": run.state}
        run.worker_id = data["worker_id"]
        run.state = "translating"
        run.error_code = ""
        run.save(update_fields=["worker_id", "state", "error_code", "updated_at"])
    if run.worker_id != data["worker_id"]:
        raise RecordConflict("Translation belongs to another worker.")
    if data["operation"] == "finish":
        receipt = data["receipt"]
        if run.finish_receipt is not None:
            if run.finish_receipt != receipt:
                raise RecordConflict("Translation finish receipt conflicts.")
        elif run.state in ACTIVE:
            complete = receipt["provider_finished"] and receipt["consumer_finished"]
            run.state = "stopped" if complete else "incomplete"
            run.error_code = "" if complete else "translation_incomplete"
            run.ended_at, run.finish_receipt = timezone.now(), receipt
            run.save(
                update_fields=[
                    "state",
                    "error_code",
                    "ended_at",
                    "finish_receipt",
                    "updated_at",
                ]
            )
        return {"state": run.state}
    source_valid = _source_valid(run, session)
    if run.state in ACTIVE:
        if not source_valid:
            _request_stop(run)
        run.heartbeat_at = timezone.now()
        run.save(update_fields=["heartbeat_at", "updated_at"])
    result = {"state": run.state}
    if run.state == "stopping" and source_valid:
        result["deliver_tail"] = True
    if run.state == "translating":
        result.update(
            configuration=run.configuration,
            source_identity=run.source_participation.identity,
            source_participant_sid=run.source_participation.livekit_participant_sid,
            destination_identity=run.source_participation.identity,
        )
    return result


@async_to_sync
async def _send_dispatch(run, session):
    client = utils.create_livekit_client()
    try:
        async with asyncio.timeout(8):
            await client.agent_dispatch.create_dispatch(
                CreateAgentDispatchRequest(
                    agent_name=settings.ROOM_TRANSLATION_AGENT_NAME,
                    room=str(session.room_id),
                    metadata=json.dumps(
                        {
                            "translation": {
                                "run_id": str(run.pk),
                                "generation": run.generation,
                                "livekit_room_sid": session.livekit_room_sid,
                            }
                        }
                    ),
                )
            )
    finally:
        await client.aclose()


def dispatch(run_id):
    """Retry only dispatch, before any worker claim; never replay provider audio."""
    with transaction.atomic():
        run, session = _locked(run_id)
        _expire(run)
        if run.state not in ACTIVE:
            return False
        if not _source_valid(run, session):
            _request_stop(run)
        if run.state != "starting" or run.worker_id:
            return False
        if not enabled():
            _request_stop(run)
            return False
        if run.dispatched_at and timezone.now() - run.dispatched_at < timedelta(
            seconds=15
        ):
            return False
        run.dispatched_at = timezone.now()
        run.save(update_fields=["dispatched_at", "updated_at"])
    try:
        _send_dispatch(run, session)
    except Exception:  # noqa: BLE001 -- external dispatch errors may contain credentials
        models.MeetingTranslationRun.objects.filter(pk=run_id, state="starting").update(
            error_code="translation_dispatch_unavailable"
        )
        return False
    return True


def tick_translations(limit=100):
    """Expire orphaned runs even after operators disable new translations."""
    ids = list(
        models.MeetingTranslationRun.objects.filter(state__in=ACTIVE)
        .order_by("updated_at", "id")
        .values_list("pk", flat=True)[:limit]
    )
    for run_id in ids:
        dispatch(run_id)
    return len(ids)
