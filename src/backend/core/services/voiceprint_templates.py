"""Bounded encrypted enrollment baselines built only from the owner's decisions.

Initial consistency thresholds are engineering defaults, not calibrated identity
thresholds. Matching remains subject to its separate calibration/release gate.
"""

import hashlib
import json
import struct
from dataclasses import dataclass

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from core import models
from core.services import voiceprint_consent as consent
from core.services.voiceprint_crypto import VoiceprintCryptoError, load_keyring
from core.services.voiceprint_encoder import DIMENSION, FEATURE_SPACE
from core.services.voiceprint_enrollment import sample_quality_ready
from core.services.voiceprint_vectors import (
    aggregate,
    cosine,
    decode_vector,
    read_sample_vector,
    sample_prefix,
)

POLICY_VERSION = "qwen-enrollment-baseline-v1-cos085"
MIN_PAIR_COSINE = 0.85
MAX_SUPPORT_SAMPLES = 12


@dataclass(frozen=True)
class BuildResult:
    status: str
    template_id: object = None
    revision: int = 0


def supports_digest(samples):
    rows = [
        {
            "id": str(sample.pk),
            "generation": sample.generation,
            "version": sample.consent_version,
            "audio": sample.audio_sha256,
            "embedding": hashlib.sha256(bytes(sample.encrypted_embedding)).hexdigest(),
            "source_proof": hashlib.sha256(sample_prefix(sample)).hexdigest(),
            "quality": sample.quality,
            "source": str(sample.enrollment_id),
            "slot": sample.enrollment_slot,
            "confirmed": sample.confirmed_at.isoformat(),
            "decision": str(sample.owner_decision.pk),
            "decision_at": sample.owner_decision.created_at.isoformat(),
        }
        for sample in sorted(samples, key=lambda row: str(row.pk))
    ]
    return hashlib.sha256(
        json.dumps(
            rows, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def eligible(profile, *, identifiers=None):
    # Call contributions need the trusted sampling-permit contract; they are not
    # admitted by this enrollment builder merely because their status was edited.
    rows = (
        profile.samples.filter(
            generation=profile.generation,
            status="confirmed",
            confirmed_at__isnull=False,
            confirmed_at__gt=timezone.now() - timezone.timedelta(days=365),
            confirmed_at__lte=timezone.now(),
            source_type="enrollment",
            enrollment__isnull=False,
            enrollment__owner_id=profile.consent.user_id,
            enrollment__generation=profile.generation,
            enrollment__profile=profile,
            owner_decision__accepted=True,
            owner_decision__owner_id=profile.consent.user_id,
            owner_decision__generation=profile.generation,
            owner_decision__consent_version=F("consent_version"),
        )
        .select_related("enrollment", "owner_decision")
        .defer("encrypted_audio")
        .order_by("-confirmed_at", "id")
    )
    if identifiers is not None:
        rows = rows.filter(pk__in=identifiers)
    # Bound old-data work as well as the number of contributions. A subsequent
    # enrollment can supply six new clips without accepting unbounded history.
    selected, digests = [], set()
    for sample in rows[:73]:
        if (
            not sample_quality_ready(sample)
            or sample.audio_sha256 in digests
            or len(sample.audio_sha256) != 64
            or any(char not in "0123456789abcdef" for char in sample.audio_sha256)
            or sample.permit_id != sample.enrollment_id
            or sample.enrollment_slot not in range(6)
            or sample.confirmed_at < sample.created_at
            or sample.confirmed_at > sample.owner_decision.created_at
            or sample.owner_decision.created_at
            > sample.created_at + timezone.timedelta(hours=24)
            or sample.owner_decision.created_at > timezone.now()
            or sample.enrollment.organization_id != profile.consent.organization_id
            or sample.enrollment.consent_version != sample.consent_version
        ):
            continue
        selected.append(sample)
        # A later permission change can cancel unfinished registration uploads.
        # The completed owner's decision remains valid; identification has its
        # own consent flag and scope/generation revocation checks.
        digests.add(sample.audio_sha256)
        if len(selected) == MAX_SUPPORT_SAMPLES:
            break
    return selected


def pause(profile, templates, status):
    for template in templates:
        if template.status == "active":
            template.status = "paused"
            template.revision += 1
            template.save(update_fields=["status", "revision", "updated_at"])
    if profile.status == "active":
        profile.status = "paused"
        profile.save(update_fields=["status", "updated_at"])
    return BuildResult(status)


@transaction.atomic
def build(identifier):  # noqa: PLR0911, PLR0912 -- Keep authorization and contribution rejection guards explicit.
    if (
        not settings.MEETING_VOICEPRINT_ENABLED
        or not settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED
    ):
        return BuildResult("disabled")
    initial = (
        models.VoiceprintProfile.objects.filter(pk=identifier)
        .values("consent_id", "consent__user_id", "consent__organization_id")
        .first()
    )
    if initial is None:
        return BuildResult("unavailable")
    user = (
        models.User.objects.select_for_update(skip_locked=True)
        .filter(pk=initial["consent__user_id"])
        .first()
    )
    if user is None:
        return BuildResult("unavailable")
    org_id = initial["consent__organization_id"]
    organization = (
        models.Organization.objects.select_for_update(skip_locked=True)
        .filter(pk=org_id)
        .first()
        if org_id
        else None
    )
    if org_id and organization is None:
        return BuildResult("unavailable")
    permission = (
        models.VoiceprintConsent.objects.select_for_update(skip_locked=True)
        .filter(pk=initial["consent_id"], user=user, organization=organization)
        .first()
    )
    profile = (
        models.VoiceprintProfile.objects.select_for_update(skip_locked=True)
        .filter(pk=identifier, consent=permission)
        .first()
        if permission
        else None
    )
    if profile is None:
        return BuildResult("unavailable")
    profile.consent = permission
    profile.template_checked_at = timezone.now()
    profile.save(update_fields=["template_checked_at"])
    templates = list(
        profile.templates.select_for_update().filter(generation=profile.generation)
    )
    if (
        not consent.available(user, organization)
        or permission.generation != profile.generation
        or profile.generation < consent.revocation_floor(user.pk, org_id)
        or profile.feature_space != FEATURE_SPACE
        or not profile.encrypted_key
        or profile.status == "deleted"
    ):
        return pause(profile, templates, "unavailable")
    # Keep a valid existing baseline stable; new confirmations do not silently
    # roll it forward. Invalid contributions require rebuilding from survivors.
    active = [row for row in templates if row.status == "active"]
    if active:
        if len(active) == 1 and valid_baseline(active[0], profile):
            return BuildResult("unchanged", active[0].pk, active[0].revision)
        pause(profile, templates, "rebuilding")
    if not permission.allow_enrollment:
        return pause(profile, templates, "unavailable")
    samples = eligible(profile)
    if (
        len(samples) < 3
        or sum(sample.quality["valid_speech_ms"] for sample in samples) < 30000
    ):
        return pause(profile, templates, "insufficient_audio")
    try:
        keyring = load_keyring()
        vectors = [
            read_sample_vector(
                sample,
                keyring.decrypt(
                    profile,
                    sample.encrypted_embedding,
                    kind="embedding",
                    object_id=sample.pk,
                ),
            )
            for sample in samples
        ]
        if any(
            cosine(left, right) < MIN_PAIR_COSINE
            for i, left in enumerate(vectors)
            for right in vectors[i + 1 :]
        ):
            return pause(profile, templates, "mixed_speaker")
        vector = aggregate(vectors)
        digest = supports_digest(samples)
    except (consent.VoiceprintError, VoiceprintCryptoError, ValueError, TypeError):
        return pause(profile, templates, "invalid_contributions")
    template = next((row for row in templates if row.device_group == "default"), None)
    if template is None:
        template = models.VoiceprintTemplate(
            profile=profile, generation=profile.generation, dimension=DIMENSION
        )
    else:
        template.revision += 1
    template.status = "active"
    template.dimension = DIMENSION
    template.policy_version = POLICY_VERSION
    template.support_digest = digest
    template.encrypted_vector = keyring.encrypt(
        profile,
        template_payload(template, vector),
        kind="template",
        object_id=template.pk,
    )
    template.save()
    template.support_samples.set(samples)
    profile.status = "active"
    profile.confirmed_at = max(sample.confirmed_at for sample in samples)
    profile.last_updated_at = timezone.now()
    profile.save(
        update_fields=["status", "confirmed_at", "last_updated_at", "updated_at"]
    )
    return BuildResult("built", template.pk, template.revision)


def valid_baseline(template, profile):
    if (
        template.policy_version != POLICY_VERSION
        or template.profile_id != profile.pk
        or template.dimension != DIMENSION
        or not template.encrypted_vector
        or template.generation != profile.generation
        or template.device_group != "default"
        or template.revision < 1
    ):
        return False
    identifiers = list(template.support_samples.values_list("pk", flat=True)[:13])
    available = {
        sample.pk: sample for sample in eligible(profile, identifiers=identifiers)
    }
    if not 3 <= len(identifiers) <= MAX_SUPPORT_SAMPLES or any(
        pk not in available for pk in identifiers
    ):
        return False
    samples = [available[pk] for pk in identifiers]
    if sum(sample.quality["valid_speech_ms"] for sample in samples) < 30000:
        return False
    try:
        if supports_digest(samples) != template.support_digest:
            return False
        read_template(
            template,
            load_keyring().decrypt(
                profile,
                template.encrypted_vector,
                kind="template",
                object_id=template.pk,
            ),
        )
    except (consent.VoiceprintError, VoiceprintCryptoError, ValueError, TypeError):
        return False
    return True


def template_prefix(template):
    header = json.dumps(
        {
            "revision": template.revision,
            "policy": template.policy_version,
            "supports": template.support_digest,
            "generation": template.generation,
            "space": template.profile.feature_space,
            "dimension": template.dimension,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")
    return b"VPT1" + len(header).to_bytes(2, "little") + header


def template_payload(template, vector):
    return template_prefix(template) + struct.pack(f"<{DIMENSION}f", *vector)


def read_template(template, clear):
    prefix = template_prefix(template)
    if not isinstance(clear, bytes) or not clear.startswith(prefix):
        raise consent.VoiceprintError("voiceprint_template_invalid")
    return decode_vector(clear[len(prefix) :])
