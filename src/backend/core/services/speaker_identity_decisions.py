"""One transaction for all manual speaker identity edits and audit history."""

import unicodedata

from django.db import transaction
from django.utils import timezone

from core import models
from core.services import speaker_contacts
from core.services.effective_transcripts import current_generation
from core.services.meeting_records import RecordConflict, bump_record_source
from core.services.speaker_attribution import AttributionDenied, authorize


def clean_label(value):
    if not isinstance(value, str):
        raise ValueError("invalid_label")
    label = value.strip()
    if (
        not label
        or len(label) > 64
        or any(
            unicodedata.category(char) in {"Cc", "Cf", "Cs", "Zl", "Zp"}
            for char in value
        )
    ):
        raise ValueError("invalid_label")
    return label


def lock_subjects(record, speaker_id, actor, action, contact_ref):
    # Workers and consent revocation lock subjects before records. Lock every
    # user referenced by the forthcoming write/audit before taking the record,
    # so PostgreSQL foreign-key checks cannot invert that order.
    authorize(record, actor)
    tentative_user = None
    if action == "select_contact":
        tentative_user = speaker_contacts.resolve(record, actor, contact_ref)[0]
    previous_user = (
        models.MeetingSpeaker.objects.filter(
            pk=speaker_id,
            record_id=record.pk,
        )
        .values_list("user_id", flat=True)
        .first()
    )
    subject_ids = {actor.pk, previous_user}
    if tentative_user is not None:
        subject_ids.add(tentative_user.pk)
    subjects = {
        user.pk: user
        for user in models.User.objects.select_for_update()
        .filter(pk__in=subject_ids - {None})
        .order_by("pk")
    }
    return subjects


def decide(  # noqa: PLR0913
    record,
    speaker_id,
    actor,
    *,
    action,
    expected_revision=None,
    contact_ref=None,
    label=None,
    suggestion_id=None,
):
    if action in {"confirm_suggestion", "reject_suggestion"}:
        if contact_ref is not None or label is not None:
            raise ValueError("invalid_action_payload")
        from core.services import speaker_identification  # noqa: PLC0415

        return speaker_identification.decide(
            record.pk,
            speaker_id,
            actor,
            action=action,
            suggestion_id=suggestion_id,
            expected_revision=expected_revision,
        )
    if suggestion_id is not None:
        raise ValueError("invalid_action_payload")
    return decide_manual(
        record,
        speaker_id,
        actor,
        action=action,
        expected_revision=expected_revision,
        contact_ref=contact_ref,
        label=label,
    )


@transaction.atomic
def decide_manual(  # noqa: PLR0913 -- Existing manual action payload.
    record, speaker_id, actor, *, action, expected_revision, contact_ref, label
):
    """Lock and recheck both permission and version before changing presentation."""
    if expected_revision is not None and (
        type(expected_revision) is not int or expected_revision < 1
    ):
        raise ValueError("invalid_revision")
    subjects = lock_subjects(record, speaker_id, actor, action, contact_ref)
    actor = subjects.get(actor.pk)
    if actor is None:
        raise PermissionError("An active user is required.")
    locked = models.MeetingRecord.objects.select_for_update().get(pk=record.pk)
    authorize(locked, actor)
    if expected_revision is not None and expected_revision != locked.revision:
        raise RecordConflict("identity_revision_changed")
    speaker = (
        models.MeetingSpeaker.objects.select_for_update()
        .filter(
            pk=speaker_id,
            record_id=locked.pk,
            pk__in=current_generation(locked.original_segments.all()).values(
                "speaker_id"
            ),
        )
        .first()
    )
    if speaker is None:
        raise LookupError("No such speaker on this record.")
    if speaker.user_id is not None and speaker.user_id not in subjects:
        raise RecordConflict("identity_revision_changed")
    speaker.record = locked
    if action != "clear" and speaker.identity_type != "diarized":
        raise AttributionDenied("Diarize the source before naming an unknown track.")
    if action == "set_label":
        user, manual_label, kind, source = None, clean_label(label), "custom", None
    elif action == "select_contact":
        user, manual_label, kind, source = speaker_contacts.resolve(
            locked, actor, contact_ref
        )
        if user is not None and user.pk not in subjects:
            raise RecordConflict("identity_contact_changed")
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
    from core.services import speaker_identity_jobs  # noqa: PLC0415

    speaker_identity_jobs.invalidate_target(locked.pk, speaker.pk)
    record.revision = locked.revision
    return speaker
