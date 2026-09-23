"""Durable private input materials; these are not human Task attachments."""

import uuid

from django.conf import settings
from django.db import models


class WorkMaterial(models.Model):
    """Immutable input bytes with a fenced, retryable text parsing job."""

    class Status(models.TextChoices):
        UPLOADED = "uploaded"
        PARSING = "parsing"
        READY = "ready"
        FAILED = "failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    organization = models.ForeignKey(
        "core.Organization", null=True, blank=True, on_delete=models.PROTECT
    )
    upload_key = models.UUIDField()
    original_name = models.CharField(max_length=255)
    storage_key = models.CharField(max_length=500)
    checksum = models.CharField(max_length=64)
    size = models.PositiveIntegerField()
    mime = models.CharField(max_length=80)
    status = models.CharField(max_length=16, choices=Status, default=Status.UPLOADED)
    parser_version = models.CharField(max_length=40, blank=True)
    text = models.TextField(blank=True)
    line_count = models.PositiveIntegerField(default=0)
    error_code = models.CharField(max_length=40, blank=True)
    generation = models.PositiveIntegerField(default=0)
    lease_until = models.DateTimeField(null=True, blank=True)
    retry_key = models.UUIDField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    purged_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "upload_key"], name="work_upload_once"
            )
        ]
        indexes = [
            models.Index(fields=["owner", "deleted_at"], name="work_material_owner"),
            models.Index(
                fields=["status", "lease_until"], name="work_material_pending"
            ),
        ]

    def __str__(self):
        return self.original_name
