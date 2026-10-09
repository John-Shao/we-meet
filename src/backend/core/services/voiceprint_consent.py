"""Owner-only scope permissions, generation tombstones and private profile keys."""

from uuid import uuid4

from django.conf import settings
from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from core import models
from core.services.audit import record_audit
from core.services.voiceprint_crypto import load_keyring
from core.services.voiceprint_encoder import DIMENSION, FEATURE_SPACE

PERMISSIONS = ("allow_enrollment", "allow_accumulation", "allow_identification")
# Conservative registration gate from the plan, pending authorized human calibration.
MIN_REGISTRATION_CLIPS = 3
MIN_REGISTRATION_SPEECH_MS = 30000
MAX_ACTIVE_TEMPLATES = 5


class VoiceprintError(ValueError):
    def __init__(self, code, *, status=403):
        super().__init__(code)
        self.status = status


def owner(actor, *, lock=False):
    queryset = models.User.objects
    if lock:
        queryset = queryset.select_for_update()
    row = queryset.filter(pk=actor.pk, is_active=True, is_device=False).first()
    if row is None:
        raise VoiceprintError("voiceprint_account_unavailable")
    return row


def active_member(user, organization):
    return bool(
        organization
        and organization.is_active
        and models.Membership.objects.filter(
            user=user,
            organization=organization,
            status=models.MembershipStatusChoices.ACTIVE,
        ).exists()
    )


def organization_policy(organization):
    raw = (
        organization.settings.get("voiceprint", {})
        if isinstance(organization.settings, dict)
        else {}
    )
    if not isinstance(raw, dict):
        raw = {}
    version_valid = type(raw.get("version")) is int and raw["version"] >= 0
    return {
        "enabled": version_valid and raw.get("enabled") is True,
        "version": raw["version"] if version_valid else 0,
    }


def available(user, organization):
    if not settings.MEETING_VOICEPRINT_ENABLED or not user.is_active or user.is_device:
        return False
    return organization is None or (
        active_member(user, organization)
        and organization_policy(organization)["enabled"]
    )


def scope(user, organization_id, *, lock=False):
    if organization_id is None:
        return None
    queryset = models.Organization.objects
    if lock:
        queryset = queryset.select_for_update()
    organization = queryset.filter(pk=organization_id).first()
    # A former member may still read/revoke their own existing permissions.
    if organization is None or not (
        active_member(user, organization)
        or models.VoiceprintConsent.objects.filter(
            user=user, organization=organization
        ).exists()
    ):
        raise VoiceprintError("voiceprint_scope_unavailable", status=404)
    return organization


def snapshot(consent, *, user, organization):
    result = {
        "organization_id": str(organization.pk) if organization else None,
        "available": available(user, organization),
        "version": consent.version if consent else 0,
        "generation": consent.generation if consent else 0,
        **{name: getattr(consent, name) if consent else False for name in PERMISSIONS},
        "profiles": [],
    }
    if consent:
        result["profiles"] = [
            {
                "id": str(row.pk),
                "status": row.status,
                "generation": row.generation,
                "confirmed_at": row.confirmed_at.isoformat()
                if row.confirmed_at
                else None,
                "last_updated_at": row.last_updated_at.isoformat()
                if row.last_updated_at
                else None,
            }
            for row in consent.profiles.order_by("created_at", "id")
        ]
    return result


def read_settings(actor, organization_id=None):
    user = owner(actor)
    organization = scope(user, organization_id)
    consent = models.VoiceprintConsent.objects.filter(
        user=user, organization=organization
    ).first()
    return snapshot(consent, user=user, organization=organization)


def event(consent, action):
    models.VoiceprintConsentEvent.objects.create(
        consent=consent,
        version=consent.version,
        generation=consent.generation,
        action=action,
        permissions={name: getattr(consent, name) for name in PERMISSIONS},
    )


def revocation_floor(user_id, organization_id):
    return (
        models.VoiceprintDeletionJob.objects.filter(
            owner_id=user_id,
            organization_id=organization_id,
        ).aggregate(value=Max("revoked_generation"))["value"]
        or 1
    )


@transaction.atomic
def update_settings(actor, *, organization_id, expected_version, changes):
    user = owner(actor, lock=True)
    organization = scope(user, organization_id, lock=True)
    consent = (
        models.VoiceprintConsent.objects.select_for_update()
        .filter(user=user, organization=organization)
        .first()
    )
    version = consent.version if consent else 0
    if expected_version != version:
        raise VoiceprintError("voiceprint_settings_changed", status=409)
    if (
        not changes
        or set(changes) - set(PERMISSIONS)
        or any(type(value) is not bool for value in changes.values())
    ):
        raise VoiceprintError("voiceprint_settings_invalid", status=400)
    if any(changes.values()) and not available(user, organization):
        raise VoiceprintError("voiceprint_scope_disabled")
    floor = revocation_floor(user.pk, organization_id)
    if consent and consent.generation < floor and any(changes.values()):
        raise VoiceprintError("voiceprint_scope_revoked", status=409)
    previous = {
        name: getattr(consent, name) if consent else False for name in PERMISSIONS
    }
    following = {**previous, **changes}
    if previous == following:
        return snapshot(consent, user=user, organization=organization)
    if consent is None:
        consent = models.VoiceprintConsent(
            user=user, organization=organization, generation=floor
        )
    else:
        consent.version += 1
    for name, value in following.items():
        setattr(consent, name, value)
    now = timezone.now()
    if any(following[name] and not previous[name] for name in PERMISSIONS):
        consent.granted_at = now
    if any(previous[name] and not following[name] for name in PERMISSIONS):
        consent.revoked_at = now
    consent.save()
    cancel_pending_work(consent)
    event(consent, "settings")
    return snapshot(consent, user=user, organization=organization)


def template_ready(template, *, profile):
    """Validate every contribution, not just one valid row in a mixed template."""
    digests = set()
    speech_ms = 0
    # A permission check must not load each contribution's private audio blob.
    samples = template.support_samples.only(
        "profile_id",
        "generation",
        "status",
        "confirmed_at",
        "encrypted_embedding",
        "quality",
        "start_ms",
        "end_ms",
        "audio_sha256",
    )
    samples = list(samples[:13])
    if not MIN_REGISTRATION_CLIPS <= len(samples) <= 12:
        return False
    for sample in samples:
        quality = sample.quality
        if (
            sample.profile_id != profile.pk
            or sample.generation != profile.generation
            or sample.status != "confirmed"
            or sample.confirmed_at is None
            or not sample.encrypted_embedding
            or not isinstance(quality, dict)
            or quality.get("speech_checked") is not True
            or quality.get("speaker_consistency_checked") is not True
            or type(quality.get("valid_speech_ms")) is not int
            or not 3000 <= quality["valid_speech_ms"] <= 10000
            or quality["valid_speech_ms"] > sample.end_ms - sample.start_ms
        ):
            return False
        if sample.audio_sha256 not in digests:
            digests.add(sample.audio_sha256)
            speech_ms += quality["valid_speech_ms"]
    return (
        len(digests) >= MIN_REGISTRATION_CLIPS
        and speech_ms >= MIN_REGISTRATION_SPEECH_MS
    )


def profile_ready(profile):
    # Matching cannot rely on status/booleans alone: validate the authenticated
    # artifact against the current confirmed contributions and policy.
    from core.services.voiceprint_templates import (  # noqa: PLC0415 -- Templates depend on consent guards.
        valid_baseline,
    )

    if profile.feature_space != FEATURE_SPACE:
        return False
    templates = list(
        profile.templates.filter(generation=profile.generation, status="active")[
            : MAX_ACTIVE_TEMPLATES + 1
        ]
    )
    if len(templates) > MAX_ACTIVE_TEMPLATES:
        return False
    return bool(templates) and all(
        template.dimension == DIMENSION
        and bool(template.encrypted_vector)
        and template_ready(template, profile=profile)
        and valid_baseline(template, profile)
        for template in templates
    )


def authorize_profile(
    profile_id, *, permission, version=None, generation=None, expected_scope=None
):
    """Always refresh authorization; a cached profile is never proof of access."""
    if permission not in PERMISSIONS:
        raise VoiceprintError("voiceprint_permission_invalid", status=400)
    profile = (
        models.VoiceprintProfile.objects.select_related(
            "consent__user", "consent__organization"
        )
        .filter(pk=profile_id)
        .first()
    )
    if profile is None:
        raise VoiceprintError("voiceprint_profile_unavailable", status=404)
    consent = profile.consent
    if (
        not available(consent.user, consent.organization)
        or not getattr(consent, permission)
        or consent.generation != profile.generation
        or not profile.encrypted_key
        or profile.generation
        < revocation_floor(consent.user_id, consent.organization_id)
        or profile.status == "deleted"
        or (
            expected_scope is not None
            and expected_scope != (consent.user_id, consent.organization_id)
        )
        or (version is not None and consent.version != version)
        or (generation is not None and consent.generation != generation)
    ):
        raise VoiceprintError("voiceprint_authorization_revoked")
    if permission == "allow_identification" and (
        profile.status != "active"
        or profile.confirmed_at is None
        or profile.last_updated_at is None
        or profile.last_updated_at <= timezone.now() - timezone.timedelta(days=365)
        or not profile_ready(profile)
    ):
        raise VoiceprintError("voiceprint_profile_not_ready")
    return profile


@transaction.atomic
def ensure_profile(actor, *, organization_id, expected_version):
    """Internal enrollment foundation; no public vector or arbitrary model input."""
    user = owner(actor, lock=True)
    organization = scope(user, organization_id, lock=True)
    consent = (
        models.VoiceprintConsent.objects.select_for_update()
        .filter(user=user, organization=organization)
        .first()
    )
    if not consent or consent.version != expected_version:
        raise VoiceprintError("voiceprint_settings_changed", status=409)
    if not available(user, organization) or not consent.allow_enrollment:
        raise VoiceprintError("voiceprint_enrollment_denied")
    if consent.generation < revocation_floor(user.pk, organization_id):
        raise VoiceprintError("voiceprint_scope_revoked", status=409)
    profile = (
        models.VoiceprintProfile.objects.select_for_update()
        .filter(consent=consent, feature_space=FEATURE_SPACE)
        .first()
    )
    if profile is None:
        profile = models.VoiceprintProfile(
            consent=consent, feature_space=FEATURE_SPACE, generation=consent.generation
        )
    if (
        profile.generation != consent.generation
        or profile.status == "deleted"
        or not profile.encrypted_key
    ):
        profile.generation = consent.generation
        profile.status = "pending"
        profile.confirmed_at = None
        profile.last_updated_at = None
        profile.template_checked_at = None
        profile.encrypted_key = b""
    if not profile.encrypted_key:
        profile.encrypted_key = load_keyring().create_profile_key(profile)
    profile.save()
    return profile


def deletion_snapshot(job):
    return {
        "id": str(job.pk),
        "status": job.status,
        "revoked_generation": job.revoked_generation,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "error_code": job.error_code or None,
    }


def cancel_pending_work(consent):
    """Changing a permission version invalidates already-issued work permits."""
    now = timezone.now()
    models.VoiceprintEnrollment.objects.filter(
        owner_id=consent.user_id,
        organization_id=consent.organization_id,
        consent_version__lt=consent.version,
        status__in=["open", "closed"],
    ).update(status="canceled", updated_at=now)
    for job_model in (models.VoiceprintEncodingJob, models.VoiceprintQualityJob):
        job_model.objects.filter(
            sample__profile__consent=consent,
            sample__consent_version__lt=consent.version,
            status__in=["queued", "running", "failed"],
        ).update(
            status="canceled",
            lease_token=None,
            lease_until=None,
            retryable=False,
            finished_at=now,
            updated_at=now,
        )


def revoke(
    consent,
    *,
    request_key,
    profile_id=None,
    reason="user_deleted",
    expected_version=None,
):
    """Caller holds subject and consent locks; invalidate before physical cleanup."""
    before = consent.version
    consent.version += 1
    maximum = consent.profiles.aggregate(value=Max("generation"))["value"] or 0
    consent.generation = max(
        consent.generation + 1,
        maximum + 1,
        revocation_floor(consent.user_id, consent.organization_id),
    )
    for name in PERMISSIONS:
        setattr(consent, name, False)
    consent.revoked_at = timezone.now()
    consent.save()
    cancel_pending_work(consent)
    consent.profiles.filter(generation__lt=consent.generation).update(
        status="deleted",
        encrypted_key=b"",
        updated_at=timezone.now(),
    )
    event(consent, "delete" if reason == "user_deleted" else "invalidate")
    return models.VoiceprintDeletionJob.objects.create(
        consent=consent,
        owner_id=consent.user_id,
        organization_id=consent.organization_id,
        profile_id=profile_id,
        request_key=request_key,
        expected_version=before if expected_version is None else expected_version,
        revoked_generation=consent.generation,
        reason=reason,
    )


@transaction.atomic
def delete_profile(actor, *, profile_id, expected_version, request_key):
    user = owner(actor, lock=True)
    previous = models.VoiceprintDeletionJob.objects.filter(
        owner_id=user.pk, request_key=request_key
    ).first()
    if previous:
        if (
            previous.profile_id != profile_id
            or previous.expected_version != expected_version
        ):
            raise VoiceprintError("voiceprint_request_conflict", status=409)
        return previous
    profile = models.VoiceprintProfile.objects.filter(
        pk=profile_id, consent__user=user
    ).first()
    if profile is None:
        raise VoiceprintError("voiceprint_profile_unavailable", status=404)
    consent = models.VoiceprintConsent.objects.select_for_update().get(
        pk=profile.consent_id
    )
    if consent.version != expected_version:
        raise VoiceprintError("voiceprint_settings_changed", status=409)
    return revoke(consent, request_key=request_key, profile_id=profile.pk)


@transaction.atomic
def invalidate_subject(user, organization_id=None, *, all_scopes=False, reason):
    """Internal offboarding/deactivation path; never grants a person's permission."""
    models.User.objects.select_for_update().filter(pk=user.pk).first()
    rows = models.VoiceprintConsent.objects.select_for_update().filter(user=user)
    if not all_scopes:
        rows = rows.filter(organization_id=organization_id)
    for consent in rows.order_by("id"):
        if (
            any(getattr(consent, name) for name in PERMISSIONS)
            or consent.profiles.exclude(status="deleted").exists()
        ):
            revoke(consent, request_key=uuid4(), reason=reason)


@transaction.atomic
def purge_deleted(job_id):
    initial = models.VoiceprintDeletionJob.objects.get(pk=job_id)
    models.User.objects.select_for_update().filter(pk=initial.owner_id).first()
    if initial.consent_id:
        models.VoiceprintConsent.objects.select_for_update().filter(
            pk=initial.consent_id
        ).first()
    job = models.VoiceprintDeletionJob.objects.select_for_update().get(pk=job_id)
    if job.status == "succeeded":
        return job
    profiles = models.VoiceprintProfile.objects.filter(
        consent__user_id=job.owner_id, consent__organization_id=job.organization_id
    )
    samples = models.VoiceprintSample.objects.filter(
        profile__in=profiles, generation__lt=job.revoked_generation
    )
    templates = models.VoiceprintTemplate.objects.filter(
        profile__in=profiles, generation__lt=job.revoked_generation
    )
    sample_count, template_count = samples.count(), templates.count()
    templates.delete()
    samples.delete()
    profiles.filter(generation__lt=job.revoked_generation).update(
        encrypted_key=b"", status="deleted", updated_at=timezone.now()
    )
    job.status = "succeeded"
    job.attempts += 1
    job.receipt = {
        "database": "purged",
        "samples": sample_count,
        "templates": template_count,
        "external_objects": 0,
        "cache": "not_used",
    }
    job.finished_at = timezone.now()
    job.error_code = ""
    job.save()
    return job


@transaction.atomic
def update_organization_policy(actor, organization_id, *, enabled, expected_version):
    user = owner(actor, lock=True)
    organization = (
        models.Organization.objects.select_for_update()
        .filter(pk=organization_id, is_active=True)
        .first()
    )
    if (
        organization is None
        or not models.Membership.objects.filter(
            user=user,
            organization=organization,
            status=models.MembershipStatusChoices.ACTIVE,
            org_role__in=[models.OrgRoleChoices.ADMIN, models.OrgRoleChoices.OWNER],
        ).exists()
    ):
        raise VoiceprintError("voiceprint_organization_admin_required")
    current = organization_policy(organization)
    if current["version"] != expected_version:
        raise VoiceprintError("voiceprint_policy_changed", status=409)
    if current["enabled"] != enabled:
        current = {"enabled": enabled, "version": current["version"] + 1}
        organization.settings = {
            **(
                organization.settings if isinstance(organization.settings, dict) else {}
            ),
            "voiceprint": current,
        }
        organization.save(update_fields=["settings", "updated_at"])
        record_audit(
            actor=user,
            organization=organization,
            action=models.AuditActionChoices.VOICEPRINT_POLICY_CHANGED,
            target_type="organization",
            target_id=organization.pk,
            metadata=current,
        )
    return current
