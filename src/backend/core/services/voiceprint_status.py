"""Owner-only read projection; never promote stored state or grant permission."""

from django.db.models import BooleanField, Case, Q, Value, When
from django.utils import timezone

from core import models
from core.services import voiceprint_consent as consent_service
from core.services.voiceprint_crypto import VoiceprintCryptoError, load_keyring
from core.services.voiceprint_encoder import FEATURE_SPACE
from core.services.voiceprint_enrollment import sample_snapshot

STATES = (
    "not_enabled",
    "collecting",
    "awaiting_confirmation",
    "established",
    "needs_update",
    "paused",
    "deleting",
    "deleted",
)
UPDATE_REASONS = (
    "expired",
    "model_changed",
    "contributions_changed",
    "storage_unavailable",
)


def profile_projection(profile, settings, *, floor, deletion, now):  # noqa: PLR0912 -- Keep the eight display states and validity guards explicit.
    state, reasons, groups = "not_enabled", [], []
    if (
        profile.status == "deleted"
        or profile.generation != settings["generation"]
        or profile.generation < floor
    ):
        state = (
            "deleted"
            if deletion
            and deletion.revoked_generation > profile.generation
            and deletion.status == "succeeded"
            else "deleting"
        )
    elif not settings["available"] or not any(
        settings[name] for name in consent_service.PERMISSIONS
    ):
        state = "paused"
    else:
        established = profile.confirmed_at is not None or profile.status in {
            "active",
            "paused",
        }
        if established:
            if profile.feature_space != FEATURE_SPACE:
                reasons = ["model_changed"]
            elif not profile.encrypted_key:
                reasons = ["storage_unavailable"]
            elif (
                profile.last_updated_at is None
                or profile.last_updated_at <= now - timezone.timedelta(days=365)
            ):
                reasons = ["expired"]
            else:
                try:
                    load_keyring().profile_key(profile)
                except VoiceprintCryptoError:
                    reasons = ["storage_unavailable"]
                else:
                    groups = consent_service.ready_device_groups(profile)
                    if (
                        not groups
                        or profile.status != "active"
                        or profile.confirmed_at is None
                    ):
                        groups = []
                        reasons = ["contributions_changed"]
            state = "needs_update" if reasons else "established"
        else:
            # Read only bounded metadata, never candidate audio or embeddings.
            policy_version = (
                consent_service.organization_policy(profile.consent.organization)[
                    "version"
                ]
                if profile.consent.organization_id
                else 0
            )
            sources = Q(pk__in=[])
            if settings["allow_enrollment"]:
                sources |= Q(
                    source_type="enrollment",
                    enrollment__profile=profile,
                    enrollment__generation=profile.generation,
                    enrollment__consent_version=settings["version"],
                    enrollment__owner_id=profile.consent.user_id,
                    enrollment__organization_id=profile.consent.organization_id,
                    enrollment__policy_version=policy_version,
                    enrollment__status__in=["open", "closed"],
                )
            if settings["allow_accumulation"]:
                sources |= Q(source_type="call")
            samples = profile.samples.filter(
                sources,
                generation=profile.generation,
                consent_version=settings["version"],
                expires_at__gt=now,
            )
            ready = (
                samples.filter(status="ready")
                .select_related("enrollment")
                .annotate(
                    audio_present=Case(
                        When(encrypted_audio=b"", then=Value(False)),
                        default=Value(True),
                        output_field=BooleanField(),
                    ),
                    embedding_present=Case(
                        When(encrypted_embedding=b"", then=Value(False)),
                        default=Value(True),
                        output_field=BooleanField(),
                    ),
                )
                .defer("encrypted_audio", "encrypted_embedding")
                .order_by("created_at", "id")
            )
            if settings["allow_enrollment"] and any(
                sample_snapshot(sample)["confirmable"] for sample in ready[:25]
            ):
                state = "awaiting_confirmation"
            elif (
                samples.filter(
                    status__in=[
                        "pending",
                        "processing",
                        "quality_pending",
                        "ready",
                        "confirmed",
                    ]
                ).exists()
                or profile.enrollments.filter(
                    generation=profile.generation,
                    consent_version=settings["version"],
                    status="open",
                    expires_at__gt=now,
                    owner_id=profile.consent.user_id,
                    organization_id=profile.consent.organization_id,
                    policy_version=policy_version,
                ).exists()
            ) and (settings["allow_enrollment"] or settings["allow_accumulation"]):
                state = "collecting"
    return {
        "display_state": state,
        "update_reasons": reasons,
        "effective_device_groups": groups,
    }


def project_settings(settings, *, consent, profiles, user, organization):
    """Eight display states use current scope and authenticated template evidence."""
    now = timezone.now()
    org_id = organization.pk if organization else None
    floor = consent_service.revocation_floor(user.pk, org_id)
    deletion = (
        models.VoiceprintDeletionJob.objects.filter(
            owner_id=user.pk,
            organization_id=org_id,
        )
        .order_by("-revoked_generation", "-created_at", "id")
        .first()
    )
    profiles = {str(row.pk): row for row in profiles}
    for row in settings["profiles"]:
        profile = profiles[row["id"]]
        profile.consent = consent
        row.update(
            profile_projection(
                profile, settings, floor=floor, deletion=deletion, now=now
            )
        )
    current = [
        row
        for row in settings["profiles"]
        if row["generation"] == settings["generation"]
        and row["display_state"] not in {"deleting", "deleted"}
    ]
    if current:
        priority = (
            "established",
            "awaiting_confirmation",
            "needs_update",
            "collecting",
            "paused",
            "not_enabled",
        )
        settings["display_state"] = next(
            state
            for state in priority
            if any(row["display_state"] == state for row in current)
        )
    elif deletion and deletion.revoked_generation >= settings["generation"]:
        settings["display_state"] = (
            "deleted" if deletion.status == "succeeded" else "deleting"
        )
    elif settings["profiles"]:
        settings["display_state"] = (
            "deleting"
            if any(row["display_state"] == "deleting" for row in settings["profiles"])
            else "deleted"
        )
    else:
        settings["display_state"] = "not_enabled"
