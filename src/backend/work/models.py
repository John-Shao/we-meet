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
    locations = models.JSONField(default=list, blank=True)
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


class WorkTask(models.Model):
    """Private office request, independent from core's human todo Task."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    organization = models.ForeignKey(
        "core.Organization", null=True, on_delete=models.PROTECT
    )
    request_key = models.UUIDField()
    recipient = models.CharField(max_length=200)
    goal = models.TextField()
    background = models.TextField(blank=True)
    sources = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "request_key"], name="work_task_once"
            )
        ]

    def __str__(self):
        return str(self.pk)


class WorkRun(models.Model):
    """A durable outbox row; one claim permits at most one provider call."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(WorkTask, related_name="runs", on_delete=models.PROTECT)
    request_key = models.UUIDField()
    status = models.CharField(max_length=16, default="queued")
    error_code = models.CharField(max_length=40, blank=True)
    model = models.CharField(max_length=200)
    base_url = models.URLField(max_length=500)
    executor_version = models.CharField(max_length=40, default="communication-v1")
    reserved_tokens = models.PositiveIntegerField()
    max_output_tokens = models.PositiveIntegerField()
    input_tokens = models.PositiveIntegerField(null=True)
    output_tokens = models.PositiveIntegerField(null=True)
    usage_record = models.OneToOneField(
        "core.AIUsageRecord", null=True, on_delete=models.PROTECT
    )
    lease_until = models.DateTimeField(null=True)
    call_started_at = models.DateTimeField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["task", "request_key"], name="work_run_once"
            )
        ]
        indexes = [
            models.Index(fields=["status", "lease_until"], name="work_run_pending")
        ]

    def __str__(self):
        return str(self.pk)


class WorkRunEvent(models.Model):
    """Ordered content-free progress events, recoverable using after=seq."""

    run = models.ForeignKey(WorkRun, related_name="events", on_delete=models.CASCADE)
    seq = models.PositiveIntegerField()
    type = models.CharField(max_length=40)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["seq"]
        constraints = [
            models.UniqueConstraint(fields=["run", "seq"], name="work_event_seq")
        ]

    def __str__(self):
        return f"{self.run_id}:{self.seq}"


class WorkArtifactVersion(models.Model):
    """Append-only Markdown revisions; generated citations stay on revision one."""

    run = models.ForeignKey(WorkRun, related_name="versions", on_delete=models.PROTECT)
    version = models.PositiveIntegerField()
    body = models.TextField()
    citations = models.JSONField(default=list)
    origin = models.CharField(max_length=16, default="generated")
    adopted_at = models.DateTimeField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["version"]
        constraints = [
            models.UniqueConstraint(
                fields=["run", "version"], name="work_artifact_version"
            )
        ]

    def __str__(self):
        return f"{self.run_id}:v{self.version}"
