"""Owner-confirmed device templates, anchored to one stable baseline.

Cosine gates are engineering consistency checks, not identity calibration.
Declarations identify microphone conditions, not verified hardware identities.
"""

from uuid import UUID

from django.db.models import F
from django.utils import timezone

from core import models
from core.services import voiceprint_sampling as sampling
from core.services import voiceprint_templates as templates
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_crypto import VoiceprintCryptoError, load_keyring
from core.services.voiceprint_encoder import DIMENSION
from core.services.voiceprint_enrollment import sample_quality_ready
from core.services.voiceprint_vectors import aggregate, cosine, read_sample_vector

POLICY_VERSION = "qwen-owner-device-v2-cos085"
GROUPS = ("default", *sampling.DEVICE_GROUPS)


def is_baseline(template):
    return (
        template.policy_version == templates.POLICY_VERSION
        and template.device_group == "default"
        and template.basis == {}
    ) or (
        template.policy_version == POLICY_VERSION
        and isinstance(template.basis, dict)
        and template.basis.get("role") == "baseline"
    )


def eligible(profile, group, *, identifiers=None, after=None):
    if group == "default":
        return templates.eligible(profile, identifiers=identifiers, after=after)
    if group not in sampling.DEVICE_GROUPS:
        return []
    now = timezone.now()
    rows = (
        profile.samples.filter(
            source_type="call",
            generation=profile.generation,
            status="confirmed",
            confirmed_at__gt=now - timezone.timedelta(days=365),
            confirmed_at__lte=now,
            sampling_permit__device_group=group,
            sampling_permit__status="consumed",
            owner_decision__accepted=True,
            owner_decision__owner_id=profile.consent.user_id,
            owner_decision__generation=profile.generation,
            owner_decision__consent_version=F("consent_version"),
        )
        .select_related("owner_decision", "profile__consent")
        .defer("encrypted_audio")
        .order_by("-confirmed_at", "id")
    )
    if identifiers is not None:
        rows = rows.filter(pk__in=identifiers)
    if after is not None:
        rows = rows.filter(created_at__gt=after)
    selected, digests = [], set()
    for sample in rows[:73]:
        if (
            not sample_quality_ready(sample)
            or len(sample.audio_sha256) != 64
            or any(char not in "0123456789abcdef" for char in sample.audio_sha256)
            or sample.audio_sha256 in digests
            or sample.confirmed_at < sample.created_at
            or sample.confirmed_at > sample.owner_decision.created_at
            or sample.owner_decision.created_at
            > sample.created_at + timezone.timedelta(hours=24)
            or sample.owner_decision.created_at > now
        ):
            continue
        try:
            # Stopping new accumulation never revokes a completed owner decision.
            # Current owner, scope, source, generation and policy still apply.
            sampling.authorized_sample(sample, profile)
        except VoiceprintError:
            continue
        selected.append(sample)
        digests.add(sample.audio_sha256)
        if len(selected) == templates.MAX_SUPPORT_SAMPLES:
            break
    return selected


def sufficient(samples):
    return (
        len(samples) >= 3
        and sum(row.quality["valid_speech_ms"] for row in samples) >= 30000
    )


def confirmed_at(template):
    if template.policy_version == POLICY_VERSION and is_baseline(template):
        return timezone.datetime.fromisoformat(template.basis["confirmed_at"])
    return max(template.support_samples.values_list("confirmed_at", flat=True))


def anchor_basis(anchor):
    return {
        "role": "supplement",
        "baseline_id": str(anchor.pk),
        "baseline_revision": anchor.revision,
        "baseline_support_digest": anchor.support_digest,
        "baseline_confirmed_at": confirmed_at(anchor).isoformat(),
    }


def after_baseline(samples, anchor):
    boundary = confirmed_at(anchor)
    return [row for row in samples if row.created_at > boundary]


def independent_sessions(samples):
    # Prompt registrations are independent sessions too; call IDs are trusted
    # room occurrences, so reconnecting/re-publishing cannot count twice.
    return (
        len(
            {
                (row.source_type, row.source_session_id or row.enrollment_id)
                for row in samples
            }
        )
        >= 2
    )


def valid(template, profile):  # noqa: PLR0911, PLR0912 -- Every proof boundary fails closed.
    if (
        template.policy_version != POLICY_VERSION
        or template.profile_id != profile.pk
        or template.generation != profile.generation
        or template.device_group not in GROUPS
        or template.dimension != DIMENSION
        or template.revision < 1
        or not template.encrypted_vector
        or not isinstance(template.basis, dict)
    ):
        return False
    identifiers = list(template.support_samples.values_list("pk", flat=True)[:13])
    available = {
        row.pk: row
        for row in eligible(profile, template.device_group, identifiers=identifiers)
    }
    if not 3 <= len(identifiers) <= templates.MAX_SUPPORT_SAMPLES or set(
        identifiers
    ) != set(available):
        return False
    samples = [available[pk] for pk in identifiers]
    if not sufficient(samples):
        return False
    if template.basis.get("role") == "baseline":
        if set(template.basis) != {"role", "confirmed_at"}:
            return False
        try:
            boundary = confirmed_at(template)
        except (ValueError, TypeError, KeyError):
            return False
        if (
            timezone.is_naive(boundary)
            or not max(row.confirmed_at for row in samples)
            <= boundary
            <= timezone.now()
        ):
            return False
    elif template.basis.get("role") == "supplement":
        try:
            identifier = UUID(template.basis.get("baseline_id"))
        except (ValueError, TypeError, AttributeError):
            return False
        anchor = profile.templates.filter(
            pk=identifier, generation=profile.generation, status="active"
        ).first()
        if (
            anchor is None
            or anchor.pk == template.pk
            or not is_baseline(anchor)
            or not templates.valid_baseline(anchor, profile)
        ):
            return False
        if (
            template.device_group == anchor.device_group
            or template.basis != anchor_basis(anchor)
            or len(after_baseline(samples, anchor)) != len(samples)
            or not independent_sessions(samples)
        ):
            return False
    else:
        return False
    try:
        if templates.supports_digest(samples) != template.support_digest:
            return False
        templates.read_template(
            template,
            load_keyring().decrypt(
                profile,
                template.encrypted_vector,
                kind="template",
                object_id=template.pk,
            ),
        )
    except (VoiceprintError, VoiceprintCryptoError, ValueError, TypeError):
        return False
    return True


def vectors_for(profile, samples, anchor=None):
    keyring = load_keyring()
    vectors = [
        read_sample_vector(
            row,
            keyring.decrypt(
                profile, row.encrypted_embedding, kind="embedding", object_id=row.pk
            ),
        )
        for row in samples
    ]
    if any(
        cosine(left, right) < templates.MIN_PAIR_COSINE
        for index, left in enumerate(vectors)
        for right in vectors[index + 1 :]
    ):
        raise VoiceprintError("mixed_speaker")
    if anchor is not None:
        baseline = templates.read_template(
            anchor,
            keyring.decrypt(
                profile, anchor.encrypted_vector, kind="template", object_id=anchor.pk
            ),
        )
        if any(
            cosine(vector, baseline) < templates.MIN_PAIR_COSINE for vector in vectors
        ):
            raise VoiceprintError("mixed_speaker")
    return keyring, aggregate(vectors)


def store(profile, rows, group, samples, *, anchor=None):
    keyring, vector = vectors_for(profile, samples, anchor)
    template = next((row for row in rows if row.device_group == group), None)
    created = template is None
    if created:
        template = models.VoiceprintTemplate(
            profile=profile,
            generation=profile.generation,
            device_group=group,
            dimension=DIMENSION,
        )
        rows.append(template)
    else:
        template.revision += 1
    template.status = "active"
    template.dimension = DIMENSION
    template.policy_version = (
        templates.POLICY_VERSION
        if group == "default" and anchor is None and created
        else POLICY_VERSION
    )
    latest = max(row.confirmed_at for row in samples)
    template.basis = (
        {}
        if template.policy_version == templates.POLICY_VERSION
        else (
            anchor_basis(anchor)
            if anchor
            else {
                "role": "baseline",
                "confirmed_at": max(profile.confirmed_at or latest, latest).isoformat(),
            }
        )
    )
    template.support_digest = templates.supports_digest(samples)
    template.encrypted_vector = keyring.encrypt(
        profile,
        templates.template_payload(template, vector),
        kind="template",
        object_id=template.pk,
    )
    template.save()
    template.support_samples.set(samples)
    return template


def pause_template(template):
    if template.status == "active":
        template.status = "paused"
        template.revision += 1
        template.save(update_fields=["status", "revision", "updated_at"])


def failure(error):
    return "mixed_speaker" if str(error) == "mixed_speaker" else "invalid_contributions"


def build(profile, rows):  # noqa: PLR0912 -- Keep baseline preservation and quarantine explicit.
    anchors = [row for row in rows if is_baseline(row)]
    if len(anchors) > 1 or len(rows) > 5:
        return templates.pause(profile, rows, "invalid_contributions")
    anchor = anchors[0] if anchors else None
    changed = None
    rebuilding = anchor is not None and profile.confirmed_at is not None
    if (
        anchor is None
        or anchor.status != "active"
        or not templates.valid_baseline(anchor, profile)
    ):
        templates.pause(profile, rows, "rebuilding")
        if not profile.consent.allow_enrollment and not rebuilding:
            return templates.BuildResult("unavailable")
        groups = (anchor.device_group,) if anchor else GROUPS
        for group in groups:
            if (
                group != "default"
                and not profile.consent.allow_accumulation
                and not rebuilding
            ):
                continue
            samples = eligible(profile, group)
            if not sufficient(samples):
                continue
            try:
                anchor = store(profile, rows, group, samples)
            except (
                VoiceprintError,
                VoiceprintCryptoError,
                ValueError,
                TypeError,
            ) as error:
                return templates.BuildResult(failure(error))
            changed = anchor
            break
        else:
            return templates.BuildResult("insufficient_audio")
    for group in GROUPS:
        if group == anchor.device_group:
            continue
        existing = next((row for row in rows if row.device_group == group), None)
        if (
            existing
            and existing.status == "active"
            and templates.valid_baseline(existing, profile)
        ):
            continue
        if existing:
            pause_template(existing)
        replacing = (
            existing is not None
            and existing.policy_version == POLICY_VERSION
            and isinstance(existing.basis, dict)
            and existing.basis.get("role") == "supplement"
        )
        if not replacing and (
            not profile.consent.allow_enrollment
            or (group != "default" and not profile.consent.allow_accumulation)
        ):
            continue
        samples = eligible(profile, group, after=confirmed_at(anchor))
        if not sufficient(samples) or not independent_sessions(samples):
            continue
        try:
            changed = store(profile, rows, group, samples, anchor=anchor)
        except (VoiceprintError, VoiceprintCryptoError, ValueError, TypeError):
            continue  # Contaminated additions never alter the confirmed baseline.
    for row in rows:
        if (
            row.status == "active"
            and row is not anchor
            and not templates.valid_baseline(row, profile)
        ):
            pause_template(row)
    profile.status = "active"
    if changed or profile.confirmed_at is None:
        profile.confirmed_at = confirmed_at(anchor)
        profile.last_updated_at = timezone.now()
    profile.save(
        update_fields=["status", "confirmed_at", "last_updated_at", "updated_at"]
    )
    selected = changed or anchor
    return templates.BuildResult(
        "built" if changed else "unchanged", selected.pk, selected.revision
    )
