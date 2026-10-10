"""Invalidate biometric permissions on account/membership loss and retain tombstones."""

from uuid import uuid4

from django.db.models import Max
from django.db.models.signals import post_delete, post_save, pre_delete

from core import models
from core.services.voiceprint_consent import (
    active_member,
    invalidate_subject,
    revocation_floor,
)


def account_changed(sender, instance, **kwargs):
    if not instance.is_active or instance.is_device:
        if models.VoiceprintConsent.objects.filter(user=instance).exists():
            invalidate_subject(instance, all_scopes=True, reason="account_unavailable")


def membership_changed(sender, instance, **kwargs):
    origin = kwargs.get("origin")
    if (
        origin is not None
        and getattr(origin, "model", type(origin)) is not models.Membership
    ):
        # A User/Organization cascade already collected its child FK actions.
        # Creating consent events here would leave new children outside that
        # collector; the consent's pre-delete hook writes an independent tombstone.
        return
    if not models.VoiceprintConsent.objects.filter(
        user_id=instance.user_id, organization_id=instance.organization_id
    ).exists():
        return
    organization = models.Organization.objects.filter(
        pk=instance.organization_id
    ).first()
    if not active_member(instance.user, organization):
        invalidate_subject(
            instance.user, instance.organization_id, reason="membership_unavailable"
        )


def consent_removed(sender, instance, **kwargs):
    # The deletion collector has already enumerated its FK actions. New
    # tombstones deliberately have no consent FK and survive the whole cascade.
    from core.services import speaker_identity_jobs  # noqa: PLC0415

    speaker_identity_jobs.invalidate_consent_work(instance)
    maximum = instance.profiles.aggregate(value=Max("generation"))["value"] or 0
    models.VoiceprintDeletionJob.objects.create(
        consent=None,
        owner_id=instance.user_id,
        organization_id=instance.organization_id,
        request_key=uuid4(),
        expected_version=instance.version,
        revoked_generation=max(
            instance.generation + 1,
            maximum + 1,
            revocation_floor(instance.user_id, instance.organization_id),
        ),
        reason="scope_removed",
    )


def connect_handlers():
    post_save.connect(
        account_changed,
        sender=models.User,
        dispatch_uid="vp_account_changed",
        weak=False,
    )
    post_save.connect(
        membership_changed,
        sender=models.Membership,
        dispatch_uid="vp_membership_changed",
        weak=False,
    )
    post_delete.connect(
        membership_changed,
        sender=models.Membership,
        dispatch_uid="vp_membership_deleted",
        weak=False,
    )
    pre_delete.connect(
        consent_removed,
        sender=models.VoiceprintConsent,
        dispatch_uid="vp_consent_removed",
        weak=False,
    )
