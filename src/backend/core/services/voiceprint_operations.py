"""Organization-admin operational aggregates; never load biometric payloads."""

from datetime import timedelta

from django.db.models import (
    Aggregate,
    BigIntegerField,
    Case,
    CharField,
    Count,
    DurationField,
    F,
    Func,
    Min,
    Q,
    Sum,
    Value,
    When,
)
from django.db.models.fields.json import KeyTextTransform, KeyTransform
from django.db.models.functions import Cast, Coalesce
from django.utils import timezone

from core import models
from core.services import voiceprint_consent as consent

JOB_STATES = ("queued", "running", "succeeded", "failed", "canceled", "expired")
RESULTS = (
    "suggested",
    "unknown",
    "ambiguous",
    "insufficient_audio",
    "mixed_speaker",
    "unavailable",
)
REASONS = (
    "multiple_speakers",
    "quality_not_verified",
    "independent_clips_required",
    "speech_required",
    "query_inconsistent",
    "calibration_required",
    "no_authorized_templates",
    "conflicting_identities",
    "below_acceptance",
    "margin_required",
    "consistent_identity",
)


class Percentile95(Aggregate):
    template = "PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY %(expressions)s)"
    output_field = DurationField()


def authorize(actor, organization_id):
    user = consent.owner(actor)
    organization = models.Organization.objects.filter(
        pk=organization_id, is_active=True
    ).first()
    if (
        organization is None
        or not models.Membership.objects.filter(
            user=user,
            organization=organization,
            status=models.MembershipStatusChoices.ACTIVE,
            org_role__in=(models.OrgRoleChoices.ADMIN, models.OrgRoleChoices.OWNER),
        ).exists()
    ):
        raise consent.VoiceprintError("voiceprint_organization_admin_required")
    return user, organization


def states(rows, values, field="status"):
    result = rows.aggregate(
        **{value: Count("pk", filter=Q(**{field: value})) for value in values},
        total=Count("pk"),
    )
    total = result.pop("total")
    result["other"] = total - sum(result.values())
    return result


def queue(rows, *, now, since, leased=True):
    pending = rows.filter(status__in=("queued", "running"))
    oldest = pending.aggregate(value=Min("created_at"))["value"]
    completed = rows.filter(
        status__in=("succeeded", "failed", "canceled", "expired"),
        finished_at__gte=since,
        finished_at__lte=now,
    ).filter(finished_at__gte=F("created_at"))
    summary = completed.aggregate(
        count=Count("pk"),
        p95=Percentile95(F("finished_at") - F("created_at")),
    )
    return {
        "states": states(rows, JOB_STATES),
        "oldest_pending_seconds": max(0, (now - oldest).total_seconds())
        if oldest
        else None,
        "expired_running_leases": rows.filter(
            Q(lease_until__lte=now) | Q(lease_until__isnull=True),
            status="running",
        ).count()
        if leased
        else None,
        "completed_in_window": summary["count"],
        "request_to_finish_p95_seconds": summary["p95"].total_seconds()
        if summary["p95"] is not None
        else None,
    }


def sample_summary(rows):
    # CASE protects the cast even for damaged legacy JSON. This is declared
    # quality metadata, not a new speech/identity validation of the audio.
    rows = rows.annotate(
        speech_type=Func(
            KeyTransform("valid_speech_ms", "quality"),
            function="jsonb_typeof",
            output_field=CharField(),
        ),
        speech_text=KeyTextTransform("valid_speech_ms", "quality"),
    ).annotate(
        speech_ms=Case(
            When(
                speech_type="number",
                speech_text__regex=r"^[0-9]{4,5}$",
                then=Cast("speech_text", BigIntegerField()),
            ),
            default=Value(0),
            output_field=BigIntegerField(),
        ),
    )
    valid = Q(
        speech_ms__gte=3000,
        speech_ms__lte=10000,
        quality__speech_checked=True,
        quality__speaker_consistency_checked=True,
        quality__speaker_count=1,
    ) & Q(speech_ms__lte=F("end_ms") - F("start_ms"))
    return rows.aggregate(
        count=Count("pk"),
        submitted_audio_ms=Coalesce(
            Sum(F("end_ms") - F("start_ms")), Value(0), output_field=BigIntegerField()
        ),
        declared_quality_speech_ms=Coalesce(
            Sum(
                Case(
                    When(valid, then=F("speech_ms")),
                    default=Value(0),
                    output_field=BigIntegerField(),
                )
            ),
            Value(0),
            output_field=BigIntegerField(),
        ),
        owner_accepted=Count("pk", filter=Q(owner_decision__accepted=True)),
        owner_rejected=Count("pk", filter=Q(owner_decision__accepted=False)),
    )


def report(actor, *, organization_id, hours=24):
    if type(hours) is not int or not 1 <= hours <= 168:
        raise consent.VoiceprintError(
            "voiceprint_operations_window_invalid", status=400
        )
    user, organization = authorize(actor, organization_id)
    now = timezone.now()
    since = now - timedelta(hours=hours)
    profiles = models.VoiceprintProfile.objects.filter(
        consent__organization=organization
    )
    samples = models.VoiceprintSample.objects.filter(
        profile__consent__organization=organization
    )
    recent_samples = samples.filter(created_at__gte=since, created_at__lte=now)
    identity = models.SpeakerIdentityJob.objects.filter(organization=organization)
    all_suggestions = models.SpeakerIdentitySuggestion.objects.filter(
        job__organization=organization
    )
    suggestions = all_suggestions.filter(
        created_at__gte=since,
        created_at__lte=now,
    )
    result = {
        "schema_version": 1,
        "observed_at": now.isoformat(),
        "window_hours": hours,
        "policy": consent.organization_policy(organization),
        "queues": {
            "encoding": queue(
                models.VoiceprintEncodingJob.objects.filter(
                    sample__profile__consent__organization=organization
                ),
                now=now,
                since=since,
            ),
            "quality": queue(
                models.VoiceprintQualityJob.objects.filter(
                    sample__profile__consent__organization=organization
                ),
                now=now,
                since=since,
            ),
            "identification": queue(identity, now=now, since=since),
            "deletion": queue(
                models.VoiceprintDeletionJob.objects.filter(
                    organization_id=organization.pk
                ),
                now=now,
                since=since,
                leased=False,
            ),
        },
        "profiles": states(profiles, ("pending", "active", "paused", "deleted")),
        "templates": states(
            models.VoiceprintTemplate.objects.filter(
                profile__consent__organization=organization
            ),
            ("active", "paused", "deleted"),
        ),
        "samples": states(
            samples,
            (
                "pending",
                "processing",
                "ready",
                "confirmed",
                "rejected",
                "expired",
                "deleted",
            ),
        ),
        "expired_candidates": samples.filter(
            status__in=("pending", "processing", "ready"), expires_at__lte=now
        ).count(),
        "samples_in_window": sample_summary(recent_samples),
        "contribution_cleanup": states(
            models.VoiceprintContributionRemoval.objects.filter(
                organization_uuid=organization.pk
            ),
            ("queued", "purged", "complete"),
        ),
        "suggestions_in_window": {
            "results": states(suggestions, RESULTS, "result"),
            "reasons": states(suggestions, REASONS, "reason"),
            "decisions": states(
                suggestions,
                ("pending", "confirmed", "rejected", "invalidated"),
                "state",
            ),
            "human_rejected_suggestions": all_suggestions.filter(
                result="suggested",
                state="rejected",
                decided_at__gte=since,
                decided_at__lte=now,
            ).count(),
        },
    }
    # Fail closed when a long aggregation races with offboarding or role loss.
    user, organization = authorize(actor, organization_id)
    result["policy"] = consent.organization_policy(organization)
    result["available"] = consent.available(user, organization)
    return result
