"""Bounded retention without refunding reservations or discarding trusted proofs."""

from types import SimpleNamespace

from django.db import transaction
from django.db.models import Exists, F, OuterRef, Q
from django.utils import timezone

from core import models
from core.services import voiceprint_source_removal as removal

TERMINAL = ("canceled", "expired", "consumed")


def active_session(field):
    return Exists(
        models.MeetingSession.objects.filter(pk=OuterRef(field), status="active")
    )


def has_context():
    return (
        Q(profile__isnull=False)
        | ~Q(source_track_sid="")
        | ~Q(livekit_room_sid="")
        | ~Q(participant_sid="")
        | ~Q(participant_identity="")
        | ~Q(device_group="")
    )


def sample_ids(limit):
    return list(
        models.VoiceprintSample.objects.filter(
            Q(pk__in=models.VoiceprintContributionRemoval.objects.values("sample_uuid"))
            | Q(expires_at__lte=timezone.now())
            & (
                ~Q(status="confirmed")
                | ~Q(generation=F("profile__consent__generation"))
            )
            | Q(status="confirmed", generation=F("profile__consent__generation"))
            & ~Q(encrypted_audio=b"")
            & (~Q(encrypted_embedding=b"") | Q(expires_at__lte=timezone.now()))
        )
        .order_by("expires_at", "id")
        .values_list("pk", flat=True)[:limit]
    )


@transaction.atomic
def clean_sample(identifier):  # noqa: PLR0911 -- Keep each locked retention guard explicit.
    initial = (
        models.VoiceprintSample.objects.filter(pk=identifier)
        .values(
            "profile_id",
            "profile__consent__user_id",
            "profile__consent__organization_id",
        )
        .first()
    )
    if initial is None:
        return "missing"
    scope = SimpleNamespace(
        profile_uuid=initial["profile_id"],
        owner_uuid=initial["profile__consent__user_id"],
        organization_uuid=initial["profile__consent__organization_id"],
    )
    profile = removal.lock_scope(scope)
    if profile is False:
        return "busy"
    row = (
        models.VoiceprintSample.objects.select_for_update(skip_locked=True)
        .filter(pk=identifier, profile=profile)
        .first()
    )
    if row is None:
        return (
            "busy"
            if models.VoiceprintSample.objects.filter(pk=identifier).exists()
            else "missing"
        )
    removed = removal.sample_removed(row.pk)
    if (
        not removed
        and row.status == "confirmed"
        and row.generation == profile.consent.generation
    ):
        if row.encrypted_audio and (
            row.encrypted_embedding or row.expires_at <= timezone.now()
        ):
            models.VoiceprintSample.objects.filter(pk=row.pk).update(
                encrypted_audio=b"", updated_at=timezone.now()
            )
            return "audio_cleared"
        return "retained"
    if not removed and row.expires_at > timezone.now():
        return "retained"
    # Freeze receipt/template references before any FK or M2M cascade. The
    # existing worker can finish the independent rebuild on its next tick.
    removal.enroll(models.VoiceprintSample.objects.filter(pk=row.pk), dispatch=False)
    job = models.VoiceprintContributionRemoval.objects.get(sample_uuid=row.pk)
    result = removal.purge(job.pk)
    return "sample_purged" if result == "purged" else result


def permit_ids(limit):
    now = timezone.now()
    return list(
        models.VoiceprintSamplingPermit.objects.annotate(
            source_active=active_session("source_session_id")
        )
        .filter(
            Q(status="issued", expires_at__lte=now)
            | Q(sample__isnull=True, status__in=TERMINAL)
            & (
                has_context()
                | Q(
                    source_active=False,
                    created_at__lt=now - timezone.timedelta(hours=24),
                    expires_at__lte=now,
                )
            )
        )
        .order_by("expires_at", "id")
        .values_list("pk", flat=True)[:limit]
    )


def lock_origin(initial):
    session = (
        models.MeetingSession.objects.select_for_update(skip_locked=True)
        .filter(pk=initial["source_session_id"])
        .first()
    )
    if (
        session is None
        and models.MeetingSession.objects.filter(
            pk=initial["source_session_id"]
        ).exists()
    ):
        return False
    if initial.get("track_id"):
        track = (
            models.VoiceprintSamplingTrack.objects.select_for_update(skip_locked=True)
            .filter(pk=initial["track_id"])
            .first()
        )
        if (
            track is None
            and models.VoiceprintSamplingTrack.objects.filter(
                pk=initial["track_id"]
            ).exists()
        ):
            return False
    return session


@transaction.atomic
def clean_permit(identifier):  # noqa: PLR0911 -- Preserve quota and proof checks before any removal.
    initial = (
        models.VoiceprintSamplingPermit.objects.filter(pk=identifier)
        .values("owner_id", "source_session_id", "track_id")
        .first()
    )
    if initial is None:
        return "missing"
    user = (
        models.User.objects.select_for_update(skip_locked=True)
        .filter(pk=initial["owner_id"])
        .first()
    )
    if user is None:
        return (
            "busy"
            if models.User.objects.filter(pk=initial["owner_id"]).exists()
            else "missing"
        )
    session = lock_origin(initial)
    if session is False:
        return "busy"
    permit = (
        models.VoiceprintSamplingPermit.objects.select_for_update(skip_locked=True)
        .filter(pk=identifier)
        .first()
    )
    if permit is None:
        return (
            "busy"
            if models.VoiceprintSamplingPermit.objects.filter(pk=identifier).exists()
            else "missing"
        )
    now = timezone.now()
    expired = permit.status == "issued" and permit.expires_at <= now
    if expired:
        permit.status = "expired"
        models.VoiceprintSamplingPermit.objects.filter(pk=permit.pk).update(
            status="expired", updated_at=now
        )
    if permit.sample_id is not None or permit.status not in TERMINAL:
        return "permit_expired" if expired else "retained"
    if (
        permit.created_at < now - timezone.timedelta(hours=24)
        and permit.expires_at <= now
        and (session is None or session.status != "active")
    ):
        permit.delete()
        return "permit_purged"
    # Retain the track FK until the quota row can be removed: it also binds an
    # expired/canceled request key, preventing retries from charging it again.
    changed = permit.profile_id is not None or any(
        getattr(permit, field)
        for field in (
            "source_track_sid",
            "livekit_room_sid",
            "participant_sid",
            "participant_identity",
            "device_group",
        )
    )
    if changed:
        models.VoiceprintSamplingPermit.objects.filter(pk=permit.pk).update(
            profile=None,
            source_track_sid="",
            livekit_room_sid="",
            participant_sid="",
            participant_identity="",
            device_group="",
            updated_at=now,
        )
    return "permit_expired" if expired else "permit_scrubbed" if changed else "retained"


def track_ids(limit):
    return list(
        models.VoiceprintSamplingTrack.objects.filter(
            Q(unpublished_at__isnull=False)
            | Q(participation__left_at__isnull=False)
            | ~Q(participation__session__status="active")
        )
        .annotate(
            permit_exists=Exists(
                models.VoiceprintSamplingPermit.objects.filter(track_id=OuterRef("pk"))
            ),
            sample_exists=Exists(
                models.VoiceprintSample.objects.filter(
                    source_session_id=OuterRef("participation__session_id"),
                    source_track=OuterRef("livekit_track_sid"),
                )
            ),
        )
        .filter(permit_exists=False, sample_exists=False)
        .order_by("created_at", "id")
        .values_list("pk", flat=True)[:limit]
    )


@transaction.atomic
def clean_track(identifier):
    initial = (
        models.VoiceprintSamplingTrack.objects.filter(pk=identifier)
        .values("participation__session_id")
        .first()
    )
    if initial is None:
        return "missing"
    session = lock_origin({"source_session_id": initial["participation__session_id"]})
    if session is False:
        return "busy"
    track = (
        models.VoiceprintSamplingTrack.objects.select_for_update(
            skip_locked=True, of=("self",)
        )
        .select_related("participation")
        .filter(pk=identifier)
        .first()
    )
    if track is None:
        return (
            "busy"
            if models.VoiceprintSamplingTrack.objects.filter(pk=identifier).exists()
            else "missing"
        )
    if (
        session is not None
        and session.status == "active"
        and (track.unpublished_at is None and track.participation.left_at is None)
    ):
        return "retained"
    if (
        track.permits.exists()
        or models.VoiceprintSample.objects.filter(
            source_session_id=initial["participation__session_id"],
            source_track=track.livekit_track_sid,
        ).exists()
    ):
        return "retained"
    # The deletion signal writes the SID digest fence before removing the row.
    track.delete()
    return "track_purged"


def tick(limit=20):
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("voiceprint_maintenance_limit_invalid")
    counts = dict.fromkeys(
        (
            "audio_cleared",
            "sample_purged",
            "permit_expired",
            "permit_scrubbed",
            "permit_purged",
            "track_purged",
            "retained",
            "busy",
            "missing",
            "failed",
        ),
        0,
    )
    # Each category has its own bound so proof rows cannot starve quota cleanup.
    for select, clean in (
        (sample_ids, clean_sample),
        (permit_ids, clean_permit),
        (track_ids, clean_track),
    ):
        for identifier in select(limit):
            try:
                result = clean(identifier)
                if result not in counts:
                    result = "failed"
            except Exception:  # noqa: BLE001 -- Fixed counters, no media or private diagnostics.
                result = "failed"
            counts[result] += 1
    return counts
