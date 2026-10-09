"""One transaction for all manual speaker identity edits and audit history."""

import unicodedata

from django.db import transaction
from django.utils import timezone

from core import models
from core.services import speaker_contacts
from core.services.meeting_records import RecordConflict, bump_record_source
from core.services.speaker_attribution import authorize


def clean_label(value):
    if not isinstance(value, str):
        raise ValueError("invalid_label")
    label = value.strip()
    if (
        not label
        or len(label) > 64
        or any(unicodedata.category(char) in {"Cc", "Cf", "Zl", "Zp"} for char in value)
    ):
        raise ValueError("invalid_label")
    return label


@transaction.atomic
def decide(  # noqa: PLR0913
    record,
    speaker_id,
    actor,
    *,
    action,
    expected_revision=None,
    contact_ref=None,
    label=None,
):
    """Lock and recheck both permission and version before changing presentation."""
    locked = models.MeetingRecord.objects.select_for_update().get(pk=record.pk)
    authorize(locked, actor)
    if expected_revision is not None and expected_revision != locked.revision:
        raise RecordConflict("identity_revision_changed")
    speaker = (
        models.MeetingSpeaker.objects.select_for_update()
        .filter(pk=speaker_id, record_id=locked.pk)
        .first()
    )
    if speaker is None:
        raise LookupError("No such speaker on this record.")
    speaker.record = locked
    if action == "set_label":
        user, manual_label, kind, source = None, clean_label(label), "custom", None
    elif action == "select_contact":
        user, manual_label, kind, source = speaker_contacts.resolve(
            locked, actor, contact_ref
        )
    elif action == "clear":
        user, manual_label, kind, source = None, "", "none", None
    else:
        raise ValueError("invalid_action")
    # Retried, identical choices do not inflate revision or audit history.
    new_user_id = user.pk if user else None
    new_source_id = source.pk if source else None
    if (
        speaker.user_id,
        speaker.manual_label,
        speaker.attribution_kind,
        speaker.contact_source_id,
    ) == (new_user_id, manual_label, kind, new_source_id):
        return speaker
    before = (speaker.user_id, speaker.manual_label, speaker.attribution_kind)
    speaker.user = user
    speaker.manual_label = manual_label
    speaker.attribution_kind = kind
    speaker.contact_source = source
    speaker.attributed_by = actor if kind != "none" else None
    speaker.attributed_at = timezone.now() if kind != "none" else None
    speaker.save(
        update_fields=[
            "user",
            "manual_label",
            "attribution_kind",
            "contact_source",
            "attributed_by",
            "attributed_at",
            "updated_at",
        ]
    )
    bump_record_source(locked)
    models.SpeakerIdentityDecision.objects.create(
        record=locked,
        speaker=speaker,
        actor=actor,
        action=action,
        previous_user_id=before[0],
        previous_label=before[1],
        previous_kind=before[2],
        selected_user_id=new_user_id,
        selected_label=manual_label,
        selected_kind=kind,
        record_revision=locked.revision,
    )
    record.revision = locked.revision
    return speaker
