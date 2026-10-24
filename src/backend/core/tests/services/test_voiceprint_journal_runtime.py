"""Real primary PostgreSQL fences with an independent signed-state SQL transport fixture."""

import base64
import copy
import hashlib
import io
import os
from uuid import uuid4

from django.core.management import call_command
from django.db import DatabaseError, connection, transaction

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core import models
from core.factories import MeetingParticipationFactory, UserFactory
from core.services import voiceprint_candidates as candidates
from core.services import voiceprint_consent as consent
from core.services import voiceprint_enrollment as enrollment
from core.services import voiceprint_journal as journal
from core.services import voiceprint_journal_runtime as runtime
from core.services import voiceprint_quality_jobs as quality
from core.services import voiceprint_recovery as recovery
from core.services import voiceprint_sampling as sampling
from core.services.membership import left_transition
from core.services.voiceprint_templates import build
from core.tests.services.test_voiceprint_consent import (
    enabled,
    org_for,
    profile_for,
    sample_for,
)

pytestmark = pytest.mark.django_db(transaction=True)


def offline(settings):
    settings.MEETING_VOICEPRINT_ENABLED = False
    settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = False
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False


def online(settings):
    settings.MEETING_VOICEPRINT_ENABLED = True
    settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = True
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = True
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = True
    settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED = True


class Transport:
    def __init__(self):
        self.head = {"sequence": 0, "digest": journal.ZERO}
        self.record = None
        self.append_count = 0
        self.fail_before_append = self.fail_after_append = self.unavailable = False

    def call(self, _client, statement, parameters):
        if self.unavailable:
            raise journal.JournalError("voiceprint_journal_unavailable")
        if "read_head" in statement:
            return [(self.head["sequence"], self.head["digest"])]
        if "read_current" in statement:
            return [self.record] if self.record else []
        assert "append_record" in statement
        _deployment, sequence, previous, blob, digest = parameters
        if sequence != self.head["sequence"] or previous != self.head["digest"]:
            raise journal.JournalError("voiceprint_journal_conflict")
        if self.fail_before_append:
            raise journal.JournalError("voiceprint_journal_unavailable")
        assert hashlib.sha256(blob).hexdigest() == digest
        self.head = {"sequence": sequence + 1, "digest": digest}
        self.record = (sequence + 1, previous, digest, blob)
        self.append_count += 1
        if self.fail_after_append:
            raise journal.JournalError("voiceprint_journal_unavailable")
        return [(sequence + 1, digest)]


@pytest.fixture
def authority(settings, tmp_path, monkeypatch):
    owner = UserFactory()
    profile = profile_for(owner, identify=True)
    signing = Ed25519PrivateKey.generate()
    private = signing.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    public = signing.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    ca = tmp_path / "ca.pem"
    ca.write_bytes(
        b"fixture only: SQL transport is replaced; real TLS has a separate probe"
    )
    common = {
        "v": 1,
        "deployment_id": str(uuid4()),
        "encryption_key": base64.b64encode(os.urandom(32)).decode(),
    }
    paths = {}
    for role, key, value in (
        ("writer", "signing_key", private),
        ("reader", "verification_key", public),
    ):
        paths[role] = tmp_path / (role + ".json")
        recovery.write_private(
            paths[role],
            {
                **common,
                key: base64.b64encode(value).decode(),
                "database": {
                    "host": "authority.local",
                    "port": 5432,
                    "name": "voiceprint_authority",
                    "user": "voiceprint_journal_" + role,
                    "password": "synthetic only",
                    "ca_file": str(ca),
                },
            },
        )
    transport = Transport()
    monkeypatch.setattr(
        journal.Journal,
        "call",
        lambda self, statement, parameters: transport.call(self, statement, parameters),  # noqa: PLW0108 -- Adapt the bound transport to an unbound Journal method.
    )
    settings.MEETING_VOICEPRINT_JOURNAL_REQUIRED = True
    settings.MEETING_VOICEPRINT_JOURNAL_CONFIG_FILE = str(paths["writer"])
    offline(settings)
    output = io.StringIO()
    call_command(
        "initialize_voiceprint_journal", config=str(paths["writer"]), stdout=output
    )
    assert '"status": "initialized"' in output.getvalue()
    online(settings)
    return owner, profile, transport, paths


def closed(profile):
    assert not runtime.allowed()
    assert not candidates.enabled() and not sampling.enabled() and not quality.enabled()
    assert build(profile.pk).status == "disabled"
    with pytest.raises(
        consent.VoiceprintError, match="voiceprint_authorization_revoked"
    ):
        consent.authorize_profile(profile.pk, permission="allow_enrollment")


def test_prepared_publication_cannot_pair_edited_head_with_old_proofs(authority):
    _owner, _profile, transport, paths = authority
    writer = journal.Journal(journal.load_configuration(paths["writer"], "writer"))
    observed, publish = writer.prepare_publication()
    observed["sequence"] = 999
    observed["digest"] = "f" * 64
    delta = journal.empty()
    delta["floors"] = [
        {"owner": str(uuid4()), "organization": None, "generation": 2, "version": 2}
    ]
    captured = publish(delta)
    assert captured == transport.head and captured["sequence"] == 2
    state = writer.read_current()[1]
    assert len(state["floors"]) == 1 and len(state["permissions"]) == 1
    with pytest.raises(journal.JournalError, match="conflict"):
        publish(delta)


def test_prepared_publication_rejects_newer_external_head_without_replacing_it(
    authority,
):
    _owner, _profile, transport, paths = authority
    writer = journal.Journal(journal.load_configuration(paths["writer"], "writer"))
    observed, publish = writer.prepare_publication()
    first = journal.empty()
    first["floors"] = [
        {"owner": str(uuid4()), "organization": None, "generation": 2, "version": 2}
    ]
    newer = writer.publish(observed, first)
    second = journal.empty()
    second["floors"] = [
        {"owner": str(uuid4()), "organization": None, "generation": 3, "version": 3}
    ]
    with pytest.raises(journal.JournalError, match="conflict"):
        publish(second)
    assert transport.head == newer
    assert writer.read_current()[1]["floors"] == first["floors"]


def test_prepared_noop_does_not_append_but_ephemeral_change_must_append(authority):
    _owner, _profile, transport, paths = authority
    writer = journal.Journal(journal.load_configuration(paths["writer"], "writer"))
    observed, publish = writer.prepare_publication()
    assert publish(journal.empty()) is None
    assert transport.head == observed
    assert publish(journal.empty(), force=True)["sequence"] == observed["sequence"] + 1


def test_paused_microphone_advances_authority_and_restore_requires_new_declaration(
    authority,
    settings,
):
    owner, profile, transport, paths = authority
    participation = MeetingParticipationFactory(user=owner)
    control = models.VoiceprintSamplingControl.objects.create(
        participation=participation,
        shared_microphone=False,
        device_group="headset",
    )
    old = runtime.cursor_of(models.VoiceprintJournalCheckpoint.objects.get())
    with pytest.raises(DatabaseError, match="voiceprint_journal_transaction_required"):
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "UPDATE core_voiceprintsamplingcontrol SET paused=true WHERE id=%s",
                [control.pk],
            )
    # Primary rollback restores the old declaration and mirror, while the
    # independent authority retains the acknowledged pause.
    with pytest.raises(RuntimeError, match="primary rollback"):
        with transaction.atomic():
            control.paused = True
            control.revision += 1
            control.save()
            assert transport.head["sequence"] == old["sequence"] + 1
            raise RuntimeError("primary rollback")
    control.refresh_from_db()
    assert not control.paused
    closed(profile)
    transport.fail_after_append = False
    offline(settings)
    reader = journal.load_configuration(paths["reader"], "reader")
    request = recovery.request_for(reader["deployment_id"])
    bundle = journal.Journal(
        journal.load_configuration(paths["writer"], "writer")
    ).export_recovery(request)
    runtime.restore(reader, request, bundle)
    control.refresh_from_db()
    assert control.paused and control.shared_microphone and control.device_group == ""
    assert control.revision > 1
    online(settings)
    assert runtime.allowed()


@pytest.mark.parametrize(
    "changes", [{"sequence": 2}, {"digest": "f" * 64}, {"deployment_id": uuid4()}]
)
def test_checkpoint_mismatch_closes_all_processing_gates(authority, changes):
    owner, profile, _transport, _paths = authority
    assert runtime.allowed()
    models.VoiceprintJournalCheckpoint.objects.update(**changes)
    closed(profile)
    assert consent.read_settings(owner)["available"] is False


def test_absent_checkpoint_and_unavailable_authority_never_reuse_last_success(
    authority,
):
    _owner, profile, transport, _paths = authority
    assert runtime.allowed()
    transport.unavailable = True
    closed(profile)
    transport.unavailable = False
    assert runtime.allowed()
    models.VoiceprintJournalCheckpoint.objects.all().delete()
    closed(profile)


def test_corrupt_private_configuration_closes_gate_without_private_error(
    authority, settings
):
    _owner, profile, _transport, _paths = authority
    settings.MEETING_VOICEPRINT_JOURNAL_CONFIG_FILE = "absent-private-config"
    closed(profile)


def test_permission_change_publishes_before_primary_ack_and_updates_checkpoint(
    authority,
):
    owner, profile, transport, _paths = authority
    consent.update_settings(
        owner,
        organization_id=None,
        expected_version=1,
        changes={"allow_identification": False},
    )
    row = models.VoiceprintJournalCheckpoint.objects.get()
    assert runtime.cursor_of(row) == transport.head and row.sequence == 2
    _head, state = runtime.client().read_current()
    assert state["permissions"][0]["flags"]["allow_identification"] is False
    profile.consent.refresh_from_db()
    assert profile.consent.version == 2 and not profile.consent.allow_identification
    assert runtime.allowed()


def test_publication_failure_rolls_back_primary_without_ack(authority):
    owner, profile, transport, _paths = authority
    transport.fail_before_append = True
    with pytest.raises(consent.VoiceprintError, match="publication_unavailable"):
        consent.update_settings(
            owner,
            organization_id=None,
            expected_version=1,
            changes={"allow_identification": False},
        )
    profile.consent.refresh_from_db()
    assert profile.consent.version == 1 and profile.consent.allow_identification
    assert (
        transport.head["sequence"]
        == models.VoiceprintJournalCheckpoint.objects.get().sequence
        == 1
    )


def test_lost_append_ack_closes_gate_until_signed_offline_restore(authority, settings):
    owner, profile, transport, paths = authority
    transport.fail_after_append = True
    with pytest.raises(consent.VoiceprintError, match="publication_unavailable"):
        consent.update_settings(
            owner,
            organization_id=None,
            expected_version=1,
            changes={"allow_identification": False},
        )
    assert transport.head["sequence"] == 2
    assert models.VoiceprintJournalCheckpoint.objects.get().sequence == 1
    closed(profile)
    transport.fail_after_append = False
    offline(settings)
    request_path, bundle_path, receipt = (
        paths["reader"].parent / name
        for name in ("request.json", "bundle.json", "receipt.json")
    )
    call_command(
        "request_voiceprint_journal_recovery",
        config=str(paths["reader"]),
        output=str(request_path),
        stdout=io.StringIO(),
    )
    call_command(
        "export_voiceprint_journal_recovery",
        config=str(paths["writer"]),
        request=str(request_path),
        output=str(bundle_path),
        stdout=io.StringIO(),
    )
    call_command(
        "restore_voiceprint_journal_recovery",
        config=str(paths["reader"]),
        request=str(request_path),
        bundle=str(bundle_path),
        receipt=str(receipt),
        stdout=io.StringIO(),
    )
    assert recovery.read_private(receipt)["sequence"] == 2
    assert (
        runtime.cursor_of(models.VoiceprintJournalCheckpoint.objects.get())
        == transport.head
    )
    profile.consent.refresh_from_db()
    assert not profile.consent.allow_identification and profile.consent.version > 2
    online(settings)
    assert runtime.allowed()
    consent.update_settings(
        owner,
        organization_id=None,
        expected_version=profile.consent.version,
        changes={"allow_identification": True},
    )
    offline(settings)
    reader = journal.load_configuration(paths["reader"], "reader")
    with pytest.raises(consent.VoiceprintError, match="recovery_stale"):
        runtime.restore(
            reader,
            recovery.read_private(request_path),
            recovery.read_private(bundle_path),
        )
    profile.consent.refresh_from_db()
    assert (
        profile.consent.allow_identification
    )  # A stale packet cannot undo the later explicit grant.


def test_outer_primary_rollback_leaves_durable_external_head_ahead(authority):
    owner, profile, transport, _paths = authority
    with pytest.raises(RuntimeError, match="simulate_primary_failure"):
        with transaction.atomic():
            consent.update_settings(
                owner,
                organization_id=None,
                expected_version=1,
                changes={"allow_identification": False},
            )
            assert transport.head["sequence"] == 2
            raise RuntimeError("simulate_primary_failure")
    profile.consent.refresh_from_db()
    assert profile.consent.allow_identification
    assert models.VoiceprintJournalCheckpoint.objects.get().sequence == 1
    closed(profile)


def test_nested_mutations_publish_once_and_identical_state_does_not_grow_log(authority):
    owner, _profile, transport, _paths = authority
    with runtime.mutation():
        consent.update_settings(
            owner,
            organization_id=None,
            expected_version=1,
            changes={"allow_identification": False},
        )
        consent.update_settings(
            owner,
            organization_id=None,
            expected_version=2,
            changes={"allow_accumulation": True},
        )
    assert transport.append_count == 2  # Baseline + one combined transaction.
    with runtime.mutation():
        pass
    assert transport.append_count == 2


def test_unwrapped_bulk_permission_and_offboarding_are_rejected_but_display_edit_works(
    authority,
):
    owner, profile, transport, _paths = authority
    for statement, identifier in (
        (
            "UPDATE core_voiceprintconsent SET allow_identification=false WHERE id=%s",
            profile.consent_id,
        ),
        ("UPDATE meet_user SET is_active=false WHERE id=%s", owner.pk),
    ):
        with (
            pytest.raises(
                DatabaseError, match="voiceprint_journal_transaction_required"
            ),
            transaction.atomic(),
        ):
            with connection.cursor() as cursor:
                cursor.execute(statement, (identifier,))
    models.User.objects.filter(pk=owner.pk).update(full_name="Synthetic display edit")
    assert transport.append_count == 1 and runtime.allowed()


@pytest.mark.parametrize("mode", ["update", "bulk_update"])
def test_guarded_bulk_offboarding_publishes_floors_and_permissions(authority, mode):
    owner, profile, transport, _paths = authority
    if mode == "update":
        models.User.objects.filter(pk=owner.pk).update(is_active=False)
    else:
        owner.is_active = False
        models.User.objects.bulk_update([owner], ["is_active"])
    profile.consent.refresh_from_db()
    assert not profile.consent.allow_enrollment and profile.consent.generation == 2
    _head, state = runtime.client().read_current()
    assert state["floors"][0]["generation"] == 2
    assert transport.head["sequence"] == 2 and runtime.allowed()


@pytest.mark.parametrize("mode", ["save", "update", "delete"])
def test_membership_offboarding_keeps_personal_scope_and_publishes_org_revoke(
    authority, mode
):
    owner, personal, transport, _paths = authority
    organization, member = org_for(owner)
    profile = profile_for(owner, organization, identify=True)
    if mode == "save":
        member.status = models.MembershipStatusChoices.LEFT
        with left_transition():
            member.save(update_fields=["status"])
    elif mode == "update":
        models.Membership.objects.filter(pk=member.pk).update(
            status=models.MembershipStatusChoices.LEFT
        )
    else:
        models.Membership.objects.filter(pk=member.pk).delete()
    profile.consent.refresh_from_db()
    personal.consent.refresh_from_db()
    assert profile.consent.generation == 2 and not profile.consent.allow_identification
    assert personal.consent.generation == 1 and personal.consent.allow_identification
    _head, state = runtime.client().read_current()
    assert state["floors"][0]["organization"] == str(organization.pk)
    assert transport.head["sequence"] == 3 and runtime.allowed()


@pytest.mark.parametrize("mode", ["save", "update"])
def test_organization_deactivation_advances_policy_and_revokes_org_scope(
    authority, mode
):
    owner, personal, transport, _paths = authority
    organization, _member = org_for(owner)
    profile = profile_for(owner, organization, identify=True)
    if mode == "save":
        organization.is_active = False
        organization.save(update_fields=["is_active"])
    else:
        models.Organization.objects.filter(pk=organization.pk).update(is_active=False)
    profile.consent.refresh_from_db()
    personal.consent.refresh_from_db()
    assert not profile.consent.allow_enrollment and personal.consent.allow_enrollment
    _head, state = runtime.client().read_current()
    assert state["organizations"] == [
        {"id": str(organization.pk), "enabled": False, "version": 2}
    ]
    assert transport.head["sequence"] == 3 and runtime.allowed()


def test_model_offboarding_signal_is_in_same_published_transaction(authority):
    owner, profile, transport, _paths = authority
    owner.is_active = False
    owner.save(update_fields=["is_active"])
    assert transport.head["sequence"] == 2
    _head, state = runtime.client().read_current()
    assert state["floors"][0]["generation"] == 2
    assert not any(state["permissions"][0]["flags"].values())
    profile.consent.refresh_from_db()
    assert profile.consent.generation == 2 and not profile.consent.allow_enrollment


def test_sample_rejection_is_durable_and_terminal_rows_cannot_resurrect(authority):
    owner, profile, _transport, _paths = authority
    sample = sample_for(profile)
    enrollment.decide(owner, sample.pk, expected_version=1, accepted=False)
    _head, state = runtime.client().read_current()
    assert state["contributions"][0]["sample_uuid"] == str(sample.pk)
    with (
        pytest.raises(DatabaseError, match="voiceprint_journal_terminal_sample"),
        transaction.atomic(),
    ):
        models.VoiceprintSample.objects.filter(pk=sample.pk).update(status="confirmed")


def test_immutable_proofs_cannot_be_changed_or_deleted_even_inside_protocol(authority):
    owner, profile, _transport, _paths = authority
    consent.delete_profile(
        owner, profile_id=profile.pk, expected_version=1, request_key=uuid4()
    )
    job = models.VoiceprintDeletionJob.objects.get(owner_id=owner.pk)
    for action in (
        lambda: models.VoiceprintDeletionJob.objects.filter(pk=job.pk).update(
            revoked_generation=1
        ),
        lambda: models.VoiceprintDeletionJob.objects.filter(pk=job.pk).delete(),
    ):
        with (
            pytest.raises(DatabaseError, match="voiceprint_journal_immutable_proof"),
            runtime.mutation(),
        ):
            action()
    job.status = "succeeded"
    job.save(update_fields=["status"])
    assert runtime.allowed()


def test_wrong_or_changed_recovery_head_rolls_back_all_primary_replay(
    authority, settings, monkeypatch
):
    owner, profile, transport, paths = authority
    with pytest.raises(RuntimeError), transaction.atomic():
        consent.update_settings(
            owner,
            organization_id=None,
            expected_version=1,
            changes={"allow_identification": False},
        )
        raise RuntimeError("primary rollback")
    offline(settings)
    request = recovery.request_for(runtime.client().configuration["deployment_id"])
    bundle = runtime.client().export_recovery(request)
    reader = journal.load_configuration(paths["reader"], "reader")
    tampered = copy.deepcopy(bundle)
    tampered["head"]["sequence"] += 1
    with pytest.raises(journal.JournalError, match="authentication_failed"):
        runtime.restore(reader, request, tampered)
    apply = recovery.apply_rows

    def changed(value):
        result = apply(value)
        delta = journal.empty()
        delta["floors"] = [
            {
                "owner": str(owner.pk),
                "organization": None,
                "generation": 2,
                "version": 2,
            }
        ]
        runtime.client().publish(transport.head, delta)
        return result

    monkeypatch.setattr(recovery, "apply_rows", changed)
    with pytest.raises(consent.VoiceprintError, match="recovery_stale"):
        runtime.restore(reader, request, bundle)
    profile.consent.refresh_from_db()
    assert profile.consent.allow_identification and profile.consent.version == 1
    assert models.VoiceprintJournalCheckpoint.objects.get().sequence == 1


def test_existing_or_nonzero_authority_cannot_be_reinitialized(authority, settings):
    _owner, _profile, transport, paths = authority
    offline(settings)
    with pytest.raises(consent.VoiceprintError, match="already_initialized"):
        runtime.initialize(paths["writer"])
    models.VoiceprintJournalCheckpoint.objects.all().delete()
    with pytest.raises(consent.VoiceprintError, match="recovery_required"):
        runtime.initialize(paths["writer"])
    assert transport.append_count == 1


def test_bulk_key_loss_records_scope_floor_instead_of_silent_checkpoint_ack(authority):
    owner, profile, transport, _paths = authority
    models.VoiceprintProfile.objects.filter(pk=profile.pk).update(encrypted_key=b"")
    _head, state = runtime.client().read_current()
    assert state["floors"] == [
        {"owner": str(owner.pk), "organization": None, "generation": 2, "version": 1}
    ]
    profile.consent.refresh_from_db()
    assert not profile.consent.allow_identification and profile.consent.generation == 2
    assert transport.head["sequence"] == 2


def test_durable_scope_erasure_keeps_working_during_authority_outage(authority):
    owner, profile, transport, _paths = authority
    sample = sample_for(profile)
    job = consent.delete_profile(
        owner, profile_id=profile.pk, expected_version=1, request_key=uuid4()
    )
    transport.unavailable = True
    result = consent.purge_deleted(job.pk)
    assert result.status == "succeeded"
    assert not models.VoiceprintSample.objects.filter(pk=sample.pk).exists()
    profile.refresh_from_db()
    assert not profile.encrypted_key
    assert not runtime.allowed()


def test_terminal_sample_has_persistent_real_dependency_proof_before_deletion(
    authority,
):
    _owner, profile, transport, _paths = authority
    sample = sample_for(profile)
    models.VoiceprintSample.objects.filter(pk=sample.pk).update(status="expired")
    proof = models.VoiceprintContributionRemoval.objects.get(sample_uuid=sample.pk)
    assert proof.templates == {"all": False, "permit_id": None, "rows": []}
    transport.unavailable = True
    models.VoiceprintSample.objects.filter(pk=sample.pk).delete()
    assert models.VoiceprintContributionRemoval.objects.filter(pk=proof.pk).exists()


def test_bulk_membership_reassignment_revokes_previous_scope(authority):
    owner, personal, _transport, _paths = authority
    organization, membership = org_for(owner)
    profile = profile_for(owner, organization, identify=True)
    other = UserFactory()
    models.Membership.objects.filter(pk=membership.pk).update(user=other)
    profile.consent.refresh_from_db()
    personal.consent.refresh_from_db()
    assert not profile.consent.allow_enrollment and profile.consent.generation == 2
    assert personal.consent.allow_enrollment and runtime.allowed()
