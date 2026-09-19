"""One projection for current transcript readers and newly frozen snapshots."""

from django.db.models import F, IntegerField, OuterRef, Q, Subquery, Value
from django.db.models.functions import Coalesce

from core import models
from core.services.transcript_corrections import (
    attributed_name_subquery,
    corrected_text_subquery,
)


def current_generation(rows):
    """Keep imports and the published ASR generation, never a partial retry."""
    return rows.filter(
        Q(transcription_job__isnull=True)
        | Q(transcription_job_id=F("capture_session__active_transcription_id"))
    )


def project(rows):
    """Resolve text, editor version and speaker without multiplying paged rows.

    Callers freezing a specific live or historical generation can project that
    queryset directly. Integrity checks must continue to use the immutable text.
    """
    latest = models.MeetingOriginalRevision.objects.filter(
        original_id=OuterRef("pk")
    ).order_by("-revision")
    return rows.annotate(
        corrected_text=corrected_text_subquery(),
        correction_revision=Coalesce(
            Subquery(latest.values("revision")[:1]),
            Value(0),
            output_field=IntegerField(),
        ),
        display_name=attributed_name_subquery(),
    )


def originals(record):
    """The effective standalone transcript used by readers and exports."""
    return project(current_generation(record.original_segments.all()))
