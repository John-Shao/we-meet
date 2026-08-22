"""Append-only operation history for durable tasks."""

from dataclasses import dataclass
from datetime import date

from core import models


@dataclass(frozen=True)
class TaskHistorySnapshot:
    """The tracked state before one task update."""

    title: str
    description: str
    start_date: date | None
    due_date: date | None
    assignee: dict | None
    status: str
    priority: str
    labels: tuple[dict, ...]
    task_list: dict | None
    group: dict | None
    position: int


def snapshot_task(task: models.Task) -> TaskHistorySnapshot:
    """Capture the small set of fields represented in the activity timeline."""

    return TaskHistorySnapshot(
        title=task.title,
        description=task.description,
        start_date=task.start_date,
        due_date=task.due_date,
        assignee=_user_snapshot(task.assignee),
        status=task.status,
        priority=task.priority,
        labels=_label_snapshots(task.labels.all()),
        task_list=_task_list_snapshot(task.task_list),
        group=_task_group_snapshot(task.group),
        position=task.position,
    )


def record_task_created(*, task: models.Task, actor) -> models.TaskActivity:
    """Record one successful task creation."""

    return models.TaskActivity.objects.create(
        task=task,
        actor=actor,
        event=models.TaskActivity.Event.CREATED,
        changes={"assignee": _user_snapshot(task.assignee)},
    )


def record_task_changes(
    *,
    task: models.Task,
    actor,
    before: TaskHistorySnapshot,
) -> list[models.TaskActivity]:
    """Append one activity per changed concern after a successful update."""

    activities = []
    content_fields = []
    if task.title != before.title:
        content_fields.append("title")
    if task.description != before.description:
        content_fields.append("description")
    if content_fields:
        activities.append(
            _activity(
                task=task,
                actor=actor,
                event=models.TaskActivity.Event.CONTENT_CHANGED,
                changes={"fields": content_fields},
            )
        )

    date_changes = {}
    if task.start_date != before.start_date:
        date_changes["start_date"] = {
            "from": _date_value(before.start_date),
            "to": _date_value(task.start_date),
        }
    if task.due_date != before.due_date:
        date_changes["due_date"] = {
            "from": _date_value(before.due_date),
            "to": _date_value(task.due_date),
        }
    if date_changes:
        activities.append(
            _activity(
                task=task,
                actor=actor,
                event=models.TaskActivity.Event.DATES_CHANGED,
                changes={"dates": date_changes},
            )
        )

    assignee = _user_snapshot(task.assignee)
    if assignee != before.assignee:
        activities.append(
            _activity(
                task=task,
                actor=actor,
                event=models.TaskActivity.Event.ASSIGNEE_CHANGED,
                changes={"assignee": {"from": before.assignee, "to": assignee}},
            )
        )

    if task.status != before.status:
        activities.append(
            _activity(
                task=task,
                actor=actor,
                event=models.TaskActivity.Event.STATUS_CHANGED,
                changes={"status": {"from": before.status, "to": task.status}},
            )
        )

    if task.priority != before.priority:
        activities.append(
            _activity(
                task=task,
                actor=actor,
                event=models.TaskActivity.Event.PRIORITY_CHANGED,
                changes={"priority": {"from": before.priority, "to": task.priority}},
            )
        )

    labels = _label_snapshots(task.labels.all())
    if labels != before.labels:
        activities.append(
            _activity(
                task=task,
                actor=actor,
                event=models.TaskActivity.Event.LABELS_CHANGED,
                changes={"labels": {"from": before.labels, "to": labels}},
            )
        )

    task_list = _task_list_snapshot(task.task_list)
    group = _task_group_snapshot(task.group)
    if (
        task_list != before.task_list
        or group != before.group
        or task.position != before.position
    ):
        activities.append(
            _activity(
                task=task,
                actor=actor,
                event=models.TaskActivity.Event.PLACEMENT_CHANGED,
                changes={
                    "placement": {
                        "from": {
                            "task_list": before.task_list,
                            "group": before.group,
                            "position": before.position,
                        },
                        "to": {
                            "task_list": task_list,
                            "group": group,
                            "position": task.position,
                        },
                    }
                },
            )
        )

    return activities


def _activity(*, task, actor, event, changes) -> models.TaskActivity:
    return models.TaskActivity.objects.create(
        task=task,
        actor=actor,
        event=event,
        changes=changes,
    )


def _date_value(value: date | None) -> str | None:
    return value.isoformat() if value is not None else None


def _user_snapshot(user) -> dict | None:
    if user is None:
        return None
    return {
        "id": str(user.id),
        "name": (
            user.full_name or user.short_name or user.email or str(user.id)
        ).strip(),
    }


def _label_snapshots(labels) -> tuple[dict, ...]:
    return tuple(
        {
            "id": str(label.id),
            "name": label.name,
            "color": label.color,
        }
        for label in sorted(
            labels, key=lambda item: (item.name.casefold(), str(item.id))
        )
    )


def _task_list_snapshot(task_list) -> dict | None:
    if task_list is None:
        return None
    return {
        "id": str(task_list.id),
        "name": task_list.name,
        "color": task_list.color,
    }


def _task_group_snapshot(group) -> dict | None:
    if group is None:
        return None
    return {"id": str(group.id), "name": group.name}
