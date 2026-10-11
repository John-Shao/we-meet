"""Independent PostgreSQL authority: bounded signed state and atomic append.

This module deliberately does not install its schema, create roles, initialize
an authority or recreate a missing head. Operator credentials never enter it.
Business checkpoint/gate integration is separate from this storage protocol.
"""

import base64
import copy
import hashlib
import os
import re
import stat
import time
from pathlib import Path

import psycopg
from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from core.services import voiceprint_recovery as recovery

DOMAIN = b"we-meet-voiceprint-journal-v1\x00"
EXPORT_DOMAIN = b"we-meet-voiceprint-journal-recovery-v1\x00"
ZERO = "0" * 64
TABLES = ("floors", "sources", "contributions", "permissions", "organizations")
NAME = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
HOST = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$")


class JournalError(ValueError):
    pass


def require(value, code="invalid"):
    if not value:
        raise JournalError("voiceprint_journal_" + code)


def head(value):
    recovery.keys(value, ("sequence", "digest"))
    recovery.number(value["sequence"])
    require(
        isinstance(value["digest"], str) and recovery.HEX.fullmatch(value["digest"])
    )
    require(value["sequence"] != 0 or value["digest"] == ZERO)
    return value


def load_configuration(path, role):
    require(role in {"writer", "reader"})
    value = recovery.read_private(path, 8192)
    key = "signing_key" if role == "writer" else "verification_key"
    recovery.keys(value, ("v", "deployment_id", key, "encryption_key", "database"))
    require(type(value["v"]) is int and value["v"] == 1)
    recovery.identifier(value["deployment_id"])
    database = value["database"]
    recovery.keys(database, ("host", "port", "name", "user", "password", "ca_file"))
    require(isinstance(database["host"], str) and HOST.fullmatch(database["host"]))
    require(type(database["port"]) is int and 1 <= database["port"] <= 65535)
    require(isinstance(database["name"], str) and NAME.fullmatch(database["name"]))
    require(database["user"] == "voiceprint_journal_" + role)
    require(
        isinstance(database["password"], str) and 1 <= len(database["password"]) <= 256
    )
    require(isinstance(database["ca_file"], str))
    certificate = Path(database["ca_file"])
    try:
        require(certificate.is_absolute() and not certificate.is_symlink())
        info = certificate.stat()
        require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= 131072)
    except OSError:
        raise JournalError("voiceprint_journal_configuration_unavailable") from None
    config = {
        "deployment_id": value["deployment_id"],
        "encryption_key": recovery.decode(value["encryption_key"], 32),
        key: recovery.decode(value[key], 32),
        "database": database,
    }
    if role == "writer":
        config["verification_key"] = (
            Ed25519PrivateKey.from_private_bytes(config["signing_key"])
            .public_key()
            .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        )
    return config


def empty():
    return {name: [] for name in TABLES}


def row_key(name, row):
    if name in {"floors", "permissions"}:
        return row["owner"], row["organization"]
    if name == "sources":
        return row["kind"], row["uuid"]
    return row["sample_uuid"] if name == "contributions" else row["id"]


def merge(current, delta):
    """Preserve every historical deletion proof; positive flags never erase it."""
    recovery.keys(current, TABLES)
    recovery.keys(delta, TABLES)
    recovery.validate_rows(current)
    recovery.validate_rows(delta)
    result = {}
    for name in TABLES:
        indexed = {row_key(name, row): copy.deepcopy(row) for row in current[name]}
        for row in delta[name]:
            identity = row_key(name, row)
            previous = indexed.get(identity)
            following = copy.deepcopy(row)
            if previous:
                if name == "floors":
                    following["generation"] = max(
                        previous["generation"], row["generation"]
                    )
                    following["version"] = max(previous["version"], row["version"])
                elif name in {"sources", "contributions"}:
                    require(previous == row, "proof_changed")
                elif name == "permissions":
                    require(
                        row["generation"] >= previous["generation"], "version_regressed"
                    )
                    if row["generation"] == previous["generation"]:
                        require(
                            row["version"] >= previous["version"], "version_regressed"
                        )
                        if row["version"] == previous["version"]:
                            require(row == previous, "version_changed")
                else:
                    require(row["version"] >= previous["version"], "version_regressed")
                    if row["version"] == previous["version"]:
                        require(row == previous, "version_changed")
            indexed[identity] = following
        require(len(indexed) <= recovery.MAX_ROWS, "budget_exceeded")
        # Canonical deterministic row order avoids a different state for retry order.
        result[name] = sorted(indexed.values(), key=recovery.canonical)
    recovery.validate_rows(result)
    return result


def seal(config, previous, state):
    head(previous)
    recovery.keys(state, TABLES)
    recovery.validate_rows(state)
    value = {
        "v": 1,
        "deployment_id": config["deployment_id"],
        "sequence": previous["sequence"] + 1,
        "previous": previous["digest"],
        "issued_at": int(time.time()),
        **state,
    }
    recovery.number(value["sequence"], 1)
    clear = recovery.canonical(value)
    require(len(clear) <= recovery.MAX_CLEAR, "budget_exceeded")
    aad = DOMAIN + config["deployment_id"].encode()
    nonce = os.urandom(12)
    encrypted = nonce + AESGCM(config["encryption_key"]).encrypt(nonce, clear, aad)
    signature = Ed25519PrivateKey.from_private_bytes(config["signing_key"]).sign(
        aad + encrypted
    )
    return recovery.canonical(
        {
            "v": 1,
            "encrypted": base64.b64encode(encrypted).decode(),
            "signature": base64.b64encode(signature).decode(),
        }
    )


def open_record(config, sequence, previous, digest, blob):
    recovery.number(sequence, 1)
    for value in (previous, digest):
        require(isinstance(value, str) and recovery.HEX.fullmatch(value))
    require(
        isinstance(blob, bytes) and 128 <= len(blob) <= recovery.MAX_FILE,
        "budget_exceeded",
    )
    require(hashlib.sha256(blob).hexdigest() == digest, "digest_changed")
    envelope = recovery.parse(blob)
    recovery.keys(envelope, ("v", "encrypted", "signature"))
    require(type(envelope["v"]) is int and envelope["v"] == 1)
    encrypted = recovery.decode(envelope["encrypted"])
    require(28 < len(encrypted) <= recovery.MAX_CLEAR + 28, "budget_exceeded")
    signature = recovery.decode(envelope["signature"], 64)
    aad = DOMAIN + config["deployment_id"].encode()
    try:
        Ed25519PublicKey.from_public_bytes(config["verification_key"]).verify(
            signature, aad + encrypted
        )
        clear = AESGCM(config["encryption_key"]).decrypt(
            encrypted[:12], encrypted[12:], aad
        )
    except (InvalidSignature, InvalidTag, ValueError):
        raise JournalError("voiceprint_journal_authentication_failed") from None
    value = recovery.parse(clear)
    recovery.keys(
        value, ("v", "deployment_id", "sequence", "previous", "issued_at", *TABLES)
    )
    require(type(value["v"]) is int and value["v"] == 1)
    require(value["deployment_id"] == config["deployment_id"], "wrong_deployment")
    recovery.number(value["sequence"], 1)
    require(
        value["sequence"] == sequence and value["previous"] == previous, "head_changed"
    )
    require(sequence != 1 or previous == ZERO)
    recovery.number(value["issued_at"])
    require(value["issued_at"] <= int(time.time()) + 30, "future_record")
    state = {name: value[name] for name in TABLES}
    recovery.validate_rows(state)
    return state


def verify_export(config, request, exported):
    recovery.keys(exported, ("v", "head", "bundle", "signature"))
    require(type(exported["v"]) is int and exported["v"] == 1)
    captured = head(exported["head"])
    require(captured["sequence"] >= 1)
    payload = {key: exported[key] for key in ("v", "head", "bundle")}
    signature = recovery.decode(exported["signature"], 64)
    aad = EXPORT_DOMAIN + config["deployment_id"].encode()
    try:
        Ed25519PublicKey.from_public_bytes(config["verification_key"]).verify(
            signature, aad + recovery.canonical(payload)
        )
    except (InvalidSignature, ValueError):
        raise JournalError("voiceprint_journal_authentication_failed") from None
    value = recovery.verified_snapshot(config, request, exported["bundle"])
    return captured, value


class Journal:
    def __init__(self, configuration):
        self.configuration = configuration

    def call(self, statement, parameters):
        database = self.configuration["database"]
        try:
            with (
                psycopg.connect(
                    host=database["host"],
                    port=database["port"],
                    dbname=database["name"],
                    user=database["user"],
                    password=database["password"],
                    sslmode="verify-full",
                    sslrootcert=database["ca_file"],
                    connect_timeout=3,
                    autocommit=True,
                    application_name="we-meet-voiceprint-journal",
                    options="-c statement_timeout=3000 -c lock_timeout=1000",
                ) as connection,
                connection.cursor() as cursor,
            ):
                cursor.execute(statement, parameters)
                return cursor.fetchall()
        except psycopg.errors.SerializationFailure:
            raise JournalError("voiceprint_journal_conflict") from None
        except (psycopg.Error, OSError):
            raise JournalError("voiceprint_journal_unavailable") from None

    def read_head(self):
        result = self.call(
            "SELECT sequence,digest FROM voiceprint_journal.read_head(%s)",
            (self.configuration["deployment_id"],),
        )
        require(len(result) == 1, "not_initialized")
        return head({"sequence": result[0][0], "digest": result[0][1]})

    def read_current(self):
        result = self.call(
            "SELECT sequence,previous,digest,envelope FROM voiceprint_journal.read_current(%s)",
            (self.configuration["deployment_id"],),
        )
        require(len(result) == 1, "not_initialized")
        sequence, previous, digest, blob = result[0]
        state = open_record(self.configuration, sequence, previous, digest, bytes(blob))
        return head({"sequence": sequence, "digest": digest}), state

    def publish(self, expected, delta):
        require("signing_key" in self.configuration, "writer_required")
        head(expected)
        if expected["sequence"] == 0:
            require(self.read_head() == expected, "conflict")
            previous = empty()
        else:
            current, previous = self.read_current()
            require(current == expected, "conflict")
        state = merge(previous, delta)
        blob = seal(self.configuration, expected, state)
        digest = hashlib.sha256(blob).hexdigest()
        result = self.call(
            "SELECT sequence,digest FROM voiceprint_journal.append_record(%s,%s,%s,%s,%s)",
            (
                self.configuration["deployment_id"],
                expected["sequence"],
                expected["digest"],
                blob,
                digest,
            ),
        )
        following = {"sequence": expected["sequence"] + 1, "digest": digest}
        require(result == [(following["sequence"], digest)], "acknowledgement_changed")
        return following

    def export_recovery(self, request):
        """A writer can issue a fresh recovery packet without the primary DB."""
        require("signing_key" in self.configuration, "writer_required")
        recovery.offline()
        recovery.validate_request(request, self.configuration["deployment_id"])
        captured, state = self.read_current()
        require(self.read_head() == captured, "conflict")
        recovery.validate_request(request, self.configuration["deployment_id"])
        value = {
            "v": 1,
            "deployment_id": self.configuration["deployment_id"],
            "nonce": request["nonce"],
            "issued_at": int(time.time()),
            "expires_at": request["expires_at"],
            **state,
        }
        # The existing recovery envelope remains interoperable and request-bound.
        clear = recovery.canonical(value)
        require(len(clear) <= recovery.MAX_CLEAR, "budget_exceeded")
        aad = recovery.DOMAIN + self.configuration["deployment_id"].encode()
        nonce = os.urandom(12)
        encrypted = nonce + AESGCM(self.configuration["encryption_key"]).encrypt(
            nonce, clear, aad
        )
        signature = Ed25519PrivateKey.from_private_bytes(
            self.configuration["signing_key"]
        ).sign(aad + encrypted)
        bundle = {
            "v": 1,
            "encrypted": base64.b64encode(encrypted).decode(),
            "signature": base64.b64encode(signature).decode(),
        }
        payload = {"v": 1, "head": captured, "bundle": bundle}
        signature = Ed25519PrivateKey.from_private_bytes(
            self.configuration["signing_key"]
        ).sign(
            EXPORT_DOMAIN
            + self.configuration["deployment_id"].encode()
            + recovery.canonical(payload)
        )
        return {**payload, "signature": base64.b64encode(signature).decode()}
