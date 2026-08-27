"""Bounded recursive hierarchy operations for durable tasks."""

from collections import deque
from dataclasses import dataclass
from hashlib import blake2b

from django.conf import settings
from django.db import connection
from django.db.models import Exists, OuterRef, Q

from core import models


@dataclass(frozen=True)
class TaskHierarchyLimits:
    """Runtime limits for one task tree."""

    max_depth: int
    max_direct_children: int
    max_tree_nodes: int


class TaskHierarchyError(ValueError):
    """A stable hierarchy validation failure returned by the task API."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def lock_task_hierarchy_scopes(*organization_ids):
    """Serialize hierarchy writes for every involved organization.

    Moving two trees in opposite directions can otherwise lock their rows in
    opposite orders.  PostgreSQL transaction advisory locks give hierarchy
    writes one stable, organization-scoped ordering without persisting a lock
    model.  ``None`` is a shared scope for personal tasks without an
    organization.
    """

    if not connection.in_atomic_block:
        raise RuntimeError("Task hierarchy scopes require an active transaction.")
    scope_values = {
        str(value) if value is not None else "personal" for value in organization_ids
    }
    lock_keys = sorted(
        int.from_bytes(
            blake2b(
                f"task-hierarchy:{scope}".encode(),
                digest_size=8,
            ).digest(),
            byteorder="big",
            signed=True,
        )
        for scope in scope_values
    )
    if connection.vendor == "postgresql":
        with connection.cursor() as cursor:
            for lock_key in lock_keys:
                cursor.execute("SELECT pg_advisory_xact_lock(%s)", [lock_key])


def get_task_hierarchy_limits() -> TaskHierarchyLimits:
    """Read and defensively validate deploy-time hierarchy settings."""

    limits = TaskHierarchyLimits(
        max_depth=int(settings.TASK_MAX_SUBTASK_DEPTH),
        max_direct_children=int(settings.TASK_MAX_DIRECT_CHILDREN),
        max_tree_nodes=int(settings.TASK_MAX_TREE_NODES),
    )
    if limits.max_depth < 0:
        raise RuntimeError("TASK_MAX_SUBTASK_DEPTH cannot be negative.")
    if limits.max_direct_children < 1 or limits.max_tree_nodes < 1:
        raise RuntimeError("Task hierarchy node limits must be positive.")
    return limits


def task_ancestor_chain(task, *, include_self=True, for_update=False):
    """Return a root-first ancestor chain, rejecting corrupt cyclic data."""

    chain = []
    current = task
    seen = set()
    hard_limit = get_task_hierarchy_limits().max_tree_nodes + 1
    while current is not None:
        if current.pk in seen or len(chain) >= hard_limit:
            raise TaskHierarchyError(
                "task_hierarchy_cycle", "Task hierarchy is cyclic."
            )
        seen.add(current.pk)
        chain.append(current)
        if current.parent_id is None:
            break
        cached_parent = current._state.fields_cache.get("parent")  # noqa: SLF001
        if cached_parent is not None:
            current = cached_parent
            continue
        queryset = models.Task.objects.select_related("task_list", "group")
        if for_update:
            queryset = queryset.select_for_update(of=("self",))
        current = queryset.get(pk=current.parent_id)
    chain.reverse()
    return chain if include_self else chain[:-1]


def task_subtree(task, *, include_self=True, for_update=False):
    """Return a breadth-first subtree without relying on a fixed depth."""

    nodes = [task] if include_self else []
    frontier = [task.pk]
    seen = {task.pk}
    hard_limit = get_task_hierarchy_limits().max_tree_nodes + 1
    while frontier:
        queryset = models.Task.objects.filter(parent_id__in=frontier).select_related(
            "task_list", "group", "source_action_item"
        )
        if for_update:
            queryset = queryset.select_for_update(of=("self",))
        children = list(queryset.order_by("parent_id", "position", "created_at"))
        frontier = []
        for child in children:
            if child.pk in seen:
                raise TaskHierarchyError(
                    "task_hierarchy_cycle", "Task hierarchy is cyclic."
                )
            seen.add(child.pk)
            nodes.append(child)
            frontier.append(child.pk)
            if len(seen) > hard_limit:
                raise TaskHierarchyError(
                    "task_tree_too_large",
                    "Task tree exceeds the configured safety limit.",
                )
    return nodes


def task_subtree_height(task):
    """Return the greatest number of edges below ``task``."""

    frontier = [task.pk]
    seen = {task.pk}
    height = 0
    hard_limit = get_task_hierarchy_limits().max_tree_nodes + 1
    while frontier:
        children = list(
            models.Task.objects.filter(parent_id__in=frontier).values_list(
                "id", flat=True
            )
        )
        if not children:
            return height
        if any(child in seen for child in children):
            raise TaskHierarchyError(
                "task_hierarchy_cycle", "Task hierarchy is cyclic."
            )
        seen.update(children)
        if len(seen) > hard_limit:
            raise TaskHierarchyError(
                "task_tree_too_large", "Task tree exceeds the configured safety limit."
            )
        frontier = children
        height += 1
    return height


def validate_task_parent_change(*, task, parent, organization):
    """Validate a create or subtree move while relevant rows are locked."""

    limits = get_task_hierarchy_limits()
    if parent is None:
        if task is not None and task_subtree_height(task) > limits.max_depth:
            raise TaskHierarchyError(
                "task_depth_exceeded",
                f"Task depth cannot exceed {limits.max_depth}.",
            )
        return

    parent = models.Task.objects.select_for_update(of=("self",)).get(pk=parent.pk)
    if parent.organization_id != getattr(organization, "id", None):
        raise TaskHierarchyError(
            "task_cross_organization",
            "Parent and child tasks must belong to the same organization.",
        )

    source_nodes = []
    source_ids = set()
    if task is not None:
        source_nodes = task_subtree(task, for_update=True)
        source_ids = {node.pk for node in source_nodes}
        if parent.pk in source_ids:
            raise TaskHierarchyError(
                "task_hierarchy_cycle",
                "A task cannot be moved below itself or one of its descendants.",
            )
        if any(node.organization_id != parent.organization_id for node in source_nodes):
            raise TaskHierarchyError(
                "task_cross_organization",
                "The complete moved subtree must stay in one organization.",
            )

    parent_chain = task_ancestor_chain(parent, for_update=True)
    parent_depth = len(parent_chain) - 1
    subtree_height = task_subtree_height(task) if task is not None else 0
    if parent_depth + 1 + subtree_height > limits.max_depth:
        raise TaskHierarchyError(
            "task_depth_exceeded",
            f"Task depth cannot exceed {limits.max_depth}.",
        )

    direct_children = models.Task.objects.select_for_update(of=("self",)).filter(
        parent=parent
    )
    if task is not None:
        direct_children = direct_children.exclude(pk=task.pk)
    if direct_children.count() >= limits.max_direct_children:
        raise TaskHierarchyError(
            "task_direct_children_exceeded",
            f"A task can have at most {limits.max_direct_children} direct subtasks.",
        )

    target_root = parent_chain[0]
    target_nodes = task_subtree(target_root, for_update=True)
    target_ids = {node.pk for node in target_nodes}
    added_nodes = 1 if task is None else len(source_nodes)
    if task is not None and source_ids <= target_ids:
        added_nodes = 0
    if len(target_nodes) + added_nodes > limits.max_tree_nodes:
        raise TaskHierarchyError(
            "task_tree_nodes_exceeded",
            f"A task tree can have at most {limits.max_tree_nodes} nodes.",
        )


def task_is_directly_visible(task, user, *, shared_via=""):
    """Apply the existing direct-collaborator visibility rules to one task."""

    if user is None or not user.is_authenticated:
        return False
    cached = getattr(task, "_hierarchy_direct_visible", None)
    if cached is not None:
        return bool(cached)
    return task.pk in visible_task_ids([task.pk], user, shared_via=shared_via)


def visible_task_ids(task_ids, user, *, shared_via=""):
    """Return directly visible IDs for an arbitrary bounded task set."""

    if user is None or not user.is_authenticated:
        return set()
    visibility = _direct_task_visibility_filter(user, shared_via=shared_via)
    return set(
        models.Task.objects.filter(pk__in=task_ids)
        .filter(visibility)
        .values_list("pk", flat=True)
        .distinct()
    )


def _direct_task_visibility_filter(user, *, shared_via=""):
    visibility = (
        Q(creator=user)
        | Q(assignees=user)
        | Q(assignee=user)
        | Q(followers=user)
        | Q(task_list__accesses__user=user)
    )
    if shared_via:
        visibility |= Q(conversation_shares__cid=shared_via)
    return visibility


def filter_visible_task_hierarchy(queryset, user, *, shared_via=""):
    """Require direct visibility of every ancestor using bounded subqueries."""

    if user is None or not user.is_authenticated:
        return queryset.none()

    hierarchy = Q(parent__isnull=True)
    annotations = {}
    visible_ancestors = {}
    relation_path = "parent"
    direct_visibility = _direct_task_visibility_filter(user, shared_via=shared_via)
    for depth in range(1, get_task_hierarchy_limits().max_depth + 1):
        annotation = f"_hierarchy_parent_{depth}_visible"
        annotations[annotation] = Exists(
            models.Task.objects.filter(pk=OuterRef(f"{relation_path}_id")).filter(
                direct_visibility
            )
        )
        visible_ancestors[annotation] = True
        hierarchy |= Q(**visible_ancestors) & Q(
            **{f"{relation_path}__parent_id__isnull": True}
        )
        relation_path = f"{relation_path}__parent"
    return queryset.annotate(**annotations).filter(hierarchy)


def prepare_task_hierarchy_visibility(tasks, user, *, shared_via=""):
    """Hydrate direct visibility for task paths using one permission query."""

    supplied = {task.pk: task for task in tasks}
    for task in tasks:
        parent = supplied.get(task.parent_id)
        if parent is not None:
            task._state.fields_cache["parent"] = parent  # noqa: SLF001
    chains = {task.pk: task_ancestor_chain(task) for task in tasks}
    nodes = {node.pk: node for chain in chains.values() for node in chain}
    visible_ids = visible_task_ids(nodes, user, shared_via=shared_via)
    for node_id, node in nodes.items():
        node._hierarchy_direct_visible = node_id in visible_ids  # noqa: SLF001
    return chains


def prepare_task_hierarchy_data(tasks, user, *, shared_via=""):
    """Compute paths, visible progress, and subtree impact in bounded batches."""

    if not tasks:
        return {}
    paths = prepare_task_hierarchy_visibility(tasks, user, shared_via=shared_via)
    all_nodes = {task.pk: task for task in tasks}
    children_by_parent = {}
    frontier = set(all_nodes)
    expanded = set()
    safety_limit = len(tasks) * get_task_hierarchy_limits().max_tree_nodes
    while frontier:
        parent_ids = frontier - expanded
        if not parent_ids:
            break
        expanded.update(parent_ids)
        children = list(
            models.Task.objects.filter(parent_id__in=parent_ids).order_by(
                "parent_id", "position", "created_at"
            )
        )
        frontier = set()
        for child in children:
            parent = all_nodes.get(child.parent_id)
            if parent is not None:
                child._state.fields_cache["parent"] = parent  # noqa: SLF001
            all_nodes.setdefault(child.pk, child)
            children_by_parent.setdefault(child.parent_id, []).append(child)
            if child.pk not in expanded:
                frontier.add(child.pk)
        if len(all_nodes) > safety_limit:
            raise TaskHierarchyError(
                "task_tree_too_large",
                "Task trees exceed the configured safety limit.",
            )

    directly_visible = visible_task_ids(all_nodes, user, shared_via=shared_via)
    for node_id, node in all_nodes.items():
        node._hierarchy_direct_visible = node_id in directly_visible  # noqa: SLF001

    result = {}
    for task in tasks:
        chain = paths[task.pk]
        path = (
            [
                {"id": str(node.pk), "title": node.title, "depth": depth}
                for depth, node in enumerate(chain)
            ]
            if all(task_is_directly_visible(node, user) for node in chain)
            else None
        )
        root_depth = len(chain) - 1
        node_count = 1
        maximum_depth = root_depth
        visible_total = 0
        completed = 0
        pending = deque(
            (child, 1, path is not None)
            for child in children_by_parent.get(task.pk, [])
        )
        seen = {task.pk}
        while pending:
            node, relative_depth, parent_visible = pending.popleft()
            if node.pk in seen:
                raise TaskHierarchyError(
                    "task_hierarchy_cycle", "Task hierarchy is cyclic."
                )
            seen.add(node.pk)
            node_count += 1
            maximum_depth = max(maximum_depth, root_depth + relative_depth)
            node_visible = parent_visible and node.pk in directly_visible
            if node_visible:
                visible_total += 1
                completed += node.status == models.Task.Status.COMPLETED
            pending.extend(
                (child, relative_depth + 1, node_visible)
                for child in children_by_parent.get(node.pk, [])
            )
        result[task.pk] = {
            "path": path or [],
            "depth": path[-1]["depth"] if path else 0,
            "progress": {"completed": completed, "total": visible_total},
            "impact": {
                "task_id": str(task.pk),
                "node_count": node_count,
                "descendant_count": node_count - 1,
                "maximum_depth": maximum_depth,
            },
        }
    return result


def visible_task_ancestor_path(task, user, *, shared_via=""):
    """Return a safe root-to-task breadcrumb or ``None`` if any node is hidden."""

    chain = task_ancestor_chain(task)
    if not all(
        task_is_directly_visible(node, user, shared_via=shared_via) for node in chain
    ):
        return None
    return [
        {"id": str(node.pk), "title": node.title, "depth": depth}
        for depth, node in enumerate(chain)
    ]


def validate_parent_visibility_for_collaborators(
    *, parent, users=(), task_list=None, conversation_ids=()
):
    """Reject a placement that would give collaborators a hidden parent chain."""

    if parent is None:
        return
    user_ids = {user.pk for user in users if user is not None}
    if task_list is not None:
        user_ids.update(task_list.accesses.values_list("user_id", flat=True))
        user_ids.add(task_list.creator_id)
    hidden_user_exists = any(
        visible_task_ancestor_path(parent, user) is None
        for user in models.User.objects.filter(pk__in=user_ids)
    )
    if hidden_user_exists:
        raise TaskHierarchyError(
            "task_parent_chain_invisible",
            "Every task collaborator must be able to view the complete parent chain.",
        )

    ancestor_ids = [node.pk for node in task_ancestor_chain(parent)]
    for conversation_id in set(conversation_ids):
        shared_ancestor_ids = set(
            models.TaskConversationShare.objects.filter(
                task_id__in=ancestor_ids,
                cid=conversation_id,
            ).values_list("task_id", flat=True)
        )
        if shared_ancestor_ids != set(ancestor_ids):
            raise TaskHierarchyError(
                "task_parent_chain_invisible",
                "Every shared conversation must include the complete parent chain.",
            )


def validate_subtree_parent_visibility(*, subtree, parent):
    """Apply parent-chain visibility rules to every collaborator in a moved tree."""

    if parent is None:
        return
    for node in subtree:
        users = [node.creator, node.assignee]
        users.extend(node.assignees.all())
        users.extend(node.followers.all())
        validate_parent_visibility_for_collaborators(
            parent=parent,
            users=users,
            task_list=node.task_list,
            conversation_ids=node.conversation_shares.values_list("cid", flat=True),
        )
