"""Human corrections to a transcript, without rewriting what the recogniser said.

`MeetingOriginalSegment` is immutable on purpose: summary points and stored
transcript versions reference a segment by id, so editing one in place would
change what an existing citation points at and would let an edit silently rewrite
published history.

A correction is therefore an appended `MeetingOriginalRevision`. The original
keeps stating what ASR produced; every reader resolves "latest revision, else
original" through `corrected_text_subquery`, so there is exactly one place that
decides which text a reader sees.
"""

from django.db import models as django_models
from django.db import transaction
from django.db.models import F, OuterRef, Subquery
from django.db.models.functions import Coalesce

from core import models
from core.services.meeting_records import RecordConflict, can_generate_summary

#: Bound on a single correction. Long enough for a real sentence and for pasting
#: a paragraph an ASR mangled, short enough that the field is not a document.
MAX_CORRECTION_CHARS = 20_000


def corrected_text_subquery():
    """The reader's text as a `Subquery`: newest revision, else the original.

    Annotate rather than join: a join would multiply rows once a segment has more
    than one revision, and callers paginate these rows.

    The fallback is part of the subquery on purpose. A bare revision lookup would
    yield SQL NULL for every uncorrected segment, so a caller that forgot to
    coalesce would silently read `None` for most of a transcript — a failure that
    only shows up on records nobody has edited.
    """
    latest = (
        models.MeetingOriginalRevision.objects.filter(original_id=OuterRef("pk"))
        .order_by("-revision")
        .values("text")[:1]
    )
    return Coalesce(
        Subquery(latest, output_field=django_models.TextField()),
        F("text"),
        output_field=django_models.TextField(),
    )


def corrected_text(segment):
    """The reader's text for one segment: the newest revision, else the original."""
    revision = segment.revisions.order_by("-revision").first()
    return revision.text if revision else segment.text


def _authorize(record, user):
    """Correcting the source is the same standing as regenerating from it.

    Both change what every downstream artifact will say, so a reader who may only
    read must not be able to alter the input. Room managers and standalone owners
    are exactly the people `can_generate_summary` already admits.
    """
    if not user or not getattr(user, "is_authenticated", False) or not user.is_active:
        raise PermissionError("An active user is required.")
    if not can_generate_summary(record, user):
        raise PermissionError("Only current meeting managers can correct a transcript.")


@transaction.atomic
def correct(record, original_id, user, *, text, expected_revision=None):
    """Append a correction to one segment and advance the record's revision.

    Idempotent in the sense that matters: re-submitting the text a segment
    already resolves to is a no-op, so a retried request cannot inflate the
    revision log. `expected_revision` guards the case where two editors are
    looking at different text — the stale one is rejected rather than silently
    overwriting.
    """
    _authorize(record, user)
    if not isinstance(text, str):
        raise ValueError("invalid_text")
    cleaned = text.strip()
    if not cleaned or len(cleaned) > MAX_CORRECTION_CHARS:
        raise ValueError("invalid_text")

    locked = models.MeetingRecord.objects.select_for_update().get(pk=record.pk)
    original = models.MeetingOriginalSegment.objects.filter(
        pk=original_id, record_id=locked.pk
    ).first()
    if original is None:
        raise LookupError("No such segment on this record.")

    current = corrected_text(original)
    if expected_revision is not None:
        latest = original.revisions.order_by("-revision").first()
        actual = latest.revision if latest else 0
        if actual != expected_revision:
            raise RecordConflict("The transcript changed; refresh before correcting.")
    if cleaned == current:
        # Nothing to record, and the record revision must not move either:
        # downstream regeneration is keyed on it.
        return original, None

    previous = original.revisions.order_by("-revision").first()
    revision = models.MeetingOriginalRevision.objects.create(
        record_id=locked.pk,
        original=original,
        revision=(previous.revision if previous else 0) + 1,
        text=cleaned,
        edited_by=user,
    )
    # Bump the record so summary, RAG and exports re-read the corrected source
    # instead of continuing to serve text the reader has already fixed.
    locked.revision += 1
    locked.save(update_fields=["revision", "updated_at"])
    return original, revision


@transaction.atomic
def revert(record, original_id, user):
    """Drop every correction for one segment, restoring what ASR produced.

    Deletes rather than appends another revision: the point of reverting is to
    get back to the original, and keeping the corrections would leave the
    "latest revision" still overriding it.
    """
    _authorize(record, user)
    locked = models.MeetingRecord.objects.select_for_update().get(pk=record.pk)
    original = models.MeetingOriginalSegment.objects.filter(
        pk=original_id, record_id=locked.pk
    ).first()
    if original is None:
        raise LookupError("No such segment on this record.")
    removed = original.revisions.all().delete()[0]
    if removed:
        locked.revision += 1
        locked.save(update_fields=["revision", "updated_at"])
    return original, removed
