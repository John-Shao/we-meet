"""Deciding which real person a diarised speaker track is.

"Speaker 1" is not attribution. A reader needs to know who committed to what, so
a human can attribute a track to a member — the same judgement Feishu Minutes
takes as input, rather than something a model guesses at.

Attribution never rewrites the recogniser's label. `MeetingSpeaker.label` stays
as produced and `user` carries the human decision, with `display_name` resolving
the one name a reader sees. That keeps the diarisation output as evidence while
letting every reader-facing artifact show the person.
"""

from core import models
from core.services.meeting_records import can_edit_transcript

#: A picker is a lookup, not an export: past a screenful the user should search.
MAX_CANDIDATES = 50


class AttributionDenied(ValueError):
    """The target is a real account but not one this record may name.

    Distinct from a permission failure: the caller was allowed to attribute, and
    the answer is about the *target*, not about them.
    """


def authorize(record, user):
    """Attribution is an editorial act on the record's presentation.

    It shares transcript editing access and does not require AI generation.
    """
    if not user or not getattr(user, "is_authenticated", False) or not user.is_active:
        raise PermissionError("An active user is required.")
    if not can_edit_transcript(record, user):
        raise PermissionError("Only current meeting managers can attribute a speaker.")


def attribute(record, speaker_id, actor, *, user_id):
    """Set or clear the person a speaker track belongs to.

    `user_id=None` clears it. Clearing is not the same as refusing: an editor who
    attributed the wrong colleague must be able to undo that, and the label the
    recogniser produced is still there underneath.
    """
    from core.services.speaker_identity_decisions import decide  # noqa: PLC0415

    authorize(record, actor)
    if user_id is not None and not models.User.objects.filter(pk=user_id).exists():
        raise LookupError("No such user.")
    return decide(
        record,
        speaker_id,
        actor,
        action="select_contact" if user_id else "clear",
        contact_ref=f"member:{user_id}" if user_id else None,
    )


def attribution_candidates(record, actor, query=""):
    """Legacy bounded picker using exactly the new member visibility rules."""
    from core.services.speaker_contacts import members  # noqa: PLC0415

    return members(record, actor, query)[:MAX_CANDIDATES]


def serialize(speaker, *, record_revision=None):
    """Speaker metadata plus its attribution, without exposing the account row."""
    return {
        "id": str(speaker.pk),
        "label": speaker.label,
        "identity_type": speaker.identity_type,
        # What a reader sees, already resolved: the attributed person, else the label.
        "display_name": speaker.display_name,
        "attributed_user_id": str(speaker.user_id) if speaker.user_id else None,
        "attributed_at": speaker.attributed_at.isoformat()
        if speaker.attributed_at
        else None,
        "manual_label": speaker.manual_label,
        "attribution_kind": speaker.attribution_kind,
        "record_revision": record_revision
        if record_revision is not None
        else speaker.record.revision,
    }
