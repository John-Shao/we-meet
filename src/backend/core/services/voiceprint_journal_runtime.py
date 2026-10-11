"""Fresh authority gate and pre-commit primary/authority publication protocol."""

# ruff: noqa: PLC0415 -- Runtime imports avoid consent/recovery/model cycles.

from contextlib import contextmanager, nullcontext
from contextvars import ContextVar

from django.conf import settings
from django.db import connection, transaction
from django.db.models import Exists, F, OuterRef, Q

from core import models

ACTIVE = ContextVar("voiceprint_journal_mutation", default=False)
LOCK = 7836610902711
FIELDS = {
    "voiceprintconsent": (
        "user_id",
        "organization_id",
        "version",
        "generation",
        "allow_enrollment",
        "allow_accumulation",
        "allow_identification",
    ),
    "voiceprintdeletionjob": (
        "owner_id",
        "organization_id",
        "expected_version",
        "revoked_generation",
    ),
    "voiceprintsourceremoval": (
        "kind",
        "source_uuid",
        "source_session_id",
        "track_digest",
    ),
    "voiceprintcontributionremoval": (
        "sample_uuid",
        "profile_uuid",
        "owner_uuid",
        "organization_uuid",
        "generation",
        "templates",
    ),
    "voiceprintsample": ("status",),
    "voiceprintsamplingcontrol": (
        "participation_id",
        "revision",
        "paused",
        "shared_microphone",
        "device_group",
    ),
    "voiceprintprofile": ("generation", "status", "encrypted_key"),
    "user": ("is_active", "is_device"),
    "membership": ("user_id", "organization_id", "status"),
    "organization": ("is_active", "settings"),
    "meetingrecord": ("deleted_at",),
}


def save_context(instance, update_fields):  # noqa: PLR0911, PLR0912 -- Explicit guards keep unrelated writes outside the authority protocol.
    """Protect Model.save including offboarding signals; ordinary fields stay usable."""
    name = instance._meta.model_name  # noqa: SLF001 -- Django's documented model metadata API.
    fields = FIELDS.get(name)
    if not fields or ACTIVE.get() or not required():
        return nullcontext()
    if update_fields is not None and not set(fields).intersection(
        set(update_fields) | {field + "_id" for field in update_fields}
    ):
        return nullcontext()
    if not models.VoiceprintJournalCheckpoint.objects.exists():
        return nullcontext()  # The runtime gate remains closed until offline bootstrap.
    previous = type(instance).objects.filter(pk=instance.pk).values(*fields).first()
    if previous is not None and all(
        previous[key] == getattr(instance, key) for key in fields
    ):
        return nullcontext()
    if (
        name == "user"
        and not models.VoiceprintConsent.objects.filter(user_id=instance.pk).exists()
    ):
        return nullcontext()
    if name == "organization":
        if not models.VoiceprintConsent.objects.filter(
            organization_id=instance.pk
        ).exists():
            return nullcontext()
        if previous and previous["is_active"] == instance.is_active:
            before = (
                previous["settings"] if isinstance(previous["settings"], dict) else {}
            )
            after = instance.settings if isinstance(instance.settings, dict) else {}
            if before.get("voiceprint") == after.get("voiceprint"):
                return nullcontext()
    if name == "membership":
        scopes = Q(user_id=instance.user_id, organization_id=instance.organization_id)
        if previous:
            scopes |= Q(
                user_id=previous["user_id"], organization_id=previous["organization_id"]
            )
        if not models.VoiceprintConsent.objects.filter(scopes).exists():
            return nullcontext()
    if name == "voiceprintsample" and instance.status not in {
        "rejected",
        "expired",
        "deleted",
    }:
        return (
            nullcontext()
        )  # The database separately rejects terminal-row resurrection.
    if name == "voiceprintprofile" and (
        previous is None
        or (
            previous["generation"] == instance.generation
            and instance.status != "deleted"
            and (not previous["encrypted_key"] or instance.encrypted_key)
        )
    ):
        return nullcontext()
    if name == "meetingrecord" and instance.deleted_at is None:
        return nullcontext()
    return mutation()


def delete_context(instance):
    if (
        ACTIVE.get()
        or not required()
        or instance._meta.model_name  # noqa: SLF001 -- Django's documented model metadata API.
        not in (set(FIELDS) | {"meetingsession", "voiceprintsamplingtrack"})
        or not models.VoiceprintJournalCheckpoint.objects.exists()
    ):
        return nullcontext()
    if instance._meta.model_name == "voiceprintsample" and (  # noqa: SLF001
        instance.status in {"rejected", "expired", "deleted"}
        or models.VoiceprintContributionRemoval.objects.filter(
            sample_uuid=instance.pk
        ).exists()
        or not models.VoiceprintProfile.objects.filter(pk=instance.profile_id)
        .exclude(encrypted_key=b"")
        .exists()
    ):
        return nullcontext()
    if instance._meta.model_name == "voiceprintprofile" and (  # noqa: SLF001
        instance.status == "deleted" or not instance.encrypted_key
    ):
        return nullcontext()
    return mutation()


def required():
    return settings.MEETING_VOICEPRINT_JOURNAL_REQUIRED or bool(
        settings.MEETING_VOICEPRINT_JOURNAL_CONFIG_FILE
    )


def client(role="writer", path=None):
    from core.services import (
        voiceprint_journal as journal,
    )

    return journal.Journal(
        journal.load_configuration(
            path or settings.MEETING_VOICEPRINT_JOURNAL_CONFIG_FILE, role
        )
    )


def fail(code):
    from core.services.voiceprint_consent import VoiceprintError

    raise VoiceprintError("voiceprint_journal_" + code, status=503)


def cursor_of(row):
    return {"sequence": row.sequence, "digest": row.digest}


def matching(row, authority, observed):
    return (
        row is not None
        and str(row.deployment_id) == authority.configuration["deployment_id"]
        and cursor_of(row) == observed
    )


def allowed():
    """No cache: stale, absent, unavailable or unauthenticated state closes voiceprints."""
    if not required():
        return True  # Test configuration only; runtime settings cannot disable this.
    try:
        row = models.VoiceprintJournalCheckpoint.objects.filter(pk=1).first()
        if row is None:
            return False
        authority = client()
        return matching(row, authority, authority.read_head())
    except Exception:  # noqa: BLE001 -- Fixed closed gate, no private configuration/SQL diagnostics.
        return False


def lock():
    if connection.vendor != "postgresql" or not connection.in_atomic_block:
        fail("transaction_required")
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout = '3s'")
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK,))


def normalize_unavailable():
    """Bulk/offboarding paths cannot retain an old positive consent/version."""
    from core.services import voiceprint_consent as consent
    from core.services import voiceprint_lifecycle as lifecycle
    from core.services import voiceprint_recovery as recovery

    members = models.Membership.objects.filter(
        user_id=OuterRef("user_id"),
        organization_id=OuterRef("organization_id"),
        status=models.MembershipStatusChoices.ACTIVE,
    )
    scopes = recovery.rows(
        models.VoiceprintConsent.objects.annotate(member_active=Exists(members))
        .filter(
            Q(user__is_active=False)
            | Q(user__is_device=True)
            | Q(organization__is_active=False)
            | Q(organization__isnull=False, member_active=False)
        )
        .select_related("user", "organization")
        .order_by("user_id", "organization_id")
    )
    organizations = set()
    for row in scopes:
        if (
            row.organization is not None
            and not row.organization.is_active
            and row.organization_id not in organizations
        ):
            organizations.add(row.organization_id)
            lifecycle.organization_changed(models.Organization, row.organization)
        consent.invalidate_subject(
            row.user, row.organization_id, reason="subject_unavailable"
        )


def retain_terminal_proofs():
    from core.services import voiceprint_recovery as recovery
    from core.services import voiceprint_source_removal as removal

    proof = models.VoiceprintContributionRemoval.objects.filter(
        sample_uuid=OuterRef("pk")
    )
    rows = (
        models.VoiceprintSample.objects.filter(
            status__in=["rejected", "expired", "deleted"]
        )
        .annotate(journal_proof=Exists(proof))
        .filter(journal_proof=False)
        .order_by("pk")
    )
    recovery.require(
        rows[: recovery.MAX_ROWS + 1].count() <= recovery.MAX_ROWS, "budget_exceeded"
    )
    removal.enroll(rows, dispatch=False)


def retain_source_and_profile_fences():
    from uuid import uuid4

    from core.services import voiceprint_consent as consent
    from core.services import voiceprint_recovery as recovery
    from core.services import voiceprint_source_removal as removal

    source = models.VoiceprintSourceRemoval.objects.filter(
        kind="record", source_uuid=OuterRef("pk")
    )
    records = (
        models.MeetingRecord.objects.filter(deleted_at__isnull=False)
        .annotate(journal_proof=Exists(source))
        .filter(journal_proof=False)
        .only("id", "source_type", "source_session_id", "deleted_at")
        .order_by("pk")
    )
    for row in recovery.rows(records):
        removal.remove_source("record", row, dispatch=False)
    floor = models.VoiceprintDeletionJob.objects.filter(
        owner_id=OuterRef("consent__user_id"),
        revoked_generation__gt=OuterRef("generation"),
    )
    # SQL equality with NULL does not match a personal scope.
    profiles = (
        models.VoiceprintProfile.objects.filter(
            Q(status="deleted") | Q(encrypted_key=b"")
        )
        .annotate(
            journal_personal=Exists(floor.filter(organization_id=None)),
            journal_organization=Exists(
                floor.filter(organization_id=OuterRef("consent__organization_id"))
            ),
        )
        .filter(
            Q(consent__organization_id=None, journal_personal=False)
            | Q(consent__organization_id__isnull=False, journal_organization=False)
        )
        .values(
            "consent_id", "consent__user_id", "consent__organization_id", "generation"
        )
        .order_by("pk")
    )
    for row in recovery.rows(profiles):
        if (
            consent.revocation_floor(
                row["consent__user_id"], row["consent__organization_id"]
            )
            > row["generation"]
        ):
            continue
        models.User.objects.select_for_update().filter(
            pk=row["consent__user_id"]
        ).first()
        scope = models.VoiceprintConsent.objects.select_for_update().get(
            pk=row["consent_id"]
        )
        consent.revoke(scope, request_key=uuid4(), reason="profile_unavailable")


def checkpoint(authority, captured):
    models.VoiceprintJournalCheckpoint.objects.update_or_create(
        pk=1,
        defaults={
            "deployment_id": authority.configuration["deployment_id"],
            **captured,
        },
    )


@contextmanager
def marked():
    token = ACTIVE.set(True)
    with connection.cursor() as cursor:
        cursor.execute("SELECT set_config('we_meet.voiceprint_mutation', '1', true)")
        cursor.execute(
            "SELECT set_config('we_meet.voiceprint_control_dirty', '', true)"
        )
    try:
        yield
    finally:
        ACTIVE.reset(token)
        # A failed savepoint may already have marked the transaction for rollback.
        if not connection.needs_rollback:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT set_config('we_meet.voiceprint_mutation', '', true)"
                )


@contextmanager
def mutation():
    """Serialize before owner locks; publish externally before committing primary SQL."""
    from core.services import voiceprint_journal as journal
    from core.services import voiceprint_recovery as recovery

    with transaction.atomic():
        if ACTIVE.get() or not required():
            yield
            return
        lock()
        row = models.VoiceprintJournalCheckpoint.objects.filter(pk=1).first()
        if row is None:
            if any(
                getattr(settings, key)
                for key in (
                    "MEETING_VOICEPRINT_ENABLED",
                    "MEETING_VOICEPRINT_SAMPLING_ENABLED",
                    "MEETING_VOICEPRINT_MATCHING_ENABLED",
                )
            ):
                fail("not_initialized")
            # Before first offline bootstrap no checkpoint can reopen voiceprints.
            yield
            return
        try:
            authority = client()
            captured, publish = authority.prepare_publication()
            if not matching(row, authority, captured):
                fail("recovery_required")
            with marked():
                yield
                normalize_unavailable()
                retain_source_and_profile_fences()
                retain_terminal_proofs()
                state = recovery.capture_current()
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT current_setting('we_meet.voiceprint_control_dirty', true)"
                    )
                    control_changed = cursor.fetchone()[0] == "1"
                following_head = publish(state, force=control_changed)
                if following_head is not None:
                    checkpoint(authority, following_head)
        except (journal.JournalError, recovery.RecoveryError):
            fail("publication_unavailable")


def initialize(path):
    from core.services import voiceprint_journal as journal
    from core.services import voiceprint_recovery as recovery

    recovery.offline()
    authority = client(path=path)
    with transaction.atomic():
        lock()
        if models.VoiceprintJournalCheckpoint.objects.exists():
            fail("already_initialized")
        initial = {"sequence": 0, "digest": journal.ZERO}
        if authority.read_head() != initial:
            fail("recovery_required")
        with marked():
            normalize_unavailable()
            retain_source_and_profile_fences()
            retain_terminal_proofs()
            captured = authority.publish(initial, recovery.capture_current())
            checkpoint(authority, captured)
    return {
        "status": "initialized",
        "sequence": captured["sequence"],
        "voiceprint_enabled": False,
    }


def restore(config, request, bundle):
    from core.services import voiceprint_journal as journal
    from core.services import voiceprint_recovery as recovery

    recovery.offline()
    captured, value = journal.verify_export(config, request, bundle)
    authority = journal.Journal(config)
    with transaction.atomic():
        lock()
        row = models.VoiceprintJournalCheckpoint.objects.filter(pk=1).first()
        if row is not None and str(row.deployment_id) != config["deployment_id"]:
            fail("wrong_deployment")
        if authority.read_head() != captured:
            fail("recovery_stale")
        with marked():
            result = recovery.apply_rows(value)
            # Connection declarations are deliberately ephemeral: an old database
            # cannot restore permission to collect audio from a live microphone.
            models.VoiceprintSamplingControl.objects.update(
                revision=F("revision") + 1,
                paused=True,
                shared_microphone=True,
                device_group="",
                stop_reason="recovery_required",
            )
            models.VoiceprintSamplingPermit.objects.filter(status="issued").update(
                status="canceled"
            )
            # Check again after primary replay; a newer external revocation wins.
            if authority.read_head() != captured:
                fail("recovery_stale")
            checkpoint(authority, captured)
    return {
        "status": "replayed",
        "sequence": captured["sequence"],
        "voiceprint_enabled": False,
        **result,
    }
