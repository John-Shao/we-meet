"""Expired unconfirmed features are unusable; confirmed audio is short-lived."""

from django.db import transaction
from django.utils import timezone

from core import models


@transaction.atomic
def expire_sample(identifier):
    initial = (
        models.VoiceprintSample.objects.filter(pk=identifier)
        .values(
            "profile__consent__user_id",
            "profile__consent_id",
        )
        .first()
    )
    if initial is None:
        return False
    models.User.objects.select_for_update().filter(
        pk=initial["profile__consent__user_id"]
    ).first()
    models.VoiceprintConsent.objects.select_for_update().filter(
        pk=initial["profile__consent_id"]
    ).first()
    row = (
        models.VoiceprintSample.objects.select_for_update()
        .filter(pk=identifier)
        .first()
    )
    if row is None or row.expires_at > timezone.now():
        return False
    current_generation = row.profile.consent.generation
    retain_feature = row.status == "confirmed" and row.generation == current_generation
    if not retain_feature:
        for job_model in (models.VoiceprintEncodingJob, models.VoiceprintQualityJob):
            job_model.objects.filter(
                sample=row, status__in=["queued", "running", "failed"]
            ).update(
                status="expired",
                lease_token=None,
                lease_until=None,
                retryable=False,
                finished_at=timezone.now(),
                updated_at=timezone.now(),
            )
    changed = bool(row.encrypted_audio) or (
        not retain_feature and bool(row.encrypted_embedding)
    )
    row.encrypted_audio = b""
    if not retain_feature:
        row.encrypted_embedding = b""
        if row.generation != current_generation:
            target = "deleted"
        elif row.status in {"rejected", "deleted"}:
            target = row.status
        else:
            target = "expired"
        changed = changed or row.status != target
        row.status = target
    if changed:
        row.save(
            update_fields=[
                "encrypted_audio",
                "encrypted_embedding",
                "status",
                "updated_at",
            ]
        )
    return changed
