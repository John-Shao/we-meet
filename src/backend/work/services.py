"""Bounded upload, ownership and recoverable text parsing."""

import hashlib
import json
import logging
import os
import subprocess
import sys
import uuid
from datetime import timedelta
from pathlib import Path, PurePath

from django.conf import settings
from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Q, Sum
from django.utils import timezone

from core.models import Membership, MembershipStatusChoices, User

from .models import WorkMaterial
from .storage import material_storage

logger = logging.getLogger(__name__)
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_OWNER_BYTES = 100 * 1024 * 1024
MAX_OWNER_FILES = 100
MAX_TEXT_CHARS = 200_000
MAX_LINES = 50_000
PARSER_VERSION = "plain-text-v1"


class MaterialError(ValueError):
    """Stable public error code, never storage credentials or parser internals."""

    def __init__(self, code, status=400):
        self.code = code
        self.status = status
        super().__init__(code)


def organization_for(user):
    """Match primary-first directory scope without depending on meeting services."""
    return (
        Membership.objects.filter(
            user=user,
            status=MembershipStatusChoices.ACTIVE,
            organization__is_active=True,
        )
        .order_by("-is_primary", "created_at")
        .values_list("organization_id", flat=True)
        .first()
    )


def visible_materials(user):
    """Owner AND current org scope; null organizations are never public."""
    return WorkMaterial.objects.filter(
        owner=user, organization_id=organization_for(user), deleted_at__isnull=True
    )


def read_upload(upload):
    """Enforce the limit on bytes read as well as the multipart declaration."""
    name = PurePath(upload.name.replace("\\", "/")).name
    extension = PurePath(name).suffix.lower()
    if extension not in {".txt", ".md", ".markdown", ".pdf", ".docx"}:
        raise MaterialError("unsupported_format")
    if not name or len(name) > 255:
        raise MaterialError("invalid_filename")
    if upload.size > MAX_FILE_BYTES:
        raise MaterialError("file_too_large", 413)
    data = upload.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise MaterialError("file_too_large", 413)
    if not data:
        raise MaterialError("empty_file")
    if extension in {".pdf", ".docx"}:
        signature = b"%PDF-" if extension == ".pdf" else b"PK\x03\x04"
        if not data.startswith(signature):
            raise MaterialError("invalid_document")
        return (
            name,
            data,
            "application/pdf"
            if extension == ".pdf"
            else "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
    # Known containers and binary controls cannot masquerade as plain text.
    if (
        data.startswith((b"PK\x03\x04", b"%PDF-", b"\x89PNG", b"\xff\xd8\xff"))
        or b"\x00" in data
    ):
        raise MaterialError("not_text")
    return name, data, "text/markdown" if extension != ".txt" else "text/plain"


def create_material(user, upload, upload_key):
    """Serialize owner quota and upload dedupe; storage failure leaves no job."""
    name, data, mime = read_upload(upload)
    checksum = hashlib.sha256(data).hexdigest()
    storage = material_storage()
    stored_key = None
    try:
        with transaction.atomic():
            User.objects.select_for_update().get(pk=user.pk)
            organization_id = organization_for(user)
            existing = WorkMaterial.objects.filter(
                owner=user, upload_key=upload_key
            ).first()
            if existing:
                if existing.deleted_at:
                    raise MaterialError("upload_deleted", 410)
                if (
                    existing.checksum,
                    existing.original_name,
                    existing.organization_id,
                ) != (checksum, name, organization_id):
                    raise MaterialError("idempotency_conflict", 409)
                return existing, False
            # Include pending deletion until storage cleanup actually succeeds.
            owned = WorkMaterial.objects.filter(owner=user, purged_at__isnull=True)
            if owned.count() >= MAX_OWNER_FILES or (
                (owned.aggregate(total=Sum("size"))["total"] or 0) + len(data)
                > MAX_OWNER_BYTES
            ):
                raise MaterialError("material_quota_exceeded", 413)
            stored_key = storage.save(
                f"{user.pk}/{uuid.uuid4().hex}", ContentFile(data)
            )
            material = WorkMaterial.objects.create(
                owner=user,
                organization_id=organization_id,
                upload_key=upload_key,
                original_name=name,
                storage_key=stored_key,
                checksum=checksum,
                size=len(data),
                mime=mime,
            )
            return material, True
    except Exception:
        # Only our newly created object can be cleaned up, never a prior upload.
        if stored_key:
            try:
                storage.delete(stored_key)
            except Exception:  # noqa: BLE001 -- cleanup is best effort, no credential-bearing logging
                logger.error("work_upload_orphan_cleanup_failed")
        raise


def parse_text(data):
    """Strict UTF-8, bounded plain text. No markdown rendering or link fetching."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise MaterialError("unsupported_encoding") from exc
    if any(ord(char) < 32 and char not in "\n\r\t" for char in text):
        raise MaterialError("not_text")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        raise MaterialError("empty_text")
    if len(text) > MAX_TEXT_CHARS or len(text.splitlines()) > MAX_LINES:
        raise MaterialError("text_limit_exceeded")
    return text


def claim_material():
    """Expired leases are reclaimable; generation fences late worker results."""
    now = timezone.now()
    with transaction.atomic():
        item = (
            WorkMaterial.objects.select_for_update(skip_locked=True)
            .filter(deleted_at__isnull=True)
            .filter(Q(status="uploaded") | Q(status="parsing", lease_until__lt=now))
            .order_by("created_at", "id")
            .first()
        )
        if not item:
            return None
        item.status = WorkMaterial.Status.PARSING
        item.generation += 1
        item.lease_until = now + timedelta(minutes=2)
        item.save(update_fields=["status", "generation", "lease_until", "updated_at"])
        return item


def finish_material(item, *, text="", error_code="", locations=None):
    """A deletion, account revocation or newer attempt wins over a late result."""
    with transaction.atomic():
        current = WorkMaterial.objects.select_for_update().get(pk=item.pk)
        if (
            current.deleted_at
            or current.generation != item.generation
            or current.status != "parsing"
        ):
            return False
        user = User.objects.get(pk=item.owner_id)
        if (
            not user.is_active
            or user.is_device
            or not user.sub
            or organization_for(user) != item.organization_id
        ):
            text, error_code = "", "access_revoked"
        if not settings.WORK_ENABLED or not settings.WORK_MATERIALS_ENABLED:
            current.status = WorkMaterial.Status.UPLOADED
        else:
            current.status = (
                WorkMaterial.Status.FAILED if error_code else WorkMaterial.Status.READY
            )
            current.text = text
            current.locations = locations or [] if text else []
            current.line_count = len(text.splitlines())
            current.error_code = error_code
            current.parser_version = (
                "document-text-v1"
                if item.mime.startswith("application/")
                else PARSER_VERSION
            )
        current.lease_until = None
        current.save()
        return True


def parse_material(item):
    """Read a bounded object and validate its immutable checksum before parsing."""
    text, error, locations = "", "", []
    try:
        user = User.objects.get(pk=item.owner_id)
        if (
            not user.is_active
            or user.is_device
            or not user.sub
            or organization_for(user) != item.organization_id
        ):
            raise MaterialError("access_revoked")
        with material_storage().open(item.storage_key, "rb") as source:
            data = source.read(MAX_FILE_BYTES + 1)
        if len(data) != item.size or hashlib.sha256(data).hexdigest() != item.checksum:
            raise MaterialError("source_changed")
        if item.mime.startswith("application/"):
            text, locations = parse_document(
                data, "pdf" if item.mime == "application/pdf" else "docx"
            )
            text = parse_text(text.encode("utf-8"))
        else:
            text = parse_text(data)
    except MaterialError as exc:
        error = exc.code
    except Exception:  # noqa: BLE001 -- storage failures become a sanitized retryable state
        error = "parse_unavailable"
        logger.warning("work_material_parse_unavailable id=%s", item.pk)
    finish_material(
        item,
        text="" if error else text,
        error_code=error,
        locations=[] if error else locations,
    )


def process_materials(limit=20):
    """DB jobs are the durable outbox; beat/CLI can recover missed wakeups."""
    cleanup_deleted(limit)
    count = 0
    while count < limit and settings.WORK_ENABLED and settings.WORK_MATERIALS_ENABLED:
        item = claim_material()
        if item is None:
            break
        parse_material(item)
        count += 1
    return count


def cleanup_deleted(limit=20):
    """Tombstones immediately deny reads; object deletion is safely repeatable."""
    for item in WorkMaterial.objects.filter(
        deleted_at__isnull=False, purged_at__isnull=True
    ).order_by("deleted_at")[:limit]:
        try:
            material_storage().delete(item.storage_key)
        except Exception:  # noqa: BLE001 -- leave tombstone pending on any backend failure
            logger.warning("work_material_cleanup_unavailable id=%s", item.pk)
            continue
        WorkMaterial.objects.filter(pk=item.pk, purged_at__isnull=True).update(
            purged_at=timezone.now(),
            storage_key="",
            text="",
            line_count=0,
            locations=[],
        )


def parse_document(data, kind):
    """Bounded subprocess boundary, with no application credentials in its environment."""
    try:
        result = subprocess.run(  # noqa: S603 -- fixed executable/parser; untrusted bytes only on stdin
            [sys.executable, str(Path(__file__).with_name("document_parser.py")), kind],
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=25,
            check=False,
            env={
                key: value
                for key, value in os.environ.items()
                if key.upper() in {"SYSTEMROOT", "TEMP", "TMP", "PATH"}
            },
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired as exc:
        raise MaterialError("document_limit_exceeded") from exc
    if result.returncode or len(result.stdout) > 10 * 1024 * 1024:
        raise MaterialError("document_limit_exceeded")
    parsed = json.loads(result.stdout)
    if "error" in parsed:
        raise MaterialError(parsed["error"])
    return parsed["text"], parsed["locations"]
