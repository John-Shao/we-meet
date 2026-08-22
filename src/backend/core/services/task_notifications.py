"""Reliable Task Assistant notifications."""

import json
import logging
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from core import models
from core.services import im_bots, im_cards
from core.services.jusi_im import JusiImAdminClient
from core.services.task_time import OPEN_TASK_STATUSES, local_date_for_user

logger = logging.getLogger(__name__)

# A claimed row is hidden from the recovery scan while one worker talks to IM.
# If that worker dies, the production maintenance CronJob can claim it again.
CLAIM_TTL = timedelta(minutes=2)
ASSIGNMENT_EVENTS = (
    models.TaskImDelivery.Event.ASSIGNED,
    models.TaskImDelivery.Event.REASSIGNED,
)
REMINDER_EVENTS = (
    models.TaskImDelivery.Event.STARTING,
    models.TaskImDelivery.Event.DUE_TODAY,
    models.TaskImDelivery.Event.OVERDUE,
)
DATE_CHANGE_EVENTS = (models.TaskImDelivery.Event.DATES_CHANGED,)
STATUS_CHANGE_EVENTS = (models.TaskImDelivery.Event.STATUS_CHANGED,)
PRIORITY_CHANGE_EVENTS = (models.TaskImDelivery.Event.PRIORITY_CHANGED,)


class TaskImNotificationUnavailable(RuntimeError):
    """Raised for configuration/provisioning gaps worth retrying later."""


def record_task_assignment(
    *, task: models.Task, event: str
) -> models.TaskImDelivery | None:
    """Persist and enqueue one assignment event after the surrounding commit.

    Self-assignment intentionally stays silent. Reassigning to self still
    supersedes a pending notification for the previous assignee.
    """

    pending = models.TaskImDelivery.objects.filter(
        task=task,
        status=models.TaskImDelivery.Status.PENDING,
    )
    pending.filter(event__in=ASSIGNMENT_EVENTS).exclude(
        recipient_id=task.assignee_id
    ).update(
        status=models.TaskImDelivery.Status.SUPERSEDED,
        next_attempt_at=None,
        last_error="",
    )
    pending.filter(event=models.TaskImDelivery.Event.COMMENTED).exclude(
        Q(recipient_id=task.creator_id) | Q(recipient_id=task.assignee_id)
    ).update(
        status=models.TaskImDelivery.Status.SUPERSEDED,
        next_attempt_at=None,
        last_error="",
    )
    pending.filter(event__in=REMINDER_EVENTS).exclude(
        recipient_id=task.assignee_id
    ).update(
        status=models.TaskImDelivery.Status.SUPERSEDED,
        next_attempt_at=None,
        last_error="",
    )
    pending.filter(event__in=DATE_CHANGE_EVENTS).exclude(
        recipient_id=task.assignee_id
    ).update(
        status=models.TaskImDelivery.Status.SUPERSEDED,
        next_attempt_at=None,
        last_error="",
    )
    pending.filter(event__in=STATUS_CHANGE_EVENTS).exclude(
        Q(recipient_id=task.creator_id) | Q(recipient_id=task.assignee_id)
    ).update(
        status=models.TaskImDelivery.Status.SUPERSEDED,
        next_attempt_at=None,
        last_error="",
    )
    pending.filter(event__in=PRIORITY_CHANGE_EVENTS).exclude(
        recipient_id=task.assignee_id
    ).update(
        status=models.TaskImDelivery.Status.SUPERSEDED,
        next_attempt_at=None,
        last_error="",
    )

    if task.assignee_id is None or task.assignee_id == task.creator_id:
        return None

    delivery = models.TaskImDelivery.objects.create(
        task=task,
        recipient_id=task.assignee_id,
        event=event,
        next_attempt_at=timezone.now(),
    )
    transaction.on_commit(lambda: _enqueue_delivery(delivery.id))
    return delivery


def record_task_comment(*, comment: models.TaskComment) -> models.TaskImDelivery | None:
    """Notify the other current collaborator about a newly posted comment."""

    task = comment.task
    if comment.author_id == task.creator_id:
        recipient_id = task.assignee_id
    elif comment.author_id == task.assignee_id:
        recipient_id = task.creator_id
    else:  # Defensive: the API only permits current collaborators to comment.
        return None

    if recipient_id is None or recipient_id == comment.author_id:
        return None

    delivery, created = models.TaskImDelivery.objects.get_or_create(
        task=task,
        comment=comment,
        recipient_id=recipient_id,
        defaults={
            "event": models.TaskImDelivery.Event.COMMENTED,
            "next_attempt_at": timezone.now(),
        },
    )
    if created:
        transaction.on_commit(lambda: _enqueue_delivery(delivery.id))
    return delivery


def record_task_date_change(
    *, activity: models.TaskActivity
) -> models.TaskImDelivery | None:
    """Notify the current assignee about the latest durable date-change snapshot."""

    if activity.event != models.TaskActivity.Event.DATES_CHANGED:
        raise ValueError("A date-change activity is required.")

    task = activity.task
    pending = models.TaskImDelivery.objects.filter(
        task=task,
        status=models.TaskImDelivery.Status.PENDING,
    )
    pending.filter(event__in=DATE_CHANGE_EVENTS).exclude(activity=activity).update(
        status=models.TaskImDelivery.Status.SUPERSEDED,
        next_attempt_at=None,
        last_error="",
    )
    _supersede_stale_reminders(pending=pending, task=task)

    if (
        task.assignee_id is None
        or task.assignee_id == activity.actor_id
        or task.status not in OPEN_TASK_STATUSES
    ):
        return None

    delivery, created = models.TaskImDelivery.objects.get_or_create(
        task=task,
        activity=activity,
        recipient_id=task.assignee_id,
        defaults={
            "event": models.TaskImDelivery.Event.DATES_CHANGED,
            "next_attempt_at": timezone.now(),
        },
    )
    if created:
        transaction.on_commit(lambda: _enqueue_delivery(delivery.id))
    return delivery


def record_task_status_change(
    *, activity: models.TaskActivity
) -> list[models.TaskImDelivery]:
    """Notify current collaborators about the latest durable status transition."""

    if activity.event != models.TaskActivity.Event.STATUS_CHANGED:
        raise ValueError("A status-change activity is required.")

    task = activity.task
    pending = models.TaskImDelivery.objects.filter(
        task=task,
        status=models.TaskImDelivery.Status.PENDING,
    )
    pending.filter(event__in=STATUS_CHANGE_EVENTS).exclude(activity=activity).update(
        status=models.TaskImDelivery.Status.SUPERSEDED,
        next_attempt_at=None,
        last_error="",
    )
    if task.status not in OPEN_TASK_STATUSES:
        pending.filter(event__in=DATE_CHANGE_EVENTS + REMINDER_EVENTS).update(
            status=models.TaskImDelivery.Status.SUPERSEDED,
            next_attempt_at=None,
            last_error="",
        )

    recipient_ids = {
        recipient_id
        for recipient_id in (task.creator_id, task.assignee_id)
        if recipient_id is not None and recipient_id != activity.actor_id
    }
    deliveries = []
    for recipient_id in recipient_ids:
        delivery, created = models.TaskImDelivery.objects.get_or_create(
            task=task,
            activity=activity,
            recipient_id=recipient_id,
            defaults={
                "event": models.TaskImDelivery.Event.STATUS_CHANGED,
                "next_attempt_at": timezone.now(),
            },
        )
        deliveries.append(delivery)
        if created:
            transaction.on_commit(lambda pk=delivery.id: _enqueue_delivery(pk))
    return deliveries


def record_task_priority_change(
    *, activity: models.TaskActivity
) -> models.TaskImDelivery | None:
    """Notify the current assignee about the latest priority change."""

    if activity.event != models.TaskActivity.Event.PRIORITY_CHANGED:
        raise ValueError("A priority-change activity is required.")

    task = activity.task
    pending = models.TaskImDelivery.objects.filter(
        task=task,
        status=models.TaskImDelivery.Status.PENDING,
    )
    pending.filter(event__in=PRIORITY_CHANGE_EVENTS).exclude(activity=activity).update(
        status=models.TaskImDelivery.Status.SUPERSEDED,
        next_attempt_at=None,
        last_error="",
    )

    if task.assignee_id is None or task.assignee_id == activity.actor_id:
        return None

    delivery, created = models.TaskImDelivery.objects.get_or_create(
        task=task,
        activity=activity,
        recipient_id=task.assignee_id,
        defaults={
            "event": models.TaskImDelivery.Event.PRIORITY_CHANGED,
            "next_attempt_at": timezone.now(),
        },
    )
    if created:
        transaction.on_commit(lambda: _enqueue_delivery(delivery.id))
    return delivery


def _supersede_stale_reminders(*, pending, task: models.Task) -> None:
    starting = pending.filter(event=models.TaskImDelivery.Event.STARTING)
    if task.start_date is None or task.start_date == task.due_date:
        starting.update(
            status=models.TaskImDelivery.Status.SUPERSEDED,
            next_attempt_at=None,
            last_error="",
        )
    else:
        starting.exclude(reference_date=task.start_date).update(
            status=models.TaskImDelivery.Status.SUPERSEDED,
            next_attempt_at=None,
            last_error="",
        )

    due = pending.filter(
        event__in=(
            models.TaskImDelivery.Event.DUE_TODAY,
            models.TaskImDelivery.Event.OVERDUE,
        )
    )
    if task.due_date is None:
        due.update(
            status=models.TaskImDelivery.Status.SUPERSEDED,
            next_attempt_at=None,
            last_error="",
        )
    else:
        due.exclude(reference_date=task.due_date).update(
            status=models.TaskImDelivery.Status.SUPERSEDED,
            next_attempt_at=None,
            last_error="",
        )


def record_due_task_reminders(*, now=None) -> int:
    """Create today's missing reminder ledger rows in each assignee's timezone."""

    created_count = 0
    tasks = (
        models.Task.objects.filter(
            status__in=OPEN_TASK_STATUSES,
            assignee__isnull=False,
            assignee__is_active=True,
        )
        .filter(Q(start_date__isnull=False) | Q(due_date__isnull=False))
        .select_related("assignee")
    )
    for task in tasks.iterator():
        today = local_date_for_user(task.assignee, now=now)
        reminders = []
        # A one-day task gets the more urgent due reminder instead of two cards.
        if task.start_date == today and task.due_date != today:
            reminders.append((models.TaskImDelivery.Event.STARTING, task.start_date))
        if task.due_date == today:
            reminders.append((models.TaskImDelivery.Event.DUE_TODAY, task.due_date))
        elif task.due_date is not None and task.due_date < today:
            reminders.append((models.TaskImDelivery.Event.OVERDUE, task.due_date))

        for event, reference_date in reminders:
            delivery, created = models.TaskImDelivery.objects.get_or_create(
                task=task,
                recipient_id=task.assignee_id,
                event=event,
                reference_date=reference_date,
                defaults={"next_attempt_at": timezone.now()},
            )
            if created:
                created_count += 1
                transaction.on_commit(lambda pk=delivery.id: _enqueue_delivery(pk))
    return created_count


def _enqueue_delivery(delivery_id) -> bool:
    """Publish without turning an already-committed task into an API error."""

    from core.tasks.task_notifications import (  # noqa: PLC0415 - avoid task cycle
        deliver_task_assignment,
    )

    try:
        deliver_task_assignment.apply_async(args=[str(delivery_id)])
    except Exception:  # pragma: no cover - broker outage is recovered by the scan
        logger.exception("Failed to enqueue task IM delivery %s", delivery_id)
        return False
    return True


def enqueue_due_task_assignments(*, limit: int = 100) -> int:
    """Recover pending rows whose original publish/retry may have been lost."""

    delivery_ids = list(
        models.TaskImDelivery.objects.filter(
            status=models.TaskImDelivery.Status.PENDING,
            next_attempt_at__lte=timezone.now(),
        )
        .order_by("next_attempt_at", "created_at")
        .values_list("id", flat=True)[:limit]
    )
    return sum(_enqueue_delivery(delivery_id) for delivery_id in delivery_ids)


def claim_task_assignment(delivery_id) -> models.TaskImDelivery | None:
    """Atomically claim a due row so duplicate Celery jobs cannot both send it."""

    now = timezone.now()
    claimed = models.TaskImDelivery.objects.filter(
        pk=delivery_id,
        status=models.TaskImDelivery.Status.PENDING,
        next_attempt_at__lte=now + timedelta(seconds=2),
    ).update(
        attempt_count=F("attempt_count") + 1,
        next_attempt_at=now + CLAIM_TTL,
    )
    if not claimed:
        return None

    delivery = (
        models.TaskImDelivery.objects.select_related(
            "recipient",
            "task__creator",
            "task__assignee",
            "task__source_action_item__room",
            "comment__author",
            "activity__actor",
        )
        .filter(pk=delivery_id)
        .first()
    )
    if delivery is None:
        return None
    if not _recipient_can_receive(delivery):
        models.TaskImDelivery.objects.filter(pk=delivery.pk).update(
            status=models.TaskImDelivery.Status.SUPERSEDED,
            next_attempt_at=None,
            last_error="",
        )
        return None
    return delivery


def deliver_claimed_task_assignment(delivery: models.TaskImDelivery) -> None:
    """Send one already-claimed row and mark it delivered."""

    cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None) or {}
    if not cfg.get("api_url") or not cfg.get("admin_hmac_secret"):
        raise TaskImNotificationUnavailable("JUSI IM configuration is incomplete")

    assistant = im_bots.get_builtin(im_bots.BOT_TASK_ASSISTANT)
    if assistant is None:
        raise TaskImNotificationUnavailable("Task Assistant is unavailable")

    client = JusiImAdminClient(
        api_url=str(cfg["api_url"]),
        admin_hmac_secret=str(cfg["admin_hmac_secret"]),
        timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
    )
    result = im_bots.post_direct(
        client,
        assistant,
        delivery.recipient,
        json.dumps(_notification_card(delivery), ensure_ascii=False),
        content_type=im_cards.RICH_CARD,
    )
    if result is None:
        raise TaskImNotificationUnavailable("IM uid is unavailable")

    cid, _message = result
    models.TaskImDelivery.objects.filter(
        pk=delivery.pk,
        status=models.TaskImDelivery.Status.PENDING,
    ).update(
        status=models.TaskImDelivery.Status.DELIVERED,
        conversation_id=cid,
        delivered_at=timezone.now(),
        next_attempt_at=None,
        last_error="",
    )


def mark_task_assignment_retry(
    delivery: models.TaskImDelivery, *, error: Exception, delay_seconds: int
) -> None:
    """Keep a failed attempt pending until its next backoff window."""

    models.TaskImDelivery.objects.filter(
        pk=delivery.pk,
        status=models.TaskImDelivery.Status.PENDING,
    ).update(
        next_attempt_at=timezone.now() + timedelta(seconds=delay_seconds),
        last_error=str(error)[:2000],
    )


def mark_task_assignment_failed(
    delivery: models.TaskImDelivery, *, error: Exception
) -> None:
    """Stop automatic attempts while retaining an operations-visible ledger."""

    models.TaskImDelivery.objects.filter(
        pk=delivery.pk,
        status=models.TaskImDelivery.Status.PENDING,
    ).update(
        status=models.TaskImDelivery.Status.FAILED,
        next_attempt_at=None,
        last_error=str(error)[:2000],
    )


def _assignment_card(delivery: models.TaskImDelivery) -> dict:
    task = delivery.task
    reassigned = delivery.event == models.TaskImDelivery.Event.REASSIGNED
    heading = "任务已转交给你" if reassigned else "你收到一个新任务"
    blocks = [
        {
            "type": im_cards.CARD_BLOCK_TEXT,
            "spans": [{"tag": im_cards.RICH_TAG_TEXT, "text": task.title, "b": True}],
        }
    ]
    if task.description.strip():
        blocks.append(
            {
                "type": im_cards.CARD_BLOCK_TEXT,
                "spans": [
                    {
                        "tag": im_cards.RICH_TAG_TEXT,
                        "text": task.description.strip()[:500],
                    }
                ],
            }
        )

    fields = [{"label": "创建人", "value": _display_name(task.creator)}]
    if task.priority != models.Task.Priority.NONE:
        fields.append({"label": "优先级", "value": _priority_label(task.priority)})
    if task.start_date is not None:
        fields.append({"label": "开始日期", "value": task.start_date.isoformat()})
    if task.due_date is not None:
        fields.append({"label": "截止日期", "value": task.due_date.isoformat()})
    source = getattr(task, "source_action_item", None)
    if source is not None:
        fields.append({"label": "来源会议", "value": source.room.name})
    blocks.append({"type": im_cards.CARD_BLOCK_FIELDS, "items": fields})

    base_url = str(getattr(settings, "APPLICATION_BASE_URL", "") or "").rstrip("/")
    if base_url:
        blocks.append(
            {
                "type": im_cards.CARD_BLOCK_ACTIONS,
                "resolve": im_cards.CARD_RESOLVE_EACH,
                "buttons": [
                    {
                        "id": "open-task-center",
                        "text": "查看任务",
                        "style": "primary",
                        "action": "url",
                        "url": f"{base_url}/tasks",
                    }
                ],
            }
        )
    return im_cards.build_rich_card(
        header={"title": heading, "theme": "warning" if reassigned else "info"},
        blocks=blocks,
        plain=f"{heading}：{task.title}",
    )


def _comment_card(delivery: models.TaskImDelivery) -> dict:
    task = delivery.task
    comment = delivery.comment
    author_name = _display_name(comment.author)
    blocks = [
        {
            "type": im_cards.CARD_BLOCK_TEXT,
            "spans": [{"tag": im_cards.RICH_TAG_TEXT, "text": task.title, "b": True}],
        },
        {
            "type": im_cards.CARD_BLOCK_TEXT,
            "spans": [
                {
                    "tag": im_cards.RICH_TAG_TEXT,
                    "text": comment.content.strip()[:500],
                }
            ],
        },
        {
            "type": im_cards.CARD_BLOCK_FIELDS,
            "items": [{"label": "评论人", "value": author_name}],
        },
    ]
    base_url = str(getattr(settings, "APPLICATION_BASE_URL", "") or "").rstrip("/")
    if base_url:
        blocks.append(
            {
                "type": im_cards.CARD_BLOCK_ACTIONS,
                "resolve": im_cards.CARD_RESOLVE_EACH,
                "buttons": [
                    {
                        "id": "open-task-comment",
                        "text": "查看评论",
                        "style": "primary",
                        "action": "url",
                        "url": f"{base_url}/tasks",
                    }
                ],
            }
        )
    return im_cards.build_rich_card(
        header={"title": "任务有新评论", "theme": "info"},
        blocks=blocks,
        plain=f"{author_name} 评论了任务：{task.title}",
    )


def _reminder_card(delivery: models.TaskImDelivery) -> dict:
    task = delivery.task
    presentation = {
        models.TaskImDelivery.Event.STARTING: ("任务今天开始", "info"),
        models.TaskImDelivery.Event.DUE_TODAY: ("任务今天截止", "warning"),
        models.TaskImDelivery.Event.OVERDUE: ("任务已逾期", "danger"),
    }
    heading, theme = presentation[delivery.event]
    fields = []
    if task.priority != models.Task.Priority.NONE:
        fields.append({"label": "优先级", "value": _priority_label(task.priority)})
    if task.start_date is not None:
        fields.append({"label": "开始日期", "value": task.start_date.isoformat()})
    if task.due_date is not None:
        fields.append({"label": "截止日期", "value": task.due_date.isoformat()})
    blocks = [
        {
            "type": im_cards.CARD_BLOCK_TEXT,
            "spans": [{"tag": im_cards.RICH_TAG_TEXT, "text": task.title, "b": True}],
        },
        {"type": im_cards.CARD_BLOCK_FIELDS, "items": fields},
    ]
    base_url = str(getattr(settings, "APPLICATION_BASE_URL", "") or "").rstrip("/")
    if base_url:
        blocks.append(
            {
                "type": im_cards.CARD_BLOCK_ACTIONS,
                "resolve": im_cards.CARD_RESOLVE_EACH,
                "buttons": [
                    {
                        "id": "open-task-reminder",
                        "text": "查看任务",
                        "style": "primary",
                        "action": "url",
                        "url": f"{base_url}/tasks",
                    }
                ],
            }
        )
    return im_cards.build_rich_card(
        header={"title": heading, "theme": theme},
        blocks=blocks,
        plain=f"{heading}：{task.title}",
    )


def _date_change_card(delivery: models.TaskImDelivery) -> dict:
    task = delivery.task
    activity = delivery.activity
    date_changes = activity.changes.get("dates", {})
    blocks = [
        {
            "type": im_cards.CARD_BLOCK_TEXT,
            "spans": [{"tag": im_cards.RICH_TAG_TEXT, "text": task.title, "b": True}],
        }
    ]
    for field_name, label in (
        ("start_date", "开始日期"),
        ("due_date", "截止日期"),
    ):
        change = date_changes.get(field_name)
        if change:
            before = change.get("from") or "未设置"
            after = change.get("to") or "未设置"
            blocks.append(
                {
                    "type": im_cards.CARD_BLOCK_FIELDS,
                    "items": [{"label": label, "value": f"{before} → {after}"}],
                }
            )
    blocks.append(
        {
            "type": im_cards.CARD_BLOCK_FIELDS,
            "items": [
                {"label": "修改人", "value": _display_name(activity.actor)},
            ],
        }
    )
    base_url = str(getattr(settings, "APPLICATION_BASE_URL", "") or "").rstrip("/")
    if base_url:
        blocks.append(
            {
                "type": im_cards.CARD_BLOCK_ACTIONS,
                "resolve": im_cards.CARD_RESOLVE_EACH,
                "buttons": [
                    {
                        "id": "open-task-date-change",
                        "text": "查看任务",
                        "style": "primary",
                        "action": "url",
                        "url": f"{base_url}/tasks",
                    }
                ],
            }
        )
    return im_cards.build_rich_card(
        header={"title": "任务日期已调整", "theme": "warning"},
        blocks=blocks,
        plain=f"任务日期已调整：{task.title}",
    )


def _status_change_card(delivery: models.TaskImDelivery) -> dict:
    task = delivery.task
    activity = delivery.activity
    status_change = activity.changes.get("status", {})
    labels = {
        models.Task.Status.TODO: "待处理",
        models.Task.Status.IN_PROGRESS: "进行中",
        models.Task.Status.COMPLETED: "已完成",
        models.Task.Status.CANCELED: "已取消",
    }
    presentation = {
        models.Task.Status.TODO: ("任务已重新打开", "info"),
        models.Task.Status.IN_PROGRESS: ("任务已开始处理", "info"),
        models.Task.Status.COMPLETED: ("任务已完成", "success"),
        models.Task.Status.CANCELED: ("任务已取消", "warning"),
    }
    before = status_change.get("from")
    after = status_change.get("to")
    heading, theme = presentation.get(after, ("任务状态已更新", "info"))
    fields = [
        {
            "label": "状态",
            "value": f"{labels.get(before, before or '未知')} → "
            f"{labels.get(after, after or '未知')}",
        },
        {"label": "操作人", "value": _display_name(activity.actor)},
    ]
    if activity.changes.get("source_action_item_origin"):
        fields.append({"label": "来源", "value": "会议行动项"})
    blocks = [
        {
            "type": im_cards.CARD_BLOCK_TEXT,
            "spans": [{"tag": im_cards.RICH_TAG_TEXT, "text": task.title, "b": True}],
        },
        {"type": im_cards.CARD_BLOCK_FIELDS, "items": fields},
    ]
    base_url = str(getattr(settings, "APPLICATION_BASE_URL", "") or "").rstrip("/")
    if base_url:
        blocks.append(
            {
                "type": im_cards.CARD_BLOCK_ACTIONS,
                "resolve": im_cards.CARD_RESOLVE_EACH,
                "buttons": [
                    {
                        "id": "open-task-status-change",
                        "text": "查看任务",
                        "style": "primary",
                        "action": "url",
                        "url": f"{base_url}/tasks",
                    }
                ],
            }
        )
    return im_cards.build_rich_card(
        header={"title": heading, "theme": theme},
        blocks=blocks,
        plain=f"{heading}：{task.title}",
    )


def _priority_change_card(delivery: models.TaskImDelivery) -> dict:
    task = delivery.task
    activity = delivery.activity
    priority_change = activity.changes.get("priority", {})
    before = priority_change.get("from")
    after = priority_change.get("to")
    blocks = [
        {
            "type": im_cards.CARD_BLOCK_TEXT,
            "spans": [{"tag": im_cards.RICH_TAG_TEXT, "text": task.title, "b": True}],
        },
        {
            "type": im_cards.CARD_BLOCK_FIELDS,
            "items": [
                {
                    "label": "优先级",
                    "value": f"{_priority_label(before)} → {_priority_label(after)}",
                },
                {"label": "修改人", "value": _display_name(activity.actor)},
            ],
        },
    ]
    base_url = str(getattr(settings, "APPLICATION_BASE_URL", "") or "").rstrip("/")
    if base_url:
        blocks.append(
            {
                "type": im_cards.CARD_BLOCK_ACTIONS,
                "resolve": im_cards.CARD_RESOLVE_EACH,
                "buttons": [
                    {
                        "id": "open-task-priority-change",
                        "text": "查看任务",
                        "style": "primary",
                        "action": "url",
                        "url": f"{base_url}/tasks",
                    }
                ],
            }
        )
    return im_cards.build_rich_card(
        header={"title": "任务优先级已调整", "theme": "warning"},
        blocks=blocks,
        plain=f"任务优先级已调整：{task.title}",
    )


def _notification_card(delivery: models.TaskImDelivery) -> dict:
    if delivery.event == models.TaskImDelivery.Event.COMMENTED:
        return _comment_card(delivery)
    if delivery.event == models.TaskImDelivery.Event.DATES_CHANGED:
        return _date_change_card(delivery)
    if delivery.event == models.TaskImDelivery.Event.STATUS_CHANGED:
        return _status_change_card(delivery)
    if delivery.event == models.TaskImDelivery.Event.PRIORITY_CHANGED:
        return _priority_change_card(delivery)
    if delivery.event in REMINDER_EVENTS:
        return _reminder_card(delivery)
    return _assignment_card(delivery)


def _recipient_can_receive(delivery: models.TaskImDelivery) -> bool:
    task = delivery.task
    if delivery.event in ASSIGNMENT_EVENTS:
        allowed = task.assignee_id == delivery.recipient_id
    elif delivery.event == models.TaskImDelivery.Event.COMMENTED:
        comment = delivery.comment
        allowed = bool(
            comment is not None
            and delivery.recipient_id in {task.creator_id, task.assignee_id}
            and delivery.recipient_id != comment.author_id
        )
    elif delivery.event == models.TaskImDelivery.Event.DATES_CHANGED:
        activity = delivery.activity
        allowed = bool(
            activity is not None
            and activity.task_id == task.id
            and activity.event == models.TaskActivity.Event.DATES_CHANGED
            and task.assignee_id == delivery.recipient_id
            and activity.actor_id != delivery.recipient_id
            and task.status in OPEN_TASK_STATUSES
            and _date_change_matches_task(activity=activity, task=task)
        )
    elif delivery.event == models.TaskImDelivery.Event.STATUS_CHANGED:
        activity = delivery.activity
        allowed = bool(
            activity is not None
            and activity.task_id == task.id
            and activity.event == models.TaskActivity.Event.STATUS_CHANGED
            and delivery.recipient_id in {task.creator_id, task.assignee_id}
            and activity.actor_id != delivery.recipient_id
            and _status_change_matches_task(activity=activity, task=task)
        )
    elif delivery.event == models.TaskImDelivery.Event.PRIORITY_CHANGED:
        activity = delivery.activity
        allowed = bool(
            activity is not None
            and activity.task_id == task.id
            and activity.event == models.TaskActivity.Event.PRIORITY_CHANGED
            and task.assignee_id == delivery.recipient_id
            and activity.actor_id != delivery.recipient_id
            and _priority_change_matches_task(activity=activity, task=task)
        )
    elif delivery.event in REMINDER_EVENTS:
        if (
            task.assignee_id != delivery.recipient_id
            or task.status not in OPEN_TASK_STATUSES
            or delivery.reference_date is None
        ):
            allowed = False
        else:
            today = local_date_for_user(delivery.recipient)
            if delivery.event == models.TaskImDelivery.Event.STARTING:
                allowed = (
                    task.start_date == delivery.reference_date == today
                    and task.due_date != today
                )
            elif delivery.event == models.TaskImDelivery.Event.DUE_TODAY:
                allowed = task.due_date == delivery.reference_date == today
            else:
                allowed = (
                    task.due_date == delivery.reference_date and task.due_date < today
                )
    else:
        allowed = False
    return allowed


def _date_change_matches_task(
    *, activity: models.TaskActivity, task: models.Task
) -> bool:
    date_changes = activity.changes.get("dates", {})
    if not date_changes:
        return False
    for field_name in ("start_date", "due_date"):
        change = date_changes.get(field_name)
        if change is None:
            continue
        current = getattr(task, field_name)
        current_value = current.isoformat() if current is not None else None
        if current_value != change.get("to"):
            return False
    return True


def _status_change_matches_task(
    *, activity: models.TaskActivity, task: models.Task
) -> bool:
    status_change = activity.changes.get("status", {})
    return bool(status_change and task.status == status_change.get("to"))


def _priority_change_matches_task(
    *, activity: models.TaskActivity, task: models.Task
) -> bool:
    priority_change = activity.changes.get("priority", {})
    return bool(priority_change and task.priority == priority_change.get("to"))


def _priority_label(value: str | None) -> str:
    return {
        models.Task.Priority.NONE: "无优先级",
        models.Task.Priority.LOW: "低",
        models.Task.Priority.MEDIUM: "中",
        models.Task.Priority.HIGH: "高",
        models.Task.Priority.URGENT: "紧急",
    }.get(value, value or "未知")


def _display_name(user) -> str:
    if user is None:
        return ""
    return (user.full_name or user.short_name or user.email or "").strip()
