"""Cryptographic state/cursor invariants; real TLS/CAS/roles have a Linux probe."""

import base64
import copy
import hashlib
import json
import os
from unittest.mock import MagicMock
from uuid import uuid4

from django.db import connection

import psycopg
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core.services import voiceprint_consent as consent
from core.services import voiceprint_journal as service
from core.services import voiceprint_recovery as recovery


@pytest.fixture
def keys():
    key = Ed25519PrivateKey.generate()
    common = {"deployment_id": str(uuid4()), "encryption_key": os.urandom(32)}
    public = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    reader = {**common, "verification_key": public}
    writer = {
        **reader,
        "signing_key": key.private_bytes(
            serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw,
            serialization.NoEncryption(),
        ),
    }
    return writer, reader


@pytest.fixture
def state():
    owner = str(uuid4())
    value = service.empty()
    value["floors"] = [
        {"owner": owner, "organization": None, "generation": 2, "version": 3}
    ]
    value["permissions"] = [
        {
            "owner": owner,
            "organization": None,
            "generation": 2,
            "version": 4,
            "flags": dict.fromkeys(consent.PERMISSIONS, False),
        }
    ]
    value["sources"] = [
        {
            "kind": "track",
            "uuid": str(uuid4()),
            "session": None,
            "digest": os.urandom(32).hex(),
        }
    ]
    value["contributions"] = [
        {
            "sample_uuid": str(uuid4()),
            "profile_uuid": str(uuid4()),
            "owner_uuid": owner,
            "organization_uuid": None,
            "generation": 1,
            "templates": {"all": False, "permit_id": None, "rows": []},
        }
    ]
    value["organizations"] = [{"id": str(uuid4()), "enabled": False, "version": 2}]
    return value


def test_authenticated_state_is_encrypted_and_separate_from_recovery_domain(
    keys, state
):
    writer, reader = keys
    blob = service.seal(writer, {"sequence": 0, "digest": service.ZERO}, state)
    digest = hashlib.sha256(blob).hexdigest()
    assert service.open_record(reader, 1, service.ZERO, digest, blob) == state
    assert state["permissions"][0]["owner"].encode() not in blob
    assert b"encrypted_audio" not in blob and b"encrypted_key" not in blob
    request = recovery.request_for(reader["deployment_id"])
    with pytest.raises(recovery.RecoveryError, match="authentication_failed"):
        recovery.verified_snapshot(reader, request, recovery.parse(blob))


@pytest.mark.parametrize(
    "damage",
    ["ciphertext", "signature", "key", "deployment", "digest", "sequence", "previous"],
)
def test_bad_record_is_rejected(keys, state, damage):
    writer, reader = keys
    reader = copy.deepcopy(reader)
    blob = service.seal(writer, {"sequence": 0, "digest": service.ZERO}, state)
    digest, sequence, previous = hashlib.sha256(blob).hexdigest(), 1, service.ZERO
    if damage in {"ciphertext", "signature"}:
        envelope = recovery.parse(blob)
        field = "encrypted" if damage == "ciphertext" else "signature"
        raw = bytearray(base64.b64decode(envelope[field]))
        raw[-1] ^= 1
        envelope[field] = base64.b64encode(raw).decode()
        blob = recovery.canonical(envelope)
        digest = hashlib.sha256(blob).hexdigest()
    elif damage == "key":
        reader["encryption_key"] = os.urandom(32)
    elif damage == "deployment":
        reader["deployment_id"] = str(uuid4())
    elif damage == "digest":
        digest = os.urandom(32).hex()
    elif damage == "sequence":
        sequence = 2
    else:
        previous = os.urandom(32).hex()
    with pytest.raises((service.JournalError, recovery.RecoveryError)):
        service.open_record(reader, sequence, previous, digest, blob)


def test_merge_preserves_all_deletion_proofs_and_latest_explicit_flags(state):
    delta = service.empty()
    row = copy.deepcopy(state["permissions"][0])
    row["version"] += 1
    row["flags"]["allow_identification"] = True
    delta["permissions"] = [row]
    delta["floors"] = [{**state["floors"][0], "generation": 3, "version": 1}]
    before = copy.deepcopy(state)
    updated = service.merge(state, delta)
    assert state == before  # No mutable caller state is aliased into a journal record.
    assert updated["permissions"] == [row]
    assert updated["floors"][0]["generation"] == 3
    assert updated["floors"][0]["version"] == 3
    assert updated["sources"] == state["sources"]
    assert updated["contributions"] == state["contributions"]
    assert service.merge(updated, delta) == updated


@pytest.mark.parametrize(
    "damage",
    [
        "permission_version",
        "permission_generation",
        "equal_version_flags",
        "policy_version",
        "equal_policy_flags",
        "source",
        "contribution",
    ],
)
def test_delta_cannot_rewrite_proofs_or_regress_current_versions(state, damage):
    delta = service.empty()
    name = (
        "permissions"
        if damage.startswith("permission") or damage == "equal_version_flags"
        else "organizations"
    )
    if damage == "source":
        name = "sources"
    elif damage == "contribution":
        name = "contributions"
    row = copy.deepcopy(state[name][0])
    if damage.endswith("version"):
        row["version"] -= 1
    elif damage == "permission_generation":
        row["generation"] = 1
    elif damage == "equal_version_flags":
        row["flags"]["allow_enrollment"] = True
    elif damage == "equal_policy_flags":
        row["enabled"] = True
    elif damage == "source":
        row["digest"] = os.urandom(32).hex()
    else:
        row["profile_uuid"] = str(uuid4())
    delta[name] = [row]
    with pytest.raises(service.JournalError):
        service.merge(state, delta)


def test_reader_cannot_publish_or_sign_export(keys):
    _writer, reader = keys
    instance = service.Journal(reader)
    for operation in (
        lambda: instance.publish(
            {"sequence": 0, "digest": service.ZERO}, service.empty()
        ),
        lambda: instance.export_recovery(recovery.request_for(reader["deployment_id"])),
    ):
        with pytest.raises(service.JournalError, match="writer_required"):
            operation()


def test_authority_export_needs_no_primary_database_and_binds_head(
    keys, state, settings, monkeypatch
):
    writer, reader = keys
    for name in (
        "MEETING_VOICEPRINT_ENABLED",
        "MEETING_VOICEPRINT_SAMPLING_ENABLED",
        "MEETING_VOICEPRINT_MATCHING_ENABLED",
    ):
        setattr(settings, name, False)
    instance = service.Journal(writer)
    captured = {"sequence": 3, "digest": os.urandom(32).hex()}
    monkeypatch.setattr(instance, "read_current", lambda: (captured, state))
    monkeypatch.setattr(instance, "read_head", lambda: captured)
    request = recovery.request_for(reader["deployment_id"])
    monkeypatch.setattr(
        connection,
        "ensure_connection",
        lambda: pytest.fail("Authority export must not connect to the primary DB"),
    )
    exported = instance.export_recovery(request)
    observed, data = service.verify_export(reader, request, exported)
    assert observed == captured
    assert {key: data[key] for key in service.TABLES} == state
    broken = copy.deepcopy(exported)
    broken["head"]["sequence"] += 1
    with pytest.raises(service.JournalError, match="authentication_failed"):
        service.verify_export(reader, request, broken)
    monkeypatch.setattr(instance, "read_head", lambda: {**captured, "sequence": 4})
    with pytest.raises(service.JournalError, match="conflict"):
        instance.export_recovery(request)


def test_stale_cursor_is_rejected_before_publish_sql(keys, state, monkeypatch):
    writer, _reader = keys
    instance = service.Journal(writer)
    current = {"sequence": 2, "digest": os.urandom(32).hex()}
    monkeypatch.setattr(instance, "read_current", lambda: (current, state))
    monkeypatch.setattr(
        instance,
        "call",
        lambda *_args: pytest.fail("Stale source must not call append SQL"),
    )
    with pytest.raises(service.JournalError, match="conflict"):
        instance.publish(
            {"sequence": 1, "digest": os.urandom(32).hex()}, service.empty()
        )


def test_transport_always_uses_verified_tls_and_fixed_timeouts(keys, monkeypatch):
    writer, _reader = keys
    writer["database"] = {
        "host": "authority",
        "port": 5432,
        "name": "journal",
        "user": "voiceprint_journal_writer",
        "password": "private-fixture",
        "ca_file": "/fixture/ca.crt",
    }
    connect = MagicMock()
    connect.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value.fetchall.return_value = [
        (1, "0" * 64)
    ]
    monkeypatch.setattr(service.psycopg, "connect", connect)
    service.Journal(writer).read_head()
    kwargs = connect.call_args.kwargs
    assert (
        kwargs["sslmode"] == "verify-full"
        and kwargs["sslrootcert"] == "/fixture/ca.crt"
    )
    assert kwargs["connect_timeout"] == 3 and kwargs["autocommit"] is True
    assert "statement_timeout=3000" in kwargs["options"]
    for error in (
        psycopg.OperationalError("private password body"),
        psycopg.errors.SerializationFailure("private SQL body"),
    ):
        connect.side_effect = error
        with pytest.raises(service.JournalError) as failure:
            service.Journal(writer).read_head()
        assert "private" not in str(failure.value)


@pytest.mark.parametrize(
    "damage",
    [
        "reader_private_key",
        "unknown_database_option",
        "unsafe_host",
        "unsafe_user",
        "boolean_port",
        "symlink_ca",
        "relative_ca",
    ],
)
def test_private_configuration_is_exact_and_cannot_downgrade_tls(
    keys, tmp_path, damage
):
    writer, reader = keys
    ca = tmp_path / "ca.crt"
    ca.write_bytes(b"fixture certificate checked by libpq during TLS")
    value = {
        "v": 1,
        "deployment_id": reader["deployment_id"],
        "verification_key": base64.b64encode(reader["verification_key"]).decode(),
        "encryption_key": base64.b64encode(reader["encryption_key"]).decode(),
        "database": {
            "host": "authority",
            "port": 5432,
            "name": "journal",
            "user": "voiceprint_journal_reader",
            "password": "private-fixture",
            "ca_file": str(ca),
        },
    }
    if damage == "reader_private_key":
        value["signing_key"] = base64.b64encode(writer["signing_key"]).decode()
    elif damage == "unknown_database_option":
        value["database"]["sslmode"] = "disable"
    elif damage == "unsafe_host":
        value["database"]["host"] = "host dbname=another"
    elif damage == "unsafe_user":
        value["database"]["user"] = "operator"
    elif damage == "boolean_port":
        value["database"]["port"] = True
    elif damage == "relative_ca":
        value["database"]["ca_file"] = "ca.crt"
    else:
        if os.name == "nt":
            pytest.skip("Windows symlink privileges are not a certificate invariant")
        link = tmp_path / "link.crt"
        link.symlink_to(ca)
        value["database"]["ca_file"] = str(link)
    path = tmp_path / "reader.json"
    recovery.write_private(path, value)
    with pytest.raises((service.JournalError, recovery.RecoveryError)):
        service.load_configuration(path, "reader")


def test_current_record_cannot_exceed_private_payload_budget(keys, monkeypatch):
    writer, _reader = keys
    monkeypatch.setattr(recovery, "MAX_CLEAR", 16)
    with pytest.raises(service.JournalError, match="budget_exceeded"):
        service.seal(writer, {"sequence": 0, "digest": service.ZERO}, service.empty())


def test_persistent_state_survives_30_days_but_export_uses_a_fresh_request(
    keys, state, settings, monkeypatch
):
    writer, reader = keys
    blob = service.seal(writer, {"sequence": 0, "digest": service.ZERO}, state)
    captured = {"sequence": 1, "digest": hashlib.sha256(blob).hexdigest()}
    original = service.time.time()
    old_request = recovery.request_for(reader["deployment_id"])
    monkeypatch.setattr(service.time, "time", lambda: original + 31 * 86400)
    persisted = service.open_record(reader, 1, service.ZERO, captured["digest"], blob)
    assert persisted == state
    instance = service.Journal(writer)
    monkeypatch.setattr(instance, "read_current", lambda: (captured, persisted))
    monkeypatch.setattr(instance, "read_head", lambda: captured)
    for name in (
        "MEETING_VOICEPRINT_ENABLED",
        "MEETING_VOICEPRINT_SAMPLING_ENABLED",
        "MEETING_VOICEPRINT_MATCHING_ENABLED",
    ):
        setattr(settings, name, False)
    with pytest.raises(recovery.RecoveryError, match="request_expired"):
        instance.export_recovery(old_request)
    request = recovery.request_for(reader["deployment_id"])
    exported = instance.export_recovery(request)
    assert service.verify_export(reader, request, exported)[0] == captured
