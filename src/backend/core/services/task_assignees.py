"""Shared multi-assignee task helpers."""

MAX_TASK_ASSIGNEES = 10


class TaskAssigneeSelectionError(ValueError):
    """Raised when an assignee collection violates task constraints."""


def task_assignee_ids(task):
    """Return all assignees, with the legacy field as a compatibility fallback."""

    prefetched = getattr(task, "_prefetched_objects_cache", {}).get("assignees")
    if prefetched is None:
        assignee_ids = set(task.assignees.values_list("id", flat=True))
    else:
        assignee_ids = {assignee.id for assignee in prefetched}
    if not assignee_ids and task.assignee_id is not None:
        assignee_ids.add(task.assignee_id)
    return assignee_ids


def task_assignees(task):
    """Return assignee objects with a compatibility fallback for legacy rows."""

    prefetched = getattr(task, "_prefetched_objects_cache", {}).get("assignees")
    assignees = (
        list(prefetched) if prefetched is not None else list(task.assignees.all())
    )
    if not assignees and task.assignee is not None:
        assignees = [task.assignee]
    return assignees


def is_task_assignee(task, user):
    """Check whether a user is one of a task's equally responsible assignees."""

    return bool(user and user.id in task_assignee_ids(task))


def set_task_assignees(task, assignees):
    """Replace assignees and mirror one value for legacy integrations."""

    assignees_by_id = {assignee.id: assignee for assignee in assignees}
    assignees = list(assignees_by_id.values())
    if not assignees:
        raise TaskAssigneeSelectionError("Choose at least one assignee.")
    if len(assignees) > MAX_TASK_ASSIGNEES:
        raise TaskAssigneeSelectionError(
            f"Choose no more than {MAX_TASK_ASSIGNEES} assignees."
        )
    task.assignees.set(assignees)
    legacy_assignee = assignees[0]
    if task.assignee_id != legacy_assignee.id:
        task.assignee = legacy_assignee
        task.save(update_fields=["assignee", "updated_at"])
