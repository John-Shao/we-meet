"""Deciding which real person a diarised speaker track is.

"Speaker 1" is not attribution. A reader needs to know who committed to what, so
a human can attribute a track to a member — the same judgement Feishu Minutes
takes as input, rather than something a model guesses at.

Attribution never rewrites the recogniser's label. `MeetingSpeaker.label` stays
as produced and `user` carries the human decision, with `display_name` resolving
the one name a reader sees. That keeps the diarisation output as evidence while
letting every reader-facing artifact show the person.
"""

from django.db import transaction
from django.utils import timezone

from core import models
from core.services.meeting_records import can_generate_summary


class AttributionDenied(ValueError):
    """The target is a real account but not one this record may name.

    Distinct from a permission failure: the caller was allowed to attribute, and
    the answer is about the *target*, not about them.
    """


def _authorize(record, user):
    """Attribution is an editorial act on the record's presentation.

    Same standing as correcting the transcript or regenerating from it: room
    managers, plus the owner of a standalone record.
    """
    if not user or not getattr(user, "is_authenticated", False) or not user.is_active:
        raise PermissionError("An active user is required.")
    if not can_generate_summary(record, user):
        raise PermissionError("Only current meeting managers can attribute a speaker.")


def _member_of_record_organization(record, user):
    """A speaker may only be attributed to someone inside the record's boundary.

    Attribution makes a name visible to everyone who can read the transcript. Any
    active account in the same organization is fair game; anyone outside it is
    refused, because the reader has no way to know that person exists and the
    record has no business naming them.
    """
    if not user or not user.is_active:
        return False
    if record.organization_id is None:
        # An organization-less record (a personal import) has no boundary to
        # cross, so any active account is acceptable.
        return True
    return models.Membership.objects.filter(
        user=user,
        organization_id=record.organization_id,
        status=models.MembershipStatusChoices.ACTIVE,
        organization__is_active=True,
    ).exists()


@transaction.atomic
def attribute(record, speaker_id, actor, *, user_id):
    """Set or clear the person a speaker track belongs to.

    `user_id=None` clears it. Clearing is not the same as refusing: an editor who
    attributed the wrong colleague must be able to undo that, and the label the
    recogniser produced is still there underneath.
    """
    _authorize(record, actor)
    models.MeetingRecord.objects.select_for_update().get(pk=record.pk)
    speaker = models.MeetingSpeaker.objects.filter(
        pk=speaker_id, record_id=record.pk
    ).first()
    if speaker is None:
        raise LookupError("No such speaker on this record.")

    if user_id is None:
        speaker.user = None
        speaker.attributed_by = None
        speaker.attributed_at = None
        speaker.save(update_fields=["user", "attributed_by", "attributed_at", "updated_at"])
        return speaker

    target = models.User.objects.filter(pk=user_id).first()
    if target is None:
        raise LookupError("No such user.")
    if not _member_of_record_organization(record, target):
        raise AttributionDenied("That person is not a member of this organization.")

    speaker.user = target
    speaker.attributed_by = actor
    speaker.attributed_at = timezone.now()
    speaker.save(update_fields=["user", "attributed_by", "attributed_at", "updated_at"])
    return speaker


def serialize(speaker):
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
    }
