"""Explicit task confirmation from an immutable human revision, without inferred owners."""

import hashlib
import json

from django.conf import settings
from django.db import transaction

from core import models
from core.services.meeting_records import RecordConflict
from core.services.meeting_summary_review import can_edit
from core.services.task_assignees import set_task_assignees
from core.services.task_hierarchy import filter_visible_task_hierarchy
from core.services.task_history import record_task_created
from core.services.task_notifications import record_task_assignment
from core.services.tasks import ensure_task_assignee_allowed, task_organization_for_user


def action_hash(point):
    """Identical action text in one record stays one task across human/AI revisions."""
    return hashlib.sha256(point["text"].strip().encode()).hexdigest()


def can_convert(record, user):
    """Require current editing rights and the same task organization as the record."""
    organization = task_organization_for_user(user)
    return bool(
        settings.MEETING_SUMMARY_TASKS_ENABLED
        and can_edit(record, user)
        and record.organization_id == (organization.pk if organization else None)
    )


def serialize(link, user):
    """Record readers see conversion receipt, task details still require task access."""
    task = (
        filter_visible_task_hierarchy(
            models.Task.objects.filter(pk=link.task_id), user
        ).first()
        if link.task_id
        else None
    )
    return {
        "id": str(link.pk),
        "task_id": str(task.pk) if task else None,
        "status": task.status if task else None,
        "deleted": link.task_id is None,
        "review_id": str(link.review_id),
    }


@transaction.atomic
def convert(record_id, user, key, payload):
    """Serialize conversions per record; a deleted task is not silently recreated."""
    identity = models.MeetingRecord.objects.get(pk=record_id)
    if identity.meeting_session_id:
        models.MeetingSession.objects.select_for_update().get(
            pk=identity.meeting_session_id
        )
    record = models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    if not can_convert(record, user):
        raise PermissionError
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    replay = (
        models.MeetingSummaryTaskRequest.objects.select_related("link")
        .filter(author=user, key=key)
        .first()
    )
    if replay:
        if replay.link.record_id != record.pk or replay.request_hash != digest:
            raise RecordConflict("Conversion key has a different intent.")
        return replay.link, False
    review = record.summary_reviews.first()
    if review is None or str(review.pk) != payload["review_id"]:
        raise RecordConflict(
            "The human revision changed. Review the current action first."
        )
    points = review.content["action_items"]
    if payload["action_index"] >= len(points):
        raise ValueError("Unknown action.")
    point = points[payload["action_index"]]
    fingerprint = action_hash(point)
    existing = record.summary_task_links.filter(action_hash=fingerprint).first()
    if existing:
        # The caller must inspect the existing task instead of silently changing it.
        models.MeetingSummaryTaskRequest.objects.create(
            link=existing, author=user, key=key, request_hash=digest
        )
        return existing, False
    assignee = models.User.objects.filter(
        pk=payload["assignee_id"], is_active=True, is_device=False
    ).first()
    if assignee is None:
        raise ValueError("Assignee unavailable.")
    ensure_task_assignee_allowed(creator=user, assignee=assignee)
    title = payload["title"].strip()
    if not title:
        raise ValueError("Task title is required.")
    task = models.Task.objects.create(
        title=title,
        creator=user,
        organization_id=record.organization_id,
        assignee=assignee,
        due_date=payload["due_date"],
    )
    set_task_assignees(task, [assignee])
    record_task_created(task=task, actor=user)
    record_task_assignment(task=task, event=models.TaskImDelivery.Event.ASSIGNED)
    link = models.MeetingSummaryTaskLink.objects.create(
        record=record,
        review=review,
        action_index=payload["action_index"],
        action_hash=fingerprint,
        task=task,
        author=user,
        key=key,
        request_hash=digest,
        confirmed=payload,
    )
    models.MeetingSummaryTaskRequest.objects.create(
        link=link, author=user, key=key, request_hash=digest
    )
    return link, True
