"""Persistent source fences, physical contribution removal and bounded rebuilds.

Source projection takes only the session lock. Cleanup later takes the normal
owner/scope lock order, so deleting a room never waits for an owner while holding
the session row that an ingest worker needs. No media or provider IO runs here.
"""

import hashlib
import logging
from contextlib import closing

from django.db import transaction
from django.db.models import Exists, F, OuterRef, Q
from django.utils import timezone

from core import models

logger = logging.getLogger(__name__)
MAX_TEMPLATES = 5


def is_baseline(template):
    from core.services.voiceprint_devices import (  # noqa: PLC0415 -- Source projection must not create a sampling import cycle.
        is_baseline as confirmed_baseline,
    )

    return confirmed_baseline(template)


def track_digest(identifier):
    return hashlib.sha256(
        b"we-meet-track-removal-v1\x00" + identifier.encode("ascii")
    ).hexdigest()


def session_removed(identifier):
    if identifier is None:
        return False
    return (
        models.VoiceprintSourceRemoval.objects.filter(
            source_session_id=identifier
        ).exists()
        or models.MeetingRecord.objects.filter(
            source_type="meeting",
            source_session_id=identifier,
            deleted_at__isnull=False,
        ).exists()
    )


def sample_removed(identifier):
    return models.VoiceprintContributionRemoval.objects.filter(
        sample_uuid=identifier
    ).exists()


def schedule():
    from core.tasks.voiceprint_source_removal import (  # noqa: PLC0415 -- Keep signal projection independent of task imports.
        drain_voiceprint_source_removals,
    )

    def enqueue():
        try:
            drain_voiceprint_source_removals.delay()
        except Exception:  # noqa: BLE001 -- Durable intents remain recoverable after broker failure.
            logger.warning(
                "voiceprint_source_cleanup_enqueue_unavailable", exc_info=False
            )

    transaction.on_commit(enqueue)


def clear_receipts(permits):
    """Keep only owner/time/session/duration fields needed by quota enforcement."""
    permits.update(
        sample=None,
        track=None,
        profile=None,
        status="canceled",
        livekit_room_sid="",
        participant_sid="",
        participant_identity="",
        source_track_sid="",
        device_group="",
        updated_at=timezone.now(),
    )


def enroll(rows, *, dispatch=True):
    pending = []
    changed = False
    with closing(
        rows.select_related("profile__consent")
        .defer("encrypted_audio", "encrypted_embedding")
        .iterator(chunk_size=64)
    ) as iterator:
        for sample in iterator:
            if sample_removed(sample.pk):
                continue
            artifacts = list(
                sample.templates.filter(generation=sample.generation).defer(
                    "encrypted_vector"
                )[: MAX_TEMPLATES + 1]
            )
            permit_id = (
                models.VoiceprintSamplingPermit.objects.filter(
                    sample=sample,
                    profile=sample.profile,
                    owner_id=sample.profile.consent.user_id,
                    generation=sample.generation,
                )
                .values_list("pk", flat=True)
                .first()
            )
            pending.append(
                models.VoiceprintContributionRemoval(
                    sample_uuid=sample.pk,
                    profile_uuid=sample.profile_id,
                    owner_uuid=sample.profile.consent.user_id,
                    organization_uuid=sample.profile.consent.organization_id,
                    generation=sample.generation,
                    templates={
                        "all": len(artifacts) > MAX_TEMPLATES,
                        "permit_id": str(permit_id) if permit_id else None,
                        "rows": [
                            {
                                "id": str(row.pk),
                                "revision": row.revision,
                                "digest": row.support_digest,
                                "baseline": is_baseline(row),
                            }
                            for row in artifacts
                        ],
                    },
                )
            )
            if len(pending) == 64:
                models.VoiceprintContributionRemoval.objects.bulk_create(
                    pending, ignore_conflicts=True
                )
                pending.clear()
                changed = True
    if pending:
        models.VoiceprintContributionRemoval.objects.bulk_create(
            pending, ignore_conflicts=True
        )
        changed = True
    if changed and dispatch:
        schedule()


@transaction.atomic
def remove_source(kind, instance, *, dispatch=True):
    """Called by deletion/save signals before origin FKs are lost."""
    session_id = None
    digest = ""
    if kind == "session":
        session_id = instance.pk
        query = Q(source_type="call", source_session_id=session_id)
    elif kind == "track":
        session_id = instance.participation.session_id
        digest = track_digest(instance.livekit_track_sid)
        query = Q(sampling_permit__track=instance) | Q(
            source_type="call",
            source_session_id=session_id,
            source_track=instance.livekit_track_sid,
        )
    elif kind == "record":
        session_id = (
            instance.source_session_id if instance.source_type == "meeting" else None
        )
        query = Q(source_record_id=instance.pk)
        if session_id:
            query |= Q(source_type="call", source_session_id=session_id)
    else:
        raise ValueError("source_removal_kind_invalid")
    if session_id:
        models.MeetingSession.objects.select_for_update().filter(pk=session_id).first()
    models.VoiceprintSourceRemoval.objects.get_or_create(
        kind=kind,
        source_uuid=instance.pk,
        defaults={
            "source_session_id": session_id if kind != "track" else None,
            "track_digest": digest,
        },
    )
    permits = models.VoiceprintSamplingPermit.objects.filter(status="issued")
    if kind == "track":
        permits = permits.filter(track=instance)
    elif session_id:
        permits = permits.filter(source_session_id=session_id)
    else:
        permits = permits.none()
    enroll(
        models.VoiceprintSample.objects.filter(query).order_by("id"),
        dispatch=dispatch,
    )
    clear_receipts(permits)


@transaction.atomic
def remove_sample(instance):
    """Freeze dependency revisions before an ORM cascade removes M2M links."""
    if instance.source_type == "call" or instance.templates.exists():
        enroll(models.VoiceprintSample.objects.filter(pk=instance.pk))


def lock_scope(initial):
    """A busy scope is deferred; absent subjects can still finish tombstones."""
    user = (
        models.User.objects.select_for_update(skip_locked=True)
        .filter(pk=initial.owner_uuid)
        .first()
    )
    if user is None and models.User.objects.filter(pk=initial.owner_uuid).exists():
        return False
    if initial.organization_uuid:
        organization = (
            models.Organization.objects.select_for_update(skip_locked=True)
            .filter(pk=initial.organization_uuid)
            .first()
        )
        if (
            organization is None
            and models.Organization.objects.filter(
                pk=initial.organization_uuid
            ).exists()
        ):
            return False
    permission = models.VoiceprintConsent.objects.filter(
        user_id=initial.owner_uuid, organization_id=initial.organization_uuid
    )
    if (
        permission.exists()
        and not permission.select_for_update(skip_locked=True).exists()
    ):
        return False
    profile = (
        models.VoiceprintProfile.objects.select_for_update(
            skip_locked=True, of=("self",)
        )
        .filter(
            pk=initial.profile_uuid,
            consent__user_id=initial.owner_uuid,
            consent__organization_id=initial.organization_uuid,
        )
        .first()
    )
    if (
        profile is None
        and models.VoiceprintProfile.objects.filter(pk=initial.profile_uuid).exists()
    ):
        return False
    return profile


def affected_templates(job, profile):
    scope = profile.templates.filter(generation=job.generation)
    current_ids = list(
        scope.filter(support_samples__pk=job.sample_uuid).values_list("pk", flat=True)[
            : MAX_TEMPLATES + 1
        ]
    )
    snapshots = job.templates["rows"]
    rows = list(
        scope.select_for_update()
        .filter(Q(pk__in=current_ids) | Q(pk__in=[row["id"] for row in snapshots]))
        .defer("encrypted_vector")[: MAX_TEMPLATES + 1]
    )
    originals = {row["id"]: row for row in snapshots}
    affected = [
        row
        for row in rows
        if row.pk in current_ids
        or (
            str(row.pk) in originals
            and row.support_digest == originals[str(row.pk)]["digest"]
        )
    ]
    anchors = [
        row
        for row in affected
        if is_baseline(row) or originals.get(str(row.pk), {}).get("baseline") is True
    ]
    clear_all = job.templates["all"] or len(current_ids) > MAX_TEMPLATES
    if anchors:
        dependencies = list(
            scope.filter(
                basis__baseline_id__in=[str(row.pk) for row in anchors]
            ).values_list("pk", flat=True)[: MAX_TEMPLATES + 1]
        )
        if len(dependencies) > MAX_TEMPLATES:
            clear_all = True
        current_ids = [row.pk for row in affected] + dependencies
    else:
        current_ids = [row.pk for row in affected]
    return scope if clear_all else scope.filter(pk__in=current_ids), bool(
        anchors
    ) or clear_all


@transaction.atomic
def purge(identifier):
    initial = models.VoiceprintContributionRemoval.objects.filter(pk=identifier).first()
    if initial is None:
        return "missing"
    profile = lock_scope(initial)
    if profile is False:
        return "busy"
    job = (
        models.VoiceprintContributionRemoval.objects.select_for_update(skip_locked=True)
        .filter(pk=identifier)
        .first()
    )
    if job is None:
        return "busy"
    if job.status != "queued":
        return job.status
    sample = (
        models.VoiceprintSample.objects.select_for_update(skip_locked=True)
        .filter(pk=job.sample_uuid)
        .first()
    )
    if (
        sample is None
        and models.VoiceprintSample.objects.filter(pk=job.sample_uuid).exists()
    ):
        return "busy"
    if sample is not None and (
        sample.profile_id != job.profile_uuid or sample.generation != job.generation
    ):
        raise ValueError("source_cleanup_scope_changed")
    if profile:
        affected, baseline_lost = affected_templates(job, profile)
        affected.update(
            status="paused",
            revision=F("revision") + 1,
            encrypted_vector=b"",
            support_digest="",
            updated_at=timezone.now(),
        )
        if profile.generation == job.generation:
            if baseline_lost and profile.status == "active":
                profile.status = "paused"
            profile.template_checked_at = None
            profile.save(update_fields=["status", "template_checked_at", "updated_at"])
    permits = models.VoiceprintSamplingPermit.objects.filter(sample_id=job.sample_uuid)
    if job.templates.get("permit_id"):
        permits = models.VoiceprintSamplingPermit.objects.filter(
            Q(sample_id=job.sample_uuid)
            | Q(
                pk=job.templates["permit_id"],
                owner_id=job.owner_uuid,
                generation=job.generation,
            )
        )
    clear_receipts(permits)
    models.VoiceprintTemplate.support_samples.through.objects.filter(
        voiceprintsample_id=job.sample_uuid
    ).delete()
    # This also removes leases, quality jobs and the private sample decision.
    models.VoiceprintSample.objects.filter(pk=job.sample_uuid).delete()
    job.status = "purged"
    job.purged_at = timezone.now()
    job.attempts += 1
    job.error_code = ""
    job.save(
        update_fields=["status", "purged_at", "attempts", "error_code", "updated_at"]
    )
    return job.status


def process_one(identifier):
    from core.services.voiceprint_templates import (  # noqa: PLC0415 -- Rebuild follows the independently committed physical purge.
        build,
    )

    status = purge(identifier)
    if status != "purged":
        return status
    job = models.VoiceprintContributionRemoval.objects.get(pk=identifier)
    profile = models.VoiceprintProfile.objects.filter(pk=job.profile_uuid).first()
    if (
        profile is None
        or profile.generation != job.generation
        or profile.status == "deleted"
    ):
        result = "unavailable"
    else:
        result = build(profile.pk).status
        if result in {"disabled", "unavailable"}:
            return "deferred"
    models.VoiceprintContributionRemoval.objects.filter(
        pk=job.pk, status="purged"
    ).update(
        status="complete",
        completed_at=timezone.now(),
        error_code="",
        updated_at=timezone.now(),
    )
    return "complete"


def tick(limit=20):
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("source_cleanup_limit_invalid")
    reconcile(limit)
    identifiers = list(
        models.VoiceprintContributionRemoval.objects.exclude(status="complete")
        .filter(next_attempt_at__lte=timezone.now())
        .order_by("next_attempt_at", "created_at", "id")
        .values_list("pk", flat=True)[:limit]
    )
    counts = dict.fromkeys(("complete", "deferred", "busy", "failed", "missing"), 0)
    for identifier in identifiers:
        try:
            status = process_one(identifier)
        except Exception:  # noqa: BLE001 -- Sanitized retry state; no source payloads or raw diagnostics.
            status = "failed"
            models.VoiceprintContributionRemoval.objects.filter(pk=identifier).exclude(
                status="complete"
            ).update(
                error_code="source_cleanup_unavailable",
                attempts=F("attempts") + 1,
            )
        counts[status] += 1
        if status not in {"complete", "missing"}:
            models.VoiceprintContributionRemoval.objects.filter(pk=identifier).exclude(
                status="complete"
            ).update(
                next_attempt_at=timezone.now() + timezone.timedelta(seconds=30),
                updated_at=timezone.now(),
            )
    return counts


def reconcile(limit=20):
    """Recover bulk-save bypasses and origins lost before signals were installed."""
    removed_records = models.VoiceprintSourceRemoval.objects.filter(
        kind="record"
    ).values("source_uuid")
    records = list(
        models.MeetingRecord.objects.filter(deleted_at__isnull=False)
        .exclude(pk__in=removed_records)
        .order_by("id")[:limit]
    )
    for record in records:
        remove_source("record", record, dispatch=False)
    orphaned = (
        models.VoiceprintSample.objects.filter(source_type="call")
        .exclude(
            pk__in=models.VoiceprintContributionRemoval.objects.values("sample_uuid")
        )
        .annotate(
            session_exists=Exists(
                models.MeetingSession.objects.filter(pk=OuterRef("source_session_id"))
            )
        )
        .filter(
            Q(sampling_permit__isnull=True)
            | Q(sampling_permit__track__isnull=True)
            | Q(session_exists=False)
            | Q(
                source_session_id__in=models.VoiceprintSourceRemoval.objects.exclude(
                    source_session_id=None
                ).values("source_session_id")
            )
        )
        .order_by("id")
    )
    with transaction.atomic():
        enroll(orphaned[:limit], dispatch=False)
