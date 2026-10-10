"""Drain scope erasure and recheck completed tombstones after restored rows."""

import logging

from django.db import transaction
from django.db.models import Case, Exists, F, OuterRef, Q, When
from django.utils import timezone

from billiard.exceptions import SoftTimeLimitExceeded

from core import models
from core.services.voiceprint_consent import PERMIT_CONTEXT, purge_deleted

logger = logging.getLogger(__name__)


def scoped_exists(rows, organization_field):
    # SQL equality against a nullable OuterRef would silently miss personal scopes.
    return Case(
        When(
            organization_id__isnull=True,
            then=Exists(rows.filter(**{organization_field + "__isnull": True})),
        ),
        default=Exists(
            rows.filter(**{organization_field: OuterRef("organization_id")})
        ),
    )


def restored_jobs():
    before_floor = {"generation__lt": OuterRef("revoked_generation")}
    profiles = models.VoiceprintProfile.objects.filter(
        consent__user_id=OuterRef("owner_id"), **before_floor
    )
    owned = {"profile__consent__user_id": OuterRef("owner_id"), **before_floor}
    evidence = {
        "samples": scoped_exists(
            models.VoiceprintSample.objects.filter(**owned),
            "profile__consent__organization_id",
        ),
        "templates": scoped_exists(
            models.VoiceprintTemplate.objects.filter(**owned),
            "profile__consent__organization_id",
        ),
        "keys": scoped_exists(
            profiles.exclude(status="deleted", encrypted_key=b""),
            "consent__organization_id",
        ),
        "consent": scoped_exists(
            models.VoiceprintConsent.objects.filter(
                user_id=OuterRef("owner_id"), **before_floor
            ),
            "organization_id",
        ),
        "permits": scoped_exists(
            models.VoiceprintSamplingPermit.objects.filter(PERMIT_CONTEXT, **owned),
            "profile__consent__organization_id",
        ),
        "enrollments": scoped_exists(
            models.VoiceprintEnrollment.objects.filter(
                owner_id=OuterRef("owner_id"),
                status__in=["open", "closed"],
                **before_floor,
            ),
            "organization_id",
        ),
    }
    pending = Q()
    for name in evidence:
        pending |= Q(**{"restored_" + name: True})
    return (
        models.VoiceprintDeletionJob.objects.filter(status="succeeded")
        .annotate(**{"restored_" + name: value for name, value in evidence.items()})
        .filter(pending)
    )


def pending_ids(limit):
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError("voiceprint_erasure_limit_invalid")
    restored = list(
        restored_jobs()
        .order_by("created_at", "id")
        .values_list("pk", flat=True)[:limit]
    )
    models.VoiceprintDeletionJob.objects.filter(
        pk__in=restored, status="succeeded"
    ).update(
        status="queued",
        attempts=0,
        finished_at=None,
        error_code="",
        updated_at=timezone.now(),
    )
    return list(
        models.VoiceprintDeletionJob.objects.filter(
            status__in=["queued", "failed"], attempts__lt=3
        )
        .order_by("created_at", "id")
        .values_list("pk", flat=True)[:limit]
    )


@transaction.atomic
def process_one(identifier):
    row = models.VoiceprintDeletionJob.objects.filter(pk=identifier).first()
    if row is None:
        return "missing"
    for model, key in (
        (models.User, row.owner_id),
        (models.Organization, row.organization_id),
    ):
        if key is not None:
            locked = (
                model.objects.select_for_update(skip_locked=True)
                .filter(pk=key)
                .exists()
            )
            if not locked and model.objects.filter(pk=key).exists():
                return "busy"
    consent = models.VoiceprintConsent.objects.filter(
        user_id=row.owner_id, organization_id=row.organization_id
    )
    if consent.exists() and not consent.select_for_update(skip_locked=True).exists():
        return "busy"
    if (
        not models.VoiceprintDeletionJob.objects.select_for_update(skip_locked=True)
        .filter(pk=identifier)
        .exists()
    ):
        return "busy"
    return purge_deleted(identifier).status


def tick(limit=20):
    counts = dict.fromkeys(("succeeded", "failed", "busy", "missing"), 0)
    for identifier in pending_ids(limit):
        try:
            status = process_one(identifier)
        except SoftTimeLimitExceeded:
            raise
        except Exception:  # noqa: BLE001 -- Never log media, keys or underlying private errors.
            status = "failed"
            models.VoiceprintDeletionJob.objects.filter(pk=identifier).exclude(
                status="succeeded"
            ).update(
                status="failed",
                attempts=F("attempts") + 1,
                error_code="cleanup_unavailable",
                updated_at=timezone.now(),
            )
        counts[status] += 1
    if counts["failed"]:
        logger.warning("voiceprint_erasure_failed count=%s", counts["failed"])
    return counts
