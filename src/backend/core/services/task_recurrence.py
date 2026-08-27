"""Recurring-task rules and idempotent instance materialization."""

import calendar
from datetime import date, timedelta
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone

from core import models
from core.services.task_assignees import set_task_assignees
from core.services.task_history import record_task_created
from core.services.task_notifications import record_task_assignment


class TaskRecurrenceError(ValueError):
    """A stable recurrence validation or materialization failure."""

    def __init__(self, message, *, code="task_recurrence_invalid"):
        self.code = code
        super().__init__(message)


def _is_month_end(value: date) -> bool:
    return value.day == calendar.monthrange(value.year, value.month)[1]


def _anchor_for_task(task) -> date:
    if task.due_date is not None:
        return task.due_date
    if task.start_date is not None:
        return task.start_date
    return timezone.localdate(
        timezone.now(), timezone=ZoneInfo(str(task.creator.timezone))
    )


def _date_offset(value: date | None, anchor: date) -> int | None:
    return (value - anchor).days if value is not None else None


def next_occurrence_date(rule, current: date) -> date:
    """Advance without drifting a month-end anchor through short months."""

    if rule.frequency == models.TaskRecurrenceRule.Frequency.DAILY:
        return current + timedelta(days=rule.interval)
    if rule.frequency == models.TaskRecurrenceRule.Frequency.WEEKLY:
        return current + timedelta(days=7 * rule.interval)
    month_index = current.year * 12 + current.month - 1 + rule.interval
    year, zero_based_month = divmod(month_index, 12)
    month = zero_based_month + 1
    last_day = calendar.monthrange(year, month)[1]
    day = last_day if rule.anchor_is_month_end else min(rule.anchor_day, last_day)
    return date(year, month, day)


def _next_allowed(rule, occurrence: date) -> bool:
    if rule.end_date is not None and occurrence > rule.end_date:
        return False
    if (
        rule.max_occurrences is not None
        and rule.generated_count >= rule.max_occurrences
    ):
        return False
    return True


def _sync_template(rule, task) -> None:
    anchor = _anchor_for_task(task)
    rule.template_title = task.title
    rule.template_description = task.description
    rule.template_priority = task.priority
    rule.template_start_offset_days = _date_offset(task.start_date, anchor)
    rule.template_due_offset_days = _date_offset(task.due_date, anchor)
    rule.task_list = task.task_list
    rule.group = task.group
    rule.template_assignee = task.assignee


def _validate_task_can_repeat(task) -> None:
    if task.source_action_item_id is not None:
        raise TaskRecurrenceError(
            "Meeting action-item tasks cannot repeat.",
            code="task_recurrence_action_item_forbidden",
        )
    if task.parent_id is not None or task.subtasks.exists():
        raise TaskRecurrenceError(
            "A recurring task must be a standalone hierarchy root.",
            code="task_recurrence_hierarchy_forbidden",
        )


@transaction.atomic
def create_task_recurrence_rule(*, task, owner, recurrence):
    """Attach a new rule to an existing first instance."""

    task = (
        models.Task.objects.select_for_update(of=("self",))
        .select_related("creator", "task_list", "group", "assignee")
        .prefetch_related("assignees", "followers")
        .get(pk=task.pk)
    )
    _validate_task_can_repeat(task)
    if task.recurrence_rule_id is not None:
        raise TaskRecurrenceError(
            "This task already belongs to a recurrence rule.",
            code="task_recurrence_exists",
        )
    anchor = _anchor_for_task(task)
    max_occurrences = recurrence.get("max_occurrences")
    if max_occurrences is not None and max_occurrences < 1:
        raise TaskRecurrenceError("Maximum occurrences must include this task.")
    end_date = recurrence.get("end_date")
    if end_date is not None and end_date < anchor:
        raise TaskRecurrenceError("End date cannot be earlier than the first task.")
    rule = models.TaskRecurrenceRule(
        owner=owner,
        organization=task.organization,
        frequency=recurrence["frequency"],
        interval=recurrence.get("interval", 1),
        timezone=owner.timezone,
        schedule_anchor_date=anchor,
        anchor_day=anchor.day,
        anchor_is_month_end=_is_month_end(anchor),
        end_date=end_date,
        max_occurrences=max_occurrences,
        generated_count=1,
    )
    _sync_template(rule, task)
    following = next_occurrence_date(rule, anchor)
    if _next_allowed(rule, following):
        rule.next_occurrence_date = following
    else:
        rule.next_occurrence_date = None
        rule.is_active = False
    rule.save()
    assignees = list(task.assignees.all()) or ([task.assignee] if task.assignee else [])
    rule.assignees.set(assignees)
    rule.followers.set(task.followers.all())
    task.recurrence_rule = rule
    task.recurrence_key = anchor
    task.recurrence_sequence = 1
    task.save(
        update_fields=[
            "recurrence_rule",
            "recurrence_key",
            "recurrence_sequence",
            "updated_at",
        ]
    )
    models.TaskActivity.objects.create(
        task=task,
        actor=owner,
        event=models.TaskActivity.Event.RECURRENCE_CHANGED,
        changes={"recurrence": {"action": "created", "rule_id": str(rule.pk)}},
    )
    return rule


def _generation_error(rule, code: str) -> None:
    rule.is_active = False
    rule.last_error = code
    rule.next_occurrence_date = None
    rule.save(
        update_fields=["is_active", "last_error", "next_occurrence_date", "updated_at"]
    )


def _active_rule_assignees(rule):
    assignees = list(rule.assignees.all())
    if not assignees or any(not user.is_active for user in assignees):
        return None
    if rule.organization_id is not None:
        active_ids = set(
            models.Membership.objects.filter(
                organization_id=rule.organization_id,
                user_id__in=[user.pk for user in assignees],
                status=models.MembershipStatusChoices.ACTIVE,
            ).values_list("user_id", flat=True)
        )
        if active_ids != {user.pk for user in assignees}:
            return None
    return assignees


@transaction.atomic
def materialize_task_recurrence(  # noqa: PLR0911 - explicit terminal states
    rule_id, *, force=False, today=None
):
    """Create exactly one next instance and atomically advance its rule."""

    rule = (
        models.TaskRecurrenceRule.objects.select_for_update(of=("self",))
        .select_related(
            "owner", "organization", "task_list", "group", "template_assignee"
        )
        .prefetch_related("assignees", "followers")
        .get(pk=rule_id)
    )
    occurrence = rule.next_occurrence_date
    if not rule.is_active or occurrence is None:
        return None, False
    local_today = today or timezone.localdate(
        timezone.now(), timezone=ZoneInfo(str(rule.timezone))
    )
    if not force and occurrence > local_today:
        return None, False
    if not _next_allowed(rule, occurrence):
        rule.is_active = False
        rule.next_occurrence_date = None
        rule.save(update_fields=["is_active", "next_occurrence_date", "updated_at"])
        return None, False
    if not rule.owner.is_active:
        _generation_error(rule, "owner_inactive")
        return None, False
    if rule.task_list_id is not None and rule.task_list.is_archived:
        _generation_error(rule, "task_list_archived")
        return None, False
    assignees = _active_rule_assignees(rule)
    if assignees is None:
        _generation_error(rule, "assignee_inactive")
        return None, False
    primary = rule.template_assignee
    if primary is None or primary.pk not in {user.pk for user in assignees}:
        primary = assignees[0]
    sequence = rule.generated_count + 1
    offsets = {
        "start_date": (
            occurrence + timedelta(days=rule.template_start_offset_days)
            if rule.template_start_offset_days is not None
            else None
        ),
        "due_date": (
            occurrence + timedelta(days=rule.template_due_offset_days)
            if rule.template_due_offset_days is not None
            else None
        ),
    }
    task, created = models.Task.objects.get_or_create(
        recurrence_rule=rule,
        recurrence_key=occurrence,
        defaults={
            "recurrence_sequence": sequence,
            "title": rule.template_title,
            "description": rule.template_description,
            "creator": rule.owner,
            "organization": rule.organization,
            "assignee": primary,
            "status": models.Task.Status.TODO,
            "priority": rule.template_priority,
            "task_list": rule.task_list,
            "group": rule.group,
            **offsets,
        },
    )
    if created:
        set_task_assignees(task, assignees)
        task.followers.set(rule.followers.all())
        record_task_created(task=task, actor=rule.owner)
        record_task_assignment(
            task=task,
            event=models.TaskImDelivery.Event.ASSIGNED,
        )
    rule.generated_count = max(
        rule.generated_count, task.recurrence_sequence or sequence
    )
    following = next_occurrence_date(rule, occurrence)
    if _next_allowed(rule, following):
        rule.next_occurrence_date = following
    else:
        rule.next_occurrence_date = None
        rule.is_active = False
    rule.last_error = ""
    rule.save(
        update_fields=[
            "generated_count",
            "next_occurrence_date",
            "is_active",
            "last_error",
            "updated_at",
        ]
    )
    return task, created


def materialize_due_task_recurrences(*, now=None) -> int:
    """Catch up all rules due in their owners' local date, without duplicates."""

    current = now or timezone.now()
    created_count = 0
    rule_ids = list(
        models.TaskRecurrenceRule.objects.filter(
            is_active=True,
            next_occurrence_date__isnull=False,
        ).values_list("id", flat=True)
    )
    for rule_id in rule_ids:
        for _attempt in range(1000):
            rule = models.TaskRecurrenceRule.objects.only(
                "is_active", "next_occurrence_date", "timezone"
            ).get(pk=rule_id)
            if not rule.is_active or rule.next_occurrence_date is None:
                break
            local_today = timezone.localdate(
                current, timezone=ZoneInfo(str(rule.timezone))
            )
            if rule.next_occurrence_date > local_today:
                break
            _task, created = materialize_task_recurrence(rule_id, today=local_today)
            created_count += int(created)
            if _task is None:
                break
    return created_count


@transaction.atomic
def update_task_recurrence_rule(*, task, actor, recurrence=None, reset_schedule=False):
    """Update the current-and-following template; history remains untouched."""

    if task.recurrence_rule_id is None:
        if recurrence is None:
            raise TaskRecurrenceError("This task is not recurring.")
        return create_task_recurrence_rule(
            task=task, owner=actor, recurrence=recurrence
        )
    rule = models.TaskRecurrenceRule.objects.select_for_update().get(
        pk=task.recurrence_rule_id
    )
    if rule.owner_id != actor.id:
        raise TaskRecurrenceError(
            "Only the recurrence owner can change this rule.",
            code="task_recurrence_forbidden",
        )
    old_anchor = rule.schedule_anchor_date
    if recurrence is not None:
        for field in ("frequency", "interval", "end_date", "max_occurrences"):
            if field in recurrence:
                setattr(rule, field, recurrence[field])
        if (
            rule.max_occurrences is not None
            and rule.max_occurrences < rule.generated_count
        ):
            raise TaskRecurrenceError(
                "Maximum occurrences cannot be below the generated count."
            )
        reset_schedule = True
    _sync_template(rule, task)
    anchor = _anchor_for_task(task)
    if reset_schedule or anchor != old_anchor:
        rule.schedule_anchor_date = anchor
        rule.anchor_day = anchor.day
        rule.anchor_is_month_end = _is_month_end(anchor)
        following = next_occurrence_date(rule, anchor)
        rule.next_occurrence_date = (
            following if _next_allowed(rule, following) else None
        )
    rule.is_active = rule.next_occurrence_date is not None
    rule.last_error = ""
    rule.save()
    assignees = list(task.assignees.all()) or ([task.assignee] if task.assignee else [])
    rule.assignees.set(assignees)
    rule.followers.set(task.followers.all())
    models.TaskActivity.objects.create(
        task=task,
        actor=actor,
        event=models.TaskActivity.Event.RECURRENCE_CHANGED,
        changes={"recurrence": {"action": "updated", "rule_id": str(rule.pk)}},
    )
    return rule


@transaction.atomic
def deactivate_task_recurrence_rule(*, task, actor):
    if task.recurrence_rule_id is None:
        return None
    rule = models.TaskRecurrenceRule.objects.select_for_update().get(
        pk=task.recurrence_rule_id
    )
    if rule.owner_id != actor.id:
        raise TaskRecurrenceError(
            "Only the recurrence owner can stop this rule.",
            code="task_recurrence_forbidden",
        )
    rule.is_active = False
    rule.next_occurrence_date = None
    rule.last_error = ""
    rule.save(
        update_fields=["is_active", "next_occurrence_date", "last_error", "updated_at"]
    )
    models.TaskActivity.objects.create(
        task=task,
        actor=actor,
        event=models.TaskActivity.Event.RECURRENCE_CHANGED,
        changes={"recurrence": {"action": "deactivated", "rule_id": str(rule.pk)}},
    )
    return rule
