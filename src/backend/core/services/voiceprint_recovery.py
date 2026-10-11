"""Encrypted, signed current-source handoff before an offline database restore.

The writer's private signing key is never supplied to the restored database.
Only explicit non-biometric metadata is exported; replay never grants consent.
"""

import base64
import hashlib
import json
import os
import re
import stat
import time
from pathlib import Path
from uuid import UUID, uuid5

from django.conf import settings
from django.db import connection, transaction
from django.db.models import Exists, Max, OuterRef, Subquery
from django.utils import timezone

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from core import models
from core.services import voiceprint_consent as consent
from core.services import voiceprint_source_removal as removal

DOMAIN = b"we-meet-voiceprint-recovery-v1\x00"
MAX_ROWS = 100000
MAX_CLEAR = 8 * 1024 * 1024
MAX_FILE = 12 * 1024 * 1024
REQUEST_SECONDS = 3600
HEX = re.compile(r"^[0-9a-f]{64}$")


class RecoveryError(ValueError):
    pass


def require(value, code="invalid"):
    if not value:
        raise RecoveryError("voiceprint_recovery_" + code)


def keys(value, fields):
    require(isinstance(value, dict) and set(value) == set(fields))


def identifier(value, *, nullable=False):
    if value is None and nullable:
        return
    require(isinstance(value, str))
    try:
        require(str(UUID(value)) == value)
    except (ValueError, AttributeError):
        raise RecoveryError("voiceprint_recovery_invalid") from None


def number(value, minimum=0):
    require(type(value) is int and minimum <= value < 2**63)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def parse(value):
    try:
        return json.loads(value, object_pairs_hook=unique_object)
    except (ValueError, UnicodeError, RecursionError):
        raise RecoveryError("voiceprint_recovery_invalid") from None


def read_private(path, bound=MAX_FILE):
    """Reject devices/FIFOs, oversized files and public Unix key/artifact files."""
    try:
        path = Path(path)
        require(not path.is_symlink(), "file_unavailable")
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
        )
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            require(
                stat.S_ISREG(info.st_mode) and 0 < info.st_size <= bound,
                "file_unavailable",
            )
            if os.name != "nt":
                require(not info.st_mode & 0o027, "file_unavailable")
            value = stream.read(bound + 1)
            require(len(value) <= bound, "file_unavailable")
            return parse(value)
    except OSError:
        raise RecoveryError("voiceprint_recovery_file_unavailable") from None


def write_private(path, value):
    """Create a new private, durable file; never overwrite a request or receipt."""
    data = canonical(value) + b"\n"
    require(len(data) <= MAX_FILE, "budget_exceeded")
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if os.name != "nt":
            parent = os.open(Path(path).resolve().parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
    except OSError:
        raise RecoveryError("voiceprint_recovery_output_unavailable") from None


def decode(value, size=None):
    try:
        require(isinstance(value, str) and len(value) <= MAX_FILE)
        raw = base64.b64decode(value, validate=True)
        require(size is None or len(raw) == size)
        return raw
    except (ValueError, TypeError):
        raise RecoveryError("voiceprint_recovery_invalid") from None


def configuration(path, role):
    value = read_private(path, 4096)
    key = "signing_key" if role == "writer" else "verification_key"
    require(role in {"writer", "reader"})
    keys(value, ("v", "deployment_id", key, "encryption_key"))
    require(type(value["v"]) is int and value["v"] == 1)
    identifier(value["deployment_id"])
    return {
        "deployment_id": value["deployment_id"],
        key: decode(value[key], 32),
        "encryption_key": decode(value["encryption_key"], 32),
    }


def request_for(deployment_id):
    identifier(deployment_id)
    now = int(time.time())
    return {
        "v": 1,
        "deployment_id": deployment_id,
        "nonce": os.urandom(32).hex(),
        "created_at": now,
        "expires_at": now + REQUEST_SECONDS,
    }


def validate_request(value, deployment_id):
    keys(value, ("v", "deployment_id", "nonce", "created_at", "expires_at"))
    require(type(value["v"]) is int and value["v"] == 1)
    require(value["deployment_id"] == deployment_id, "wrong_deployment")
    require(isinstance(value["nonce"], str) and HEX.fullmatch(value["nonce"]))
    number(value["created_at"])
    number(value["expires_at"])
    now = int(time.time())
    require(
        value["created_at"] <= now + 30
        and now < value["expires_at"]
        and 0 < value["expires_at"] - value["created_at"] <= REQUEST_SECONDS,
        "request_expired",
    )


def offline():
    require(
        not any(
            getattr(settings, key)
            for key in (
                "MEETING_VOICEPRINT_ENABLED",
                "MEETING_VOICEPRINT_SAMPLING_ENABLED",
                "MEETING_VOICEPRINT_MATCHING_ENABLED",
            )
        ),
        "offline_required",
    )


def rows(query):
    values = list(query[: MAX_ROWS + 1])
    require(len(values) <= MAX_ROWS, "budget_exceeded")
    return values


def string(value):
    return str(value) if value is not None else None


def read_current():
    """One repeatable-read snapshot; no audio, vector, key or personal names."""
    require(
        connection.vendor == "postgresql" and not connection.in_atomic_block,
        "snapshot_transaction_required",
    )
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        floors = rows(
            models.VoiceprintDeletionJob.objects.values("owner_id", "organization_id")
            .annotate(
                generation=Max("revoked_generation"), version=Max("expected_version")
            )
            .order_by("owner_id", "organization_id")
        )
        sources = rows(
            models.VoiceprintSourceRemoval.objects.order_by("id").values(
                "kind", "source_uuid", "source_session_id", "track_digest"
            )
        )
        contributions = rows(
            models.VoiceprintContributionRemoval.objects.order_by("id").values(
                "sample_uuid",
                "profile_uuid",
                "owner_uuid",
                "organization_uuid",
                "generation",
                "templates",
            )
        )
        blocked = rows(
            models.VoiceprintSample.objects.filter(
                status__in=["rejected", "expired", "deleted"]
            )
            .order_by("id")
            .values(
                "id",
                "profile_id",
                "profile__consent__user_id",
                "profile__consent__organization_id",
                "generation",
            )
        )
        members = models.Membership.objects.filter(
            user_id=OuterRef("user_id"),
            organization_id=OuterRef("organization_id"),
            status=models.MembershipStatusChoices.ACTIVE,
        )
        maximum = (
            models.VoiceprintProfile.objects.filter(consent_id=OuterRef("pk"))
            .values("consent_id")
            .annotate(value=Max("generation"))
            .values("value")[:1]
        )
        live = models.VoiceprintProfile.objects.filter(
            consent_id=OuterRef("pk")
        ).exclude(status="deleted", encrypted_key=b"")
        scopes = rows(
            models.VoiceprintConsent.objects.annotate(
                member_active=Exists(members),
                maximum_generation=Subquery(maximum),
                live_profile=Exists(live),
            )
            .select_related("user", "organization")
            .only(
                "user__id",
                "user__is_active",
                "user__is_device",
                "organization__id",
                "organization__is_active",
                "organization__settings",
                "generation",
                "version",
                *consent.PERMISSIONS,
            )
            .order_by("id")
        )
        permissions = []
        unavailable = []
        for row in scopes:
            active = row.user.is_active and not row.user.is_device
            if row.organization_id:
                active = active and row.member_active and row.organization.is_active
            if not active and (
                row.live_profile
                or any(getattr(row, key) for key in consent.PERMISSIONS)
            ):
                unavailable.append(
                    {
                        "owner_id": row.user_id,
                        "organization_id": row.organization_id,
                        "generation": max(row.generation, row.maximum_generation or 0)
                        + 1,
                        "version": row.version,
                    }
                )
            permissions.append(
                {
                    "owner": string(row.user_id),
                    "organization": string(row.organization_id),
                    "generation": row.generation,
                    "version": row.version,
                    "flags": {
                        key: active and getattr(row, key) for key in consent.PERMISSIONS
                    },
                }
            )
        organizations = rows(
            models.Organization.objects.filter(
                pk__in=models.VoiceprintConsent.objects.exclude(
                    organization_id=None
                ).values("organization_id")
            )
            .only("id", "is_active", "settings")
            .order_by("id")
        )
        policies = [
            {
                "id": str(row.pk),
                "enabled": row.is_active
                and consent.organization_policy(row)["enabled"],
                "version": consent.organization_policy(row)["version"],
            }
            for row in organizations
        ]
    by_scope = {(row["owner_id"], row["organization_id"]): row for row in floors}
    for row in unavailable:
        previous = by_scope.get((row["owner_id"], row["organization_id"]))
        if previous:
            previous["generation"] = max(previous["generation"], row["generation"])
            previous["version"] = max(previous["version"], row["version"])
        else:
            floors.append(row)
    captured = {string(row["sample_uuid"]) for row in contributions}
    for row in blocked:
        if string(row["id"]) not in captured:
            contributions.append(
                {
                    "sample_uuid": row["id"],
                    "profile_uuid": row["profile_id"],
                    "owner_uuid": row["profile__consent__user_id"],
                    "organization_uuid": row["profile__consent__organization_id"],
                    "generation": row["generation"],
                    "templates": {"all": False, "permit_id": None, "rows": []},
                }
            )
    return {
        "floors": [
            {
                "owner": string(row["owner_id"]),
                "organization": string(row["organization_id"]),
                "generation": row["generation"],
                "version": row["version"],
            }
            for row in floors
        ],
        "sources": [
            {
                "kind": row["kind"],
                "uuid": string(row["source_uuid"]),
                "session": string(row["source_session_id"]),
                "digest": row["track_digest"],
            }
            for row in sources
        ],
        "contributions": [
            {
                key: row[key]
                if key in {"generation", "templates"}
                else string(row[key])
                for key in row
            }
            for row in contributions
        ],
        "permissions": permissions,
        "organizations": policies,
    }


def validate_rows(value):  # noqa: PLR0915 -- Validate all metadata before any restore mutation.
    for name in ("floors", "sources", "contributions", "permissions", "organizations"):
        require(
            isinstance(value[name], list) and len(value[name]) <= MAX_ROWS,
            "budget_exceeded",
        )
    seen = set()
    for row in value["floors"]:
        keys(row, ("owner", "organization", "generation", "version"))
        identifier(row["owner"])
        identifier(row["organization"], nullable=True)
        number(row["generation"], 2)
        number(row["version"])
        key = (row["owner"], row["organization"])
        require(key not in seen)
        seen.add(key)
    seen.clear()
    for row in value["sources"]:
        keys(row, ("kind", "uuid", "session", "digest"))
        require(
            isinstance(row["kind"], str)
            and row["kind"] in {"record", "session", "track"}
        )
        identifier(row["uuid"])
        identifier(row["session"], nullable=True)
        require(
            isinstance(row["digest"], str)
            and (row["digest"] == "" or HEX.fullmatch(row["digest"]))
        )
        require(
            (row["kind"] == "track" and row["digest"] != "" and row["session"] is None)
            or (row["kind"] != "track" and row["digest"] == "")
        )
        if row["kind"] == "session":
            require(row["session"] == row["uuid"])
        key = (row["kind"], row["uuid"])
        require(key not in seen)
        seen.add(key)
    seen.clear()
    for row in value["organizations"]:
        keys(row, ("id", "enabled", "version"))
        identifier(row["id"])
        require(type(row["enabled"]) is bool)
        number(row["version"])
        require(row["id"] not in seen)
        seen.add(row["id"])
    seen.clear()
    for row in value["contributions"]:
        keys(
            row,
            (
                "sample_uuid",
                "profile_uuid",
                "owner_uuid",
                "organization_uuid",
                "generation",
                "templates",
            ),
        )
        for key in ("sample_uuid", "profile_uuid", "owner_uuid"):
            identifier(row[key])
        identifier(row["organization_uuid"], nullable=True)
        number(row["generation"], 1)
        require(row["sample_uuid"] not in seen)
        seen.add(row["sample_uuid"])
        proof = row["templates"]
        keys(proof, ("all", "permit_id", "rows"))
        require(type(proof["all"]) is bool)
        identifier(proof["permit_id"], nullable=True)
        require(
            isinstance(proof["rows"], list)
            and len(proof["rows"]) <= removal.MAX_TEMPLATES + 1
        )
        template_ids = set()
        for item in proof["rows"]:
            keys(item, ("id", "revision", "digest", "baseline"))
            identifier(item["id"])
            require(item["id"] not in template_ids)
            template_ids.add(item["id"])
            number(item["revision"], 1)
            require(
                type(item["baseline"]) is bool
                and isinstance(item["digest"], str)
                and (item["digest"] == "" or HEX.fullmatch(item["digest"]))
            )
    seen.clear()
    for row in value["permissions"]:
        keys(row, ("owner", "organization", "generation", "version", "flags"))
        identifier(row["owner"])
        identifier(row["organization"], nullable=True)
        number(row["generation"], 1)
        number(row["version"], 1)
        keys(row["flags"], consent.PERMISSIONS)
        require(all(type(flag) is bool for flag in row["flags"].values()))
        key = (row["owner"], row["organization"])
        require(key not in seen)
        seen.add(key)


def export_snapshot(config, request):
    offline()
    validate_request(request, config["deployment_id"])
    data = {
        "v": 1,
        "deployment_id": config["deployment_id"],
        "nonce": request["nonce"],
        "issued_at": int(time.time()),
        "expires_at": request["expires_at"],
        **read_current(),
    }
    validate_rows(data)
    clear = canonical(data)
    require(len(clear) <= MAX_CLEAR, "budget_exceeded")
    aad = DOMAIN + config["deployment_id"].encode()
    nonce = os.urandom(12)
    sealed = nonce + AESGCM(config["encryption_key"]).encrypt(nonce, clear, aad)
    signature = Ed25519PrivateKey.from_private_bytes(config["signing_key"]).sign(
        aad + sealed
    )
    return {
        "v": 1,
        "encrypted": base64.b64encode(sealed).decode(),
        "signature": base64.b64encode(signature).decode(),
    }


def verified_snapshot(config, request, bundle):
    validate_request(request, config["deployment_id"])
    keys(bundle, ("v", "encrypted", "signature"))
    require(type(bundle["v"]) is int and bundle["v"] == 1)
    sealed = decode(bundle["encrypted"])
    require(28 < len(sealed) <= MAX_CLEAR + 28, "budget_exceeded")
    signature = decode(bundle["signature"], 64)
    aad = DOMAIN + config["deployment_id"].encode()
    try:
        Ed25519PublicKey.from_public_bytes(config["verification_key"]).verify(
            signature, aad + sealed
        )
        clear = AESGCM(config["encryption_key"]).decrypt(sealed[:12], sealed[12:], aad)
    except (InvalidSignature, InvalidTag, ValueError):
        raise RecoveryError("voiceprint_recovery_authentication_failed") from None
    value = parse(clear)
    keys(
        value,
        (
            "v",
            "deployment_id",
            "nonce",
            "issued_at",
            "expires_at",
            "floors",
            "sources",
            "contributions",
            "permissions",
            "organizations",
        ),
    )
    require(
        type(value["v"]) is int
        and value["v"] == 1
        and value["deployment_id"] == config["deployment_id"]
    )
    require(value["nonce"] == request["nonce"], "wrong_request")
    number(value["issued_at"])
    number(value["expires_at"])
    now = int(time.time())
    require(
        request["created_at"] - 30 <= value["issued_at"] <= now + 30
        and now < value["expires_at"] <= request["expires_at"],
        "snapshot_expired",
    )
    validate_rows(value)
    return value


def consistent(row, expected):
    for name, value in expected.items():
        observed = getattr(row, name)
        if isinstance(observed, UUID):
            observed = str(observed)
        require(observed == value, "scope_changed")


def restrict_policies(policies):
    changed = 0
    for policy in policies:
        if policy["enabled"]:
            continue
        organization = (
            models.Organization.objects.select_for_update()
            .filter(pk=policy["id"])
            .first()
        )
        if organization is None:
            continue
        current = consent.organization_policy(organization)
        if current["version"] > policy["version"]:
            continue
        if current["enabled"] or current["version"] < policy["version"]:
            organization.settings = {
                **(
                    organization.settings
                    if isinstance(organization.settings, dict)
                    else {}
                ),
                "voiceprint": {
                    "enabled": False,
                    "version": max(current["version"], policy["version"]) + 1,
                },
            }
            organization.save(update_fields=["settings", "updated_at"])
            changed += current["enabled"]
    return changed


@transaction.atomic
def apply_rows(value):
    offline()
    require(connection.vendor == "postgresql", "snapshot_transaction_required")
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout = '5s'")
    scopes = rows(
        models.VoiceprintConsent.objects.select_for_update().order_by(
            "user_id", "organization_id"
        )
    )
    jobs = []
    for floor in value["floors"]:
        key = uuid5(
            UUID(value["deployment_id"]),
            f"voiceprint-recovery-v1/{floor['owner']}/{floor['organization']}/{floor['generation']}",
        )
        job, _created = models.VoiceprintDeletionJob.objects.get_or_create(
            owner_id=floor["owner"],
            request_key=key,
            defaults={
                "organization_id": floor["organization"],
                "expected_version": floor["version"],
                "revoked_generation": floor["generation"],
                "reason": "backup_recovery",
            },
        )
        consistent(
            job,
            {
                "organization_id": floor["organization"],
                "revoked_generation": floor["generation"],
            },
        )
        jobs.append(job)
    for source in value["sources"]:
        row, _created = models.VoiceprintSourceRemoval.objects.get_or_create(
            kind=source["kind"],
            source_uuid=source["uuid"],
            defaults={
                "source_session_id": source["session"],
                "track_digest": source["digest"],
            },
        )
        consistent(
            row,
            {"source_session_id": source["session"], "track_digest": source["digest"]},
        )
    imported = []
    for contribution in value["contributions"]:
        row, _created = models.VoiceprintContributionRemoval.objects.get_or_create(
            sample_uuid=contribution["sample_uuid"],
            defaults={
                key: item for key, item in contribution.items() if key != "sample_uuid"
            },
        )
        consistent(
            row,
            {key: item for key, item in contribution.items() if key != "sample_uuid"},
        )
        imported.append(row)
    policies_changed = restrict_policies(value["organizations"])
    permissions = {
        (row["owner"], row["organization"]): row for row in value["permissions"]
    }
    changed = advanced = 0
    for row in scopes:
        scope = permissions.get((str(row.user_id), string(row.organization_id)))
        if scope is not None and (
            row.version > scope["version"] or row.generation > scope["generation"]
        ):
            continue  # Never undo a newer explicit grant when replaying the same packet.
        revoked = [
            key
            for key in consent.PERMISSIONS
            if getattr(row, key) and (scope is None or not scope["flags"][key])
        ]
        stale_version = scope is not None and row.version < scope["version"]
        if revoked or stale_version:
            maximum = row.events.aggregate(value=Max("version"))["value"] or 0
            row.version = (
                max(row.version, maximum, scope["version"] if scope else 0) + 1
            )
            for key in revoked:
                setattr(row, key, False)
            if revoked:
                row.revoked_at = timezone.now()
            row.save()
            consent.cancel_pending_work(row)
            consent.event(row, "invalidate")
            changed += bool(revoked)
            advanced += stale_version
    for job in jobs:
        consent.purge_deleted(job.pk)
    for row in imported:
        require(removal.purge(row.pk) in {"purged", "complete"}, "cleanup_busy")
    return {
        "floors": len(jobs),
        "sources": len(value["sources"]),
        "contributions": len(imported),
        "permissions_restricted": changed,
        "consent_versions_advanced": advanced,
        "organization_policies_restricted": policies_changed,
        "pending_template_rebuilds": models.VoiceprintContributionRemoval.objects.filter(
            pk__in=[row.pk for row in imported], status="purged"
        ).count(),
    }


def restore_snapshot(config, request, bundle):
    offline()
    value = verified_snapshot(config, request, bundle)
    result = apply_rows(value)
    return {
        "status": "replayed",
        "bundle_sha256": hashlib.sha256(canonical(bundle)).hexdigest(),
        "nonce_sha256": hashlib.sha256(request["nonce"].encode()).hexdigest(),
        "voiceprint_enabled": False,
        **result,
    }
