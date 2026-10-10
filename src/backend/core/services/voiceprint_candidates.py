"""Explicit, authorized and versioned candidate pools for internal matching.

This service grants template access, not media access. Query producers must
separately enforce media retention, diarization and the job's source generation.
No pool or query vector is written to a cache, log or public response here.
"""

import hashlib
import json
from dataclasses import dataclass, field
from uuid import UUID

from django.conf import settings
from django.db.models import F, Max
from django.utils import timezone

from core import models
from core.services import voiceprint_consent as consent
from core.services import voiceprint_matching as matching
from core.services.speaker_attribution import authorize
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_crypto import VoiceprintCryptoError, load_keyring
from core.services.voiceprint_encoder import FEATURE_SPACE
from core.services.voiceprint_templates import read_template


@dataclass(frozen=True)
class CandidatePool:
    record_id: UUID = field(repr=False)
    actor_id: UUID = field(repr=False)
    organization_id: UUID | None = field(repr=False)
    requested: tuple = field(repr=False)
    candidates: tuple = field(repr=False)
    record_revision: int
    fingerprint: str
    authorization_digest: str = ""


@dataclass(frozen=True)
class AuthorizedMatch:
    result: matching.MatchResult
    candidate_digest: str
    threshold_digest: str
    threshold_version: str
    record_revision: int


def enabled():
    return (
        settings.MEETING_VOICEPRINT_ENABLED
        and settings.MEETING_VOICEPRINT_MATCHING_ENABLED
    )


def explicit_ids(values):
    if (
        not isinstance(values, (list, tuple))
        or not 1 <= len(values) <= matching.MAX_CANDIDATES
    ):
        raise VoiceprintError("voiceprint_candidates_invalid", status=400)
    try:
        identifiers = tuple(
            value if isinstance(value, UUID) else UUID(value)
            for value in values
            if isinstance(value, (str, UUID))
        )
    except (ValueError, AttributeError, TypeError):
        raise VoiceprintError("voiceprint_candidates_invalid", status=400) from None
    if len(set(identifiers)) != len(values):
        raise VoiceprintError("voiceprint_candidates_invalid", status=400)
    return tuple(sorted(identifiers, key=str))


def explicit_scope(value):
    if value is None or isinstance(value, UUID):
        return value
    try:
        if not isinstance(value, str):
            raise ValueError
        return UUID(value)
    except (ValueError, AttributeError, TypeError):
        raise VoiceprintError("voiceprint_candidate_scope_unavailable") from None


def scope(record_id, actor_id, organization_id, identifiers, expected_revision):
    if not enabled():
        raise VoiceprintError("voiceprint_matching_disabled")
    actor = consent.owner(models.User(pk=actor_id))
    record = models.MeetingRecord.objects.filter(
        pk=record_id, deleted_at__isnull=True
    ).first()
    if record is None:
        raise VoiceprintError("voiceprint_record_unavailable", status=404)
    authorize(record, actor)
    if type(expected_revision) is not int or expected_revision < 1:
        raise VoiceprintError("voiceprint_revision_invalid", status=400)
    if record.revision != expected_revision:
        raise VoiceprintError("voiceprint_record_changed", status=409)
    if record.organization_id and record.organization_id != organization_id:
        raise VoiceprintError("voiceprint_candidate_scope_unavailable")
    organization = None
    if organization_id is not None:
        organization = models.Organization.objects.filter(pk=organization_id).first()
        if organization is None or not consent.available(actor, organization):
            raise VoiceprintError("voiceprint_candidate_scope_unavailable")
        members = set(
            models.Membership.objects.filter(
                organization=organization,
                user_id__in=identifiers,
                user__is_active=True,
                user__is_device=False,
                status=models.MembershipStatusChoices.ACTIVE,
            ).values_list("user_id", flat=True)
        )
        if members != set(identifiers):
            raise VoiceprintError("voiceprint_candidate_scope_unavailable")
    elif identifiers != (actor.pk,):
        raise VoiceprintError("voiceprint_candidate_scope_unavailable")
    return actor, record, organization


def artifact(profile, *, user_id, organization_id):
    profile = consent.authorize_profile(
        profile.pk,
        permission="allow_identification",
        expected_scope=(user_id, organization_id),
    )
    templates = list(
        profile.templates.filter(
            status="active", generation=profile.generation
        ).order_by("device_group", "id")[: matching.MAX_DEVICE_GROUPS + 1]
    )
    if not 1 <= len(templates) <= matching.MAX_DEVICE_GROUPS:
        raise VoiceprintError("voiceprint_profile_not_ready")
    keyring = load_keyring()
    vectors = tuple(
        read_template(
            template,
            keyring.decrypt(
                profile,
                template.encrypted_vector,
                kind="template",
                object_id=template.pk,
            ),
        )
        for template in templates
    )
    candidate = matching.Candidate(profile.consent.user_id, vectors)
    proof = {
        "user": str(profile.consent.user_id),
        "profile": str(profile.pk),
        "version": profile.consent.version,
        "generation": profile.generation,
        "space": profile.feature_space,
        "confirmed": profile.confirmed_at.isoformat(),
        "updated": profile.last_updated_at.isoformat(),
        "templates": [
            {
                "id": str(template.pk),
                "revision": template.revision,
                "device": template.device_group,
                "policy": template.policy_version,
                "supports": template.support_digest,
                "cipher": hashlib.sha256(bytes(template.encrypted_vector)).hexdigest(),
            }
            for template in templates
        ],
    }
    return candidate, proof


def authorization_digest(identifiers, organization_id):
    """Only current permission/profile/template metadata; no plaintext decryption.

    Full contribution proofs are still validated at claim and publication. This
    fast gate stops revoked in-flight work without loading audio or features.
    """
    permissions = list(
        models.VoiceprintConsent.objects.filter(
            user_id__in=identifiers, organization_id=organization_id
        )
        .order_by("user_id")
        .values("id", "user_id", "version", "generation", "allow_identification")
    )
    profiles = list(
        models.VoiceprintProfile.objects.filter(
            consent__user_id__in=identifiers,
            consent__organization_id=organization_id,
            feature_space=FEATURE_SPACE,
        )
        .order_by("id")
        .values(
            "id",
            "consent_id",
            "status",
            "generation",
            "confirmed_at",
            "last_updated_at",
        )
    )
    templates = list(
        models.VoiceprintTemplate.objects.filter(
            profile_id__in=[row["id"] for row in profiles],
            status="active",
            generation=F("profile__generation"),
        )
        .order_by("id")
        .values(
            "id",
            "profile_id",
            "status",
            "generation",
            "revision",
            "policy_version",
            "support_digest",
        )[: matching.MAX_CANDIDATES * matching.MAX_DEVICE_GROUPS + 1]
    )
    floors = list(
        models.VoiceprintDeletionJob.objects.filter(
            owner_id__in=identifiers, organization_id=organization_id
        )
        .values("owner_id")
        .annotate(generation=Max("revoked_generation"))
        .order_by("owner_id")
    )
    for profile in profiles:
        profile["fresh"] = bool(
            profile["last_updated_at"]
            and profile["last_updated_at"]
            > timezone.now() - timezone.timedelta(days=365)
        )
    organization = (
        models.Organization.objects.filter(pk=organization_id).first()
        if organization_id
        else None
    )
    return hashlib.sha256(
        json.dumps(
            {
                "permissions": permissions,
                "profiles": profiles,
                "templates": templates,
                "floors": floors,
                "organization_policy": consent.organization_policy(organization)
                if organization
                else None,
            },
            sort_keys=True,
            separators=(",", ":"),
            default=str,
            allow_nan=False,
        ).encode("ascii")
    ).hexdigest()


def authorized(pool):
    if not isinstance(pool, CandidatePool) or not pool.authorization_digest:
        return False
    try:
        scope(
            pool.record_id,
            pool.actor_id,
            pool.organization_id,
            pool.requested,
            pool.record_revision,
        )
        return (
            authorization_digest(pool.requested, pool.organization_id)
            == pool.authorization_digest
        )
    except (VoiceprintError, PermissionError):
        return False


def load_pool(record, actor, *, organization_id, user_ids, expected_revision):
    organization_id = explicit_scope(organization_id)
    identifiers = explicit_ids(user_ids)
    actor, record, organization = scope(
        record.pk, actor.pk, organization_id, identifiers, expected_revision
    )
    gate = authorization_digest(identifiers, organization_id)
    profiles = {
        profile.consent.user_id: profile
        for profile in models.VoiceprintProfile.objects.filter(
            consent__user_id__in=identifiers,
            consent__organization=organization,
            feature_space=FEATURE_SPACE,
        )
        .select_related("consent")
        .defer("encrypted_key")
    }
    permissions = {
        row.pop("user_id"): row
        for row in models.VoiceprintConsent.objects.filter(
            user_id__in=identifiers, organization=organization
        ).values("user_id", "version", "generation", "allow_identification")
    }
    candidates, proofs = [], []
    for identifier in identifiers:
        profile = profiles.get(identifier)
        if profile is not None:
            try:
                candidate, proof = artifact(
                    profile,
                    user_id=identifier,
                    organization_id=organization.pk if organization else None,
                )
            except VoiceprintCryptoError:
                raise VoiceprintError(
                    "voiceprint_templates_unavailable", status=503
                ) from None
            except VoiceprintError:
                if profile.status == "active" and profile.consent.allow_identification:
                    # Corruption/failed decryption of an active competitor must
                    # never create an artificial single-candidate margin.
                    raise VoiceprintError(
                        "voiceprint_templates_unavailable", status=503
                    ) from None
                pass  # One unavailable explicit member never broadens the pool.
            else:
                candidates.append(candidate)
                proofs.append(proof)
                continue
        proofs.append(
            {
                "user": str(identifier),
                "available": False,
                "permission": permissions.get(identifier),
            }
        )
    context = {
        "record": str(record.pk),
        "revision": record.revision,
        "lifecycle_revision": record.lifecycle_revision,
        "record_organization": str(record.organization_id),
        "source_type": record.source_type,
        "actor": str(actor.pk),
        "organization": str(organization.pk) if organization else None,
        "organization_policy": consent.organization_policy(organization)
        if organization
        else None,
        "candidates": proofs,
    }
    fingerprint = hashlib.sha256(
        json.dumps(
            context, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("ascii")
    ).hexdigest()
    if authorization_digest(identifiers, organization_id) != gate:
        raise VoiceprintError("voiceprint_matching_context_changed", status=409)
    return CandidatePool(
        record.pk,
        actor.pk,
        organization_id,
        identifiers,
        tuple(candidates),
        record.revision,
        fingerprint,
        gate,
    )


def revalidate(pool):
    """Re-read scope and artifacts; stale plaintext in memory never proves access."""
    if not isinstance(pool, CandidatePool):
        return False
    try:
        current = load_pool(
            models.MeetingRecord(pk=pool.record_id),
            models.User(pk=pool.actor_id),
            organization_id=pool.organization_id,
            user_ids=pool.requested,
            expected_revision=pool.record_revision,
        )
    except (VoiceprintError, PermissionError):
        return False
    return current.fingerprint == pool.fingerprint


def match_record(  # noqa: PLR0913 -- Explicit record, actor, source and selected scope.
    record, actor, clips, *, organization_id, user_ids, expected_revision
):
    """Internal entry point. Job publication/confirmation must recheck again."""
    if not enabled():
        raise VoiceprintError("voiceprint_matching_disabled")
    path = settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE
    policy = matching.load_policy(path)
    identifiers = explicit_ids(user_ids)
    if len(identifiers) > policy.max_candidates:
        raise VoiceprintError("voiceprint_candidates_invalid", status=400)
    pool = load_pool(
        record,
        actor,
        organization_id=organization_id,
        user_ids=identifiers,
        expected_revision=expected_revision,
    )
    result = matching.match(clips, pool.candidates, policy=policy)
    try:
        same_policy = matching.load_policy(path).digest == policy.digest
    except VoiceprintError:
        same_policy = False
    if not same_policy or not revalidate(pool):
        raise VoiceprintError("voiceprint_matching_context_changed", status=409)
    return AuthorizedMatch(
        result,
        pool.fingerprint,
        policy.digest,
        policy.threshold_version,
        pool.record_revision,
    )
