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
from django.db.models import F, OuterRef, Subquery, Value
from django.db.models.functions import Coalesce, NullIf

from core import models
from core.models import MeetingSpeaker
from core.services.meeting_records import RecordConflict, can_edit_transcript

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


def attributed_name_subquery():
    """The speaker's visible name, for annotating a segment queryset.

    Attribute to a person and the reader sees that person; leave it unattributed
    and they see the recogniser's label. Resolved in one place so the transcript,
    the export and the summary cannot disagree about what a speaker is called.

    Coalesced through the label for the same reason as the text projection: a bare
    lookup yields NULL for every unattributed speaker, which is most of them.
    """
    named = (
        MeetingSpeaker.objects.filter(pk=OuterRef("speaker_id"))
        .annotate(
            resolved=Coalesce(
                NullIf("user__full_name", Value("")),
                NullIf("user__short_name", Value("")),
                NullIf("user__email", Value("")),
                "label",
                # The account's email column is an EmailField, so without an
                # explicit target the coalesce mixes types and Django refuses it.
                output_field=django_models.CharField(max_length=128),
            )
        )
        .values("resolved")[:1]
    )
    return Subquery(named, output_field=django_models.CharField(max_length=128))


def speaker_display_name(speaker):
    """The same resolution in Python, for callers holding an instance."""
    if speaker is None:
        return ""
    return speaker.display_name


def _authorize(record, user):
    """Editing stored text requires editorial access, independent of AI switches."""
    if not user or not getattr(user, "is_authenticated", False) or not user.is_active:
        raise PermissionError("An active user is required.")
    if not can_edit_transcript(record, user):
        raise PermissionError("Only current meeting managers can correct a transcript.")


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

    return _append(record, original_id, user, cleaned, expected_revision)


@transaction.atomic
def _append(record, original_id, user, text, expected_revision):
    # Import locally: the read projection uses the subqueries above.
    from core.services.effective_transcripts import current_generation  # noqa: PLC0415

    locked = models.MeetingRecord.objects.select_for_update().get(pk=record.pk)
    _authorize(locked, user)
    original = current_generation(
        models.MeetingOriginalSegment.objects.filter(
            pk=original_id, record_id=locked.pk
        )
    ).first()
    if original is None:
        raise LookupError("No such segment on this record.")

    previous = original.revisions.order_by("-revision").first()
    actual = previous.revision if previous else 0
    current = previous.text if previous else original.text
    cleaned = original.text if text is None else text
    original.correction_revision = actual
    original.record_revision = locked.revision
    original.corrected_text = current
    if expected_revision is not None:
        if actual != expected_revision:
            raise RecordConflict("The transcript changed; refresh before correcting.")
    if cleaned == current:
        # Nothing to record, and the record revision must not move either:
        # downstream regeneration is keyed on it.
        return original, None

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
    original.correction_revision = revision.revision
    original.record_revision = locked.revision
    original.corrected_text = cleaned
    return original, revision


def revert(record, original_id, user, *, expected_revision=None):
    """Append the recogniser's text, retaining history and guarding stale editors."""
    return _append(record, original_id, user, None, expected_revision)
