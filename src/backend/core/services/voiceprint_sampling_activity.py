"""Permit-bound progress; owner projections never infer capture from eligibility."""

from django.db import transaction
from django.utils import timezone

from core import models
from core.services import voiceprint_consent as consent
from core.services import voiceprint_sampling as sampling
from core.services.voiceprint_encoder import FEATURE_SPACE

ACTIVITY_SECONDS = 5
PHASES = ("waiting", "sampling", "uploading", "stopped")


@transaction.atomic
def report(identifier, *, token, room_sid, participant_sid, track_sid, phase, sequence):  # noqa: PLR0913 -- The phase remains bound to one exact permit and RTC origin.
    if (
        phase not in PHASES
        or type(sequence) is not int
        or not 0 <= sequence <= 2**31 - 1
    ):
        raise consent.VoiceprintError(
            "voiceprint_sampling_activity_invalid", status=400
        )
    initial = (
        models.VoiceprintSamplingPermit.objects.select_related("profile__consent")
        .filter(pk=identifier)
        .first()
    )
    if initial is None or initial.profile_id is None:
        raise consent.VoiceprintError("voiceprint_sampling_permit_unavailable")
    user = consent.owner(models.User(pk=initial.owner_id), lock=True)
    consent.scope(user, initial.profile.consent.organization_id, lock=True)
    models.VoiceprintConsent.objects.select_for_update().get(
        pk=initial.profile.consent_id
    )
    models.MeetingSession.objects.select_for_update().filter(
        pk=initial.source_session_id
    ).first()
    models.VoiceprintSamplingTrack.objects.select_for_update().filter(
        pk=initial.track_id
    ).first()
    permit = models.VoiceprintSamplingPermit.objects.select_for_update().get(
        pk=identifier
    )
    result = sampling.validate(
        identifier,
        token=token,
        room_sid=room_sid,
        participant_sid=participant_sid,
        track_sid=track_sid,
    )
    row = (
        models.VoiceprintSamplingActivity.objects.select_for_update()
        .filter(track=permit.track)
        .first()
    )
    if row and row.permit_id == permit.pk and sequence <= row.sequence:
        # Replays neither extend the heartbeat nor overwrite a newer phase.
        return result
    if row and row.permit_id == permit.pk:
        valid_phase = PHASES.index(phase) >= PHASES.index(row.phase)
    else:
        valid_phase = phase in {"waiting", "stopped"}
        if (
            row
            and row.permit_id
            and (permit.created_at, permit.pk) <= (row.permit.created_at, row.permit_id)
        ):
            valid_phase = False
    if not valid_phase:
        raise consent.VoiceprintError(
            "voiceprint_sampling_activity_changed", status=409
        )
    models.VoiceprintSamplingActivity.objects.update_or_create(
        track=permit.track,
        defaults={
            "permit": permit,
            "sequence": sequence,
            "phase": phase,
            "expires_at": timezone.now() + timezone.timedelta(seconds=ACTIVITY_SECONDS),
        },
    )
    return result


def current(row, participation, permission, control):
    permit = row.permit
    if permit is None or permit.profile_id is None or row.phase not in PHASES:
        return False
    return (
        permit.status == "issued"
        and permit.expires_at > timezone.now()
        and permit.control_revision == control["revision"]
        and permit.device_group == control["device_group"]
        and permit.device_group in sampling.DEVICE_GROUPS
        and permit.control_revision >= 1
        and permit.consent_version == permission.version
        and permit.generation == permission.generation
        and permit.generation
        >= consent.revocation_floor(participation.user_id, permission.organization_id)
        and permit.profile.generation == permission.generation
        and permit.profile.consent_id == permission.pk
        and permit.profile.feature_space == FEATURE_SPACE
        and permit.profile.status != "deleted"
        and permit.owner_id == participation.user_id
        and permit.source_session_id == participation.session_id
        and permit.livekit_room_sid == participation.session.livekit_room_sid
        and permit.participant_sid == participation.livekit_participant_sid
        and permit.participant_identity == participation.identity
        and permit.source_track_sid == row.track.livekit_track_sid
        and permit.track_id == row.track_id
        and permit.policy_version
        == (
            consent.organization_policy(participation.session.room.organization)[
                "version"
            ]
            if participation.session.room.organization_id
            else 0
        )
    )


def projection(participation, control, permission):
    result = {"state": "stopped", "reason": control["state"], "updated_at": None}
    if control["state"] != "ready":
        return result
    if not models.VoiceprintSamplingTrack.objects.filter(
        participation=participation,
        source="microphone",
        media_type="audio",
        unpublished_at__isnull=True,
    ).exists():
        result["reason"] = "microphone_unavailable"
        return result
    remaining = sampling.remaining(participation)
    result["remaining_ms"] = remaining
    rows = (
        models.VoiceprintSamplingActivity.objects.select_related(
            "track", "permit__profile"
        )
        .filter(
            track__participation=participation,
            track__source="microphone",
            track__media_type="audio",
            track__unpublished_at__isnull=True,
            expires_at__gt=timezone.now(),
        )
        .order_by("-updated_at")[:4]
    )
    for row in rows:
        if current(row, participation, permission, control):
            result.update(
                state=row.phase if row.phase != "stopped" else "waiting",
                reason="",
                updated_at=row.updated_at.isoformat(),
            )
            return result
    if min(remaining.values()) < 3000:
        result["reason"] = "quota_exhausted"
        return result
    dispatch = models.VoiceprintSamplingDispatch.objects.filter(
        session_id=participation.session_id
    ).first()
    if dispatch and (
        dispatch.status == "failed"
        or dispatch.status == "idle"
        and dispatch.outcome == "ended"
    ):
        result.update(state="unavailable", reason="sampling_dispatch_unavailable")
    else:
        result.update(
            state="starting"
            if dispatch and dispatch.status in {"queued", "running"}
            else "waiting",
            reason="",
        )
    return result
