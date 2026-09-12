"""Project committed artifacts without making note indexing block ingestion."""

from functools import partial

from django.conf import settings
from django.db import transaction
from django.db.models.signals import post_save

from core import models
from core.services.meeting_records import ensure_online_record


def _project(session_id):
    session = models.MeetingSession.objects.filter(pk=session_id).first()
    if session is not None:
        ensure_online_record(session)


def _material_saved(sender, instance, raw=False, **kwargs):
    if raw or not getattr(settings, "MEETING_RECORDS_ENABLED", False):
        return
    if instance.session_id:
        # Failed projection is logged by Django and can be repaired by the
        # idempotent backfill command; the committed source remains canonical.
        transaction.on_commit(partial(_project, instance.session_id), robust=True)


def connect_handlers():
    """Keep a single handler per legacy material model."""
    for model in (models.Transcript, models.Recording, models.Summary):
        post_save.connect(
            _material_saved,
            sender=model,
            dispatch_uid=f"meeting_record_projection_{model.__name__}",
        )
