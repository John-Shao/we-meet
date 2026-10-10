"""Trusted microphone origins, owner controls and bounded clip reservations.

The sampler obtains and repeatedly validates a permit before subscribing.
Only a bounded WAV with its exact consumed receipt enters the encrypted queue;
a connection identity alone never proves a voice.
"""

import base64
import hashlib
import hmac
import re
from uuid import UUID, uuid4

from django.conf import settings
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from livekit import api

from core import models
from core.services import voiceprint_consent as consent
from core.services import voiceprint_enrollment as enrollment
from core.services import voiceprint_source_removal as removal
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_crypto import load_keyring, scope_aad
from core.services.voiceprint_encoder import FEATURE_SPACE

DEVICE_GROUPS = ("headset", "handset", "computer")
PERMIT_SECONDS = 30


def enabled():
    return (
        settings.MEETING_VOICEPRINT_ENABLED
        and settings.MEETING_VOICEPRINT_SAMPLING_ENABLED
    )


def sid(value):
    if (
        not isinstance(value, str)
        or re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value) is None
    ):
        raise VoiceprintError("voiceprint_sampling_identity_invalid", status=400)
    return value


def mapped_owner(participation):
    user = participation.user
    if user is not None:
        user = consent.owner(user)
    if (
        user is None
        or participation.kind != "standard"
        or participation.identity != str(user.sub)
    ):
        raise VoiceprintError("voiceprint_sampling_identity_unavailable")
    return user


def connected(participation):
    session = participation.session
    if (
        participation.left_at is not None
        or session.status != "active"
        or not session.livekit_room_sid
    ):
        raise VoiceprintError("voiceprint_sampling_connection_ended")
    if removal.session_removed(session.pk):
        raise VoiceprintError("voiceprint_sampling_source_removed")


@transaction.atomic
def record_track(*, participation, track, published, event_at):
    """Called only after the existing webhook receiver verifies the LiveKit JWT."""
    if not enabled():
        return None
    identifier = sid(track.sid)
    session = (
        models.MeetingSession.objects.select_for_update()
        .filter(pk=participation.session_id)
        .first()
    )
    if session is None:
        raise VoiceprintError("voiceprint_sampling_connection_ended")
    # The fence must be read after the lock: deletion may have committed while
    # this webhook was waiting for the same session row.
    if models.VoiceprintSourceRemoval.objects.filter(
        kind="track", track_digest=removal.track_digest(identifier)
    ).exists():
        raise VoiceprintError("voiceprint_sampling_track_removed", status=409)
    if removal.session_removed(session.pk):
        raise VoiceprintError("voiceprint_sampling_source_removed")
    origin = (
        models.VoiceprintSamplingTrack.objects.select_for_update()
        .filter(livekit_track_sid=identifier)
        .first()
    )
    source = api.TrackSource.Name(track.source).lower()
    media = api.TrackType.Name(track.type).lower()
    if origin:
        if (
            origin.participation_id != participation.pk
            or published
            and (origin.source != source or origin.media_type != media)
        ):
            raise VoiceprintError("voiceprint_sampling_track_changed", status=409)
        # A delayed publish cannot reopen an already-unpublished track SID.
        if not published and origin.unpublished_at is None:
            origin.unpublished_at = max(event_at, origin.published_at)
            origin.save(update_fields=["unpublished_at", "updated_at"])
    else:
        origin = models.VoiceprintSamplingTrack.objects.create(
            participation=participation,
            livekit_track_sid=identifier,
            source=source,
            media_type=media,
            published_at=event_at,
            unpublished_at=None if published else event_at,
        )
    if origin.unpublished_at is not None:
        origin.permits.filter(status="issued").update(
            status="canceled", updated_at=timezone.now()
        )
    return origin


def owned_participation(actor, session_id, participant_sid):
    user = consent.owner(actor)
    participation = (
        models.MeetingParticipation.objects.select_related(
            "user", "session__room__organization"
        )
        .filter(
            session_id=session_id,
            livekit_participant_sid=sid(participant_sid),
            user=user,
        )
        .first()
    )
    if participation is None:
        raise VoiceprintError("voiceprint_sampling_connection_unavailable", status=404)
    mapped_owner(participation)
    return participation


def state(participation, control=None, *, runtime=True):
    control = (
        control
        or models.VoiceprintSamplingControl.objects.filter(
            participation=participation
        ).first()
    )
    shared = control.shared_microphone if control else True
    paused = control.paused if control else False
    group = control.device_group if control else ""
    organization = participation.session.room.organization
    permission = models.VoiceprintConsent.objects.filter(
        user_id=participation.user_id, organization=organization
    ).first()
    reason = "ready"
    if not enabled() or not consent.available(participation.user, organization):
        reason = "disabled"
    elif participation.left_at is not None or participation.session.status != "active":
        reason = "disconnected"
    elif removal.session_removed(participation.session_id):
        reason = "source_removed"
    elif permission is None or not permission.allow_accumulation:
        reason = "authorization_required"
    elif paused:
        reason = "paused"
    elif shared:
        reason = "shared_microphone"
    elif group not in DEVICE_GROUPS:
        reason = "device_required"
    result = {
        "session_id": str(participation.session_id),
        "participant_sid": participation.livekit_participant_sid,
        "revision": control.revision if control else 0,
        "paused": paused,
        "shared_microphone": shared,
        "device_group": group,
        "state": reason,
        "stop_reason": control.stop_reason if control else "",
    }
    if runtime:
        from core.services.voiceprint_sampling_activity import (  # noqa: PLC0415 -- Avoid the progress/authorization cycle.
            projection,
        )

        result["runtime"] = projection(participation, result, permission)
    return result


def remaining(participation):
    """Reserved duration, including failed/deleted captures, across all scopes."""
    _clip, session_limit, daily_limit = budget()
    rows = models.VoiceprintSamplingPermit.objects.filter(
        owner_id=participation.user_id
    )
    session = (
        rows.filter(source_session_id=participation.session_id).aggregate(
            value=Sum("max_duration_ms")
        )["value"]
        or 0
    )
    daily = (
        rows.filter(
            created_at__gte=timezone.now() - timezone.timedelta(hours=24)
        ).aggregate(value=Sum("max_duration_ms"))["value"]
        or 0
    )
    return {
        "session_ms": max(0, session_limit - session),
        "daily_ms": max(0, daily_limit - daily),
    }


def read_control(actor, *, session_id, participant_sid):
    return state(owned_participation(actor, session_id, participant_sid))


@transaction.atomic
def update_control(  # noqa: PLR0913 -- One versioned owner microphone declaration.
    actor,
    *,
    session_id,
    participant_sid,
    expected_revision,
    paused,
    shared_microphone,
    device_group,
):
    user = consent.owner(actor, lock=True)
    participation = owned_participation(user, session_id, participant_sid)
    if (
        type(expected_revision) is not int
        or expected_revision < 0
        or type(paused) is not bool
        or type(shared_microphone) is not bool
        or device_group not in ("", *DEVICE_GROUPS)
    ):
        raise VoiceprintError("voiceprint_sampling_control_invalid", status=400)
    control = (
        models.VoiceprintSamplingControl.objects.select_for_update()
        .filter(participation=participation)
        .first()
    )
    if expected_revision != (control.revision if control else 0):
        raise VoiceprintError("voiceprint_sampling_control_changed", status=409)
    if control is None:
        control = models.VoiceprintSamplingControl(participation=participation)
    else:
        control.revision += 1
    control.paused, control.shared_microphone, control.device_group = (
        paused,
        shared_microphone,
        device_group,
    )
    control.stop_reason = ""
    control.save()
    models.VoiceprintSamplingPermit.objects.filter(
        track__participation=participation, status="issued"
    ).update(status="canceled", updated_at=timezone.now())
    result = state(participation, control)
    if result["state"] == "ready":
        from core.services.voiceprint_sampling_dispatch import (  # noqa: PLC0415 -- Dispatch follows the declaration commit.
            schedule,
        )

        schedule(participation.session_id)
    return result


def budget():
    limits = (
        settings.MEETING_VOICEPRINT_SAMPLING_CLIP_MS,
        settings.MEETING_VOICEPRINT_SAMPLING_SESSION_MS,
        settings.MEETING_VOICEPRINT_SAMPLING_DAILY_MS,
    )
    if any(
        type(value) is not int or not 3000 <= value <= maximum
        for value, maximum in zip(limits, (10000, 60000, 120000), strict=True)
    ):
        raise VoiceprintError("voiceprint_sampling_budget_invalid", status=503)
    return limits


def profile_for(user, organization):
    permission = models.VoiceprintConsent.objects.filter(
        user=user, organization=organization
    ).first()
    if permission is None or not permission.allow_accumulation:
        raise VoiceprintError("voiceprint_sampling_authorization_required")
    profile = models.VoiceprintProfile.objects.filter(
        consent=permission,
        feature_space=FEATURE_SPACE,
        generation=permission.generation,
    ).first()
    if profile is None:
        profile = consent.ensure_profile(
            user,
            organization_id=organization.pk if organization else None,
            expected_version=permission.version,
        )
    return consent.authorize_profile(
        profile.pk,
        permission="allow_accumulation",
        version=permission.version,
        generation=permission.generation,
    )


def token_for(permit, profile):
    key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=b"we-meet-call-sampling-permit-v1",
    ).derive(load_keyring().profile_key(profile))
    value = hmac.digest(
        key, scope_aad(profile, kind="call-permit", object_id=permit.pk), "sha256"
    )
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def authorize(permit):
    if (
        not enabled()
        or permit.track_id is None
        or permit.status != "issued"
        or permit.expires_at <= timezone.now()
    ):
        raise VoiceprintError("voiceprint_sampling_permit_unavailable")
    participation = permit.track.participation
    user = mapped_owner(participation)
    connected(participation)
    if (
        permit.track.unpublished_at is not None
        or permit.track.source != "microphone"
        or permit.track.media_type != "audio"
        or permit.device_group not in DEVICE_GROUPS
        or permit.control_revision < 1
    ):
        raise VoiceprintError("voiceprint_sampling_track_unavailable")
    control = models.VoiceprintSamplingControl.objects.filter(
        participation=participation
    ).first()
    if (
        control is None
        or control.paused
        or control.shared_microphone
        or control.revision != permit.control_revision
        or control.device_group != permit.device_group
    ):
        raise VoiceprintError("voiceprint_sampling_control_changed")
    organization = participation.session.room.organization
    profile = consent.authorize_profile(
        permit.profile_id,
        permission="allow_accumulation",
        version=permit.consent_version,
        generation=permit.generation,
        expected_scope=(user.pk, organization.pk if organization else None),
    )
    policy = consent.organization_policy(organization)["version"] if organization else 0
    if (
        permit.owner_id != user.pk
        or permit.source_session_id != participation.session_id
        or permit.source_track_sid != permit.track.livekit_track_sid
        or permit.livekit_room_sid != participation.session.livekit_room_sid
        or permit.participant_sid != participation.livekit_participant_sid
        or permit.participant_identity != participation.identity
        or permit.policy_version != policy
        or profile.feature_space != FEATURE_SPACE
    ):
        raise VoiceprintError("voiceprint_sampling_authorization_changed")
    load_keyring().profile_key(profile)
    return profile


def snapshot(permit, profile):
    return {
        "id": str(permit.pk),
        "token": token_for(permit, profile),
        "room_sid": permit.livekit_room_sid,
        "session_id": str(permit.source_session_id),
        "participant_sid": permit.participant_sid,
        "identity": permit.participant_identity,
        "track_sid": permit.source_track_sid,
        "user_id": str(permit.owner_id),
        "organization_id": str(profile.consent.organization_id)
        if profile.consent.organization_id
        else None,
        "consent_version": permit.consent_version,
        "generation": permit.generation,
        "control_revision": permit.control_revision,
        "device_group": permit.device_group,
        "max_duration_ms": permit.max_duration_ms,
        "expires_at": permit.expires_at.isoformat(),
        "sample_rate": 24000,
        "channels": 1,
    }


def track_for(*, room_sid, participant_sid, track_sid):
    track = (
        models.VoiceprintSamplingTrack.objects.select_related(
            "participation__user", "participation__session__room__organization"
        )
        .filter(
            livekit_track_sid=sid(track_sid),
            participation__livekit_participant_sid=sid(participant_sid),
            participation__session__livekit_room_sid=sid(room_sid),
        )
        .first()
    )
    if track is None:
        raise VoiceprintError("voiceprint_sampling_track_unavailable", status=404)
    return track


@transaction.atomic
def issue(*, room_sid, participant_sid, track_sid, request_key):
    if not enabled():
        raise VoiceprintError("voiceprint_sampling_disabled")
    track = track_for(
        room_sid=room_sid, participant_sid=participant_sid, track_sid=track_sid
    )
    user = consent.owner(mapped_owner(track.participation), lock=True)
    # Match progress/ingestion: organization precedes the shared session lock.
    # Another owner in the same room may already hold the organization lock.
    consent.scope(user, track.participation.session.room.organization_id, lock=True)
    # Serialize session termination with issuance; user lock serializes all scopes/devices' budgets.
    session = (
        models.MeetingSession.objects.select_for_update()
        .filter(pk=track.participation.session_id)
        .first()
    )
    if session is None:
        raise VoiceprintError("voiceprint_sampling_connection_ended")
    track = (
        models.VoiceprintSamplingTrack.objects.select_for_update(of=("self",))
        .select_related(
            "participation__user", "participation__session__room__organization"
        )
        .get(pk=track.pk)
    )
    connected(track.participation)
    organization = track.participation.session.room.organization
    profile = profile_for(user, organization)
    control = models.VoiceprintSamplingControl.objects.filter(
        participation=track.participation
    ).first()
    if control is None or state(track.participation, control)["state"] != "ready":
        raise VoiceprintError("voiceprint_sampling_control_unavailable")
    if not isinstance(request_key, UUID):
        raise VoiceprintError("voiceprint_sampling_request_invalid", status=400)
    now = timezone.now()
    previous = models.VoiceprintSamplingPermit.objects.filter(
        track=track, request_key=request_key
    ).first()
    if previous:
        return snapshot(previous, authorize(previous))
    track.permits.filter(profile=profile, status="issued", expires_at__lte=now).update(
        status="expired", updated_at=now
    )
    if track.permits.filter(profile=profile, status="issued").exists():
        raise VoiceprintError("voiceprint_sampling_permit_busy", status=409)
    clip, session_limit, daily_limit = budget()
    reservations = models.VoiceprintSamplingPermit.objects.filter(owner=user)
    daily = (
        reservations.filter(
            created_at__gte=now - timezone.timedelta(hours=24)
        ).aggregate(value=Sum("max_duration_ms"))["value"]
        or 0
    )
    session = (
        reservations.filter(source_session_id=track.participation.session_id).aggregate(
            value=Sum("max_duration_ms")
        )["value"]
        or 0
    )
    maximum = min(clip, daily_limit - daily, session_limit - session)
    if maximum < 3000:
        raise VoiceprintError("voiceprint_sampling_quota", status=429)
    permit = models.VoiceprintSamplingPermit.objects.create(
        track=track,
        profile=profile,
        owner=user,
        request_key=request_key,
        source_session_id=track.participation.session_id,
        source_track_sid=track.livekit_track_sid,
        livekit_room_sid=track.participation.session.livekit_room_sid,
        participant_sid=track.participation.livekit_participant_sid,
        participant_identity=track.participation.identity,
        consent_version=profile.consent.version,
        generation=profile.generation,
        policy_version=consent.organization_policy(organization)["version"]
        if organization
        else 0,
        control_revision=control.revision,
        device_group=control.device_group,
        max_duration_ms=maximum,
        expires_at=now + timezone.timedelta(seconds=PERMIT_SECONDS),
    )
    return snapshot(permit, authorize(permit))


def validate(identifier, *, token, room_sid, participant_sid, track_sid):
    track = track_for(
        room_sid=room_sid, participant_sid=participant_sid, track_sid=track_sid
    )
    permit = models.VoiceprintSamplingPermit.objects.filter(
        pk=identifier, track=track
    ).first()
    if permit is None:
        raise VoiceprintError("voiceprint_sampling_permit_unavailable", status=404)
    profile = authorize(permit)
    if (
        not isinstance(token, str)
        or len(token) != 43
        or not token.isascii()
        or not hmac.compare_digest(token_for(permit, profile), token)
    ):
        raise VoiceprintError("voiceprint_sampling_permit_invalid")
    return snapshot(permit, profile)


def authorized_sample(sample, profile):
    """A forged source_type/permit UUID is not a captured-source receipt.

    Only the bounded sampler ingestion transaction can consume and link
    this one-clip permit. Normal session end/pause does not erase a valid past
    capture; deletion of its origin or current consent revocation does.
    """
    if removal.sample_removed(sample.pk) or removal.session_removed(
        sample.source_session_id
    ):
        raise VoiceprintError("voiceprint_sampling_source_unavailable")
    permit = (
        models.VoiceprintSamplingPermit.objects.select_related(
            "track__participation__session__room", "track__participation__user"
        )
        .filter(
            pk=sample.permit_id,
            sample=sample,
            status="consumed",
            profile=profile,
            owner_id=profile.consent.user_id,
            consent_version=sample.consent_version,
            generation=sample.generation,
        )
        .first()
    )
    if permit is None or permit.track_id is None or sample.enrollment_id is not None:
        raise VoiceprintError("voiceprint_sampling_source_unavailable")

    participation = permit.track.participation
    user = mapped_owner(participation)
    organization = participation.session.room.organization
    if (
        user.pk != profile.consent.user_id
        or organization != profile.consent.organization
        or sample.source_session_id != permit.source_session_id
        or permit.source_session_id != participation.session_id
        or sample.source_track != permit.source_track_sid
        or permit.source_track_sid != permit.track.livekit_track_sid
        or permit.livekit_room_sid != participation.session.livekit_room_sid
        or permit.participant_sid != participation.livekit_participant_sid
        or permit.participant_identity != participation.identity
        or permit.track.source != "microphone"
        or permit.track.media_type != "audio"
        or permit.device_group not in DEVICE_GROUPS
        or permit.control_revision < 1
        or not 3000 <= sample.end_ms - sample.start_ms <= permit.max_duration_ms
        or not permit.created_at <= sample.created_at <= permit.expires_at
        or (consent.organization_policy(organization)["version"] if organization else 0)
        != permit.policy_version
    ):
        raise VoiceprintError("voiceprint_sampling_source_unavailable")


def receipt_evidence(sample):
    """Immutable admission fields, sealed into the call feature and job lease.

    Eligibility is separately rechecked against the current source and scope.
    This snapshot detects edits to a receipt while work is running or afterwards.
    """
    permit = models.VoiceprintSamplingPermit.objects.filter(
        pk=sample.permit_id, sample=sample, status="consumed"
    ).first()
    if permit is None:
        return None
    return {
        "profile": str(permit.profile_id),
        "owner": str(permit.owner_id),
        "track_id": str(permit.track_id),
        "session": str(permit.source_session_id),
        "track": permit.source_track_sid,
        "room": permit.livekit_room_sid,
        "participant": permit.participant_sid,
        "identity": permit.participant_identity,
        "consent_version": permit.consent_version,
        "generation": permit.generation,
        "policy_version": permit.policy_version,
        "control_revision": permit.control_revision,
        "device_group": permit.device_group,
        "max_duration_ms": permit.max_duration_ms,
        "created_at": permit.created_at.isoformat(),
        "expires_at": permit.expires_at.isoformat(),
    }


def clip_receipt(sample):
    """Return only a durable candidate reference, never quality or plaintext."""
    return {
        "id": str(sample.pk),
        "status": sample.status,
        "expires_at": sample.expires_at.isoformat(),
    }


def stop_contaminated_source(sample):
    """Called while quality completion holds the owner's lock; no implicit restart."""
    permit = models.VoiceprintSamplingPermit.objects.filter(
        sample=sample, status="consumed"
    ).first()
    if permit is None or permit.track_id is None:
        return
    control = (
        models.VoiceprintSamplingControl.objects.select_for_update()
        .filter(
            participation=permit.track.participation,
        )
        .first()
    )
    if control is not None and control.revision == permit.control_revision:
        control.revision += 1
        control.paused = True
        control.stop_reason = "mixed_speaker"
        control.save(update_fields=["revision", "paused", "stop_reason", "updated_at"])
    permit.track.permits.filter(
        status="issued", control_revision=permit.control_revision
    ).update(status="canceled", updated_at=timezone.now())


@transaction.atomic
def ingest(identifier, *, token, room_sid, participant_sid, track_sid, wav):  # noqa: PLR0913 -- Exact origin plus one bounded binary body.
    """Consume one permit atomically; replay the same bytes after ambiguous delivery."""
    initial = models.VoiceprintSamplingPermit.objects.filter(pk=identifier).first()
    if initial is None:
        raise VoiceprintError("voiceprint_sampling_permit_unavailable", status=404)
    user = consent.owner(models.User(pk=initial.owner_id), lock=True)
    profile = consent.authorize_profile(
        initial.profile_id,
        permission="allow_accumulation",
        version=initial.consent_version,
        generation=initial.generation,
    )
    consent.scope(user, profile.consent.organization_id, lock=True)
    models.VoiceprintConsent.objects.select_for_update().get(pk=profile.consent_id)
    models.MeetingSession.objects.select_for_update().filter(
        pk=initial.source_session_id
    ).first()
    models.VoiceprintSamplingTrack.objects.select_for_update().filter(
        pk=initial.track_id
    ).first()
    permit = models.VoiceprintSamplingPermit.objects.select_for_update().get(
        pk=initial.pk
    )
    if (
        room_sid != permit.livekit_room_sid
        or participant_sid != permit.participant_sid
        or track_sid != permit.source_track_sid
        or not isinstance(token, str)
        or len(token) != 43
        or not token.isascii()
        or not hmac.compare_digest(token_for(permit, profile), token)
    ):
        raise VoiceprintError("voiceprint_sampling_permit_invalid")
    if permit.status == "consumed" and permit.sample_id:
        sample = permit.sample
        profile = enrollment.sample_authorized(sample)
    else:
        profile = authorize(permit)
        sample = None
    wav, duration = enrollment.normalize_wav(wav)
    if duration > permit.max_duration_ms:
        raise VoiceprintError("voiceprint_sampling_clip_too_long", status=422)
    digest = hashlib.sha256(wav).hexdigest()
    if sample:
        if sample.audio_sha256 != digest:
            raise VoiceprintError("voiceprint_request_conflict", status=409)
        return clip_receipt(sample)
    if profile.samples.filter(
        generation=profile.generation, audio_sha256=digest
    ).exists():
        raise VoiceprintError("voiceprint_duplicate_audio", status=409)
    identifier = uuid4()
    sample = models.VoiceprintSample.objects.create(
        id=identifier,
        profile=profile,
        generation=permit.generation,
        consent_version=permit.consent_version,
        permit_id=permit.pk,
        source_type="call",
        source_session_id=permit.source_session_id,
        source_track=permit.source_track_sid,
        end_ms=duration,
        audio_sha256=digest,
        encrypted_audio=load_keyring().encrypt(
            profile, wav, kind="audio", object_id=identifier
        ),
        expires_at=timezone.now()
        + timezone.timedelta(hours=enrollment.CANDIDATE_HOURS),
    )
    permit.sample = sample
    permit.status = "consumed"
    permit.save(update_fields=["sample", "status", "updated_at"])
    # Final recheck makes the stored candidate unusable if any source changed.
    enrollment.sample_authorized(sample)
    models.VoiceprintEncodingJob.objects.create(
        sample=sample, expires_at=sample.expires_at
    )
    return clip_receipt(sample)
