"""Minimal standalone task API."""

import uuid
from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import (
    Case,
    CharField,
    Count,
    Exists,
    F,
    IntegerField,
    Max,
    Min,
    OuterRef,
    Prefetch,
    Q,
    Value,
    When,
)
from django.db.models.functions import Coalesce, Lower, NullIf
from django.shortcuts import get_object_or_404
from django.utils import timezone

from rest_framework import mixins, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.response import Response

from core import models, utils
from core.api import permissions
from core.api.directory import get_caller_organization, is_caller_org_admin
from core.api.serializers import (
    TaskActivitySerializer,
    TaskAttachmentSerializer,
    TaskCommentSerializer,
    TaskGroupSerializer,
    TaskListAccessSerializer,
    TaskListGroupSerializer,
    TaskListSerializer,
    TaskPreferenceSerializer,
    TaskReminderPreferenceSerializer,
    TaskSavedViewSerializer,
    TaskSerializer,
)
from core.api.viewsets import Pagination
from core.services.im_provisioning import external_id_for
from core.services.jusi_im import (
    JusiImAdminClient,
    JusiImBadResponseError,
    JusiImUnreachableError,
)
from core.services.task_action_item_sync import sync_action_item_from_task_status
from core.services.task_assignees import (
    MAX_TASK_ASSIGNEES,
    is_task_assignee,
    is_task_reminder_participant,
    set_task_assignees,
    task_assignee_ids,
)
from core.services.task_hierarchy import (
    TaskHierarchyError,
    filter_visible_task_hierarchy,
    get_task_hierarchy_limits,
    lock_task_hierarchy_scopes,
    prepare_task_hierarchy_data,
    prepare_task_hierarchy_visibility,
    task_subtree,
    validate_parent_visibility_for_collaborators,
    validate_subtree_parent_visibility,
    validate_task_parent_change,
    visible_task_ancestor_path,
)
from core.services.task_history import (
    record_task_changes,
    record_task_created,
    snapshot_task,
)
from core.services.task_notifications import (
    record_task_assignment,
    record_task_comment,
    record_task_date_change,
    record_task_deletion,
    record_task_priority_change,
    record_task_status_change,
    supersede_ineligible_task_reminders,
    supersede_pending_task_reminders,
)
from core.services.task_recurrence import (
    TaskRecurrenceError,
    create_task_recurrence_rule,
    deactivate_task_recurrence_rule,
    materialize_task_recurrence,
    update_task_recurrence_rule,
)
from core.services.task_time import (
    TIME_FILTERS,
    annotate_assignee_local_date,
    local_date_for_user,
)
from core.services.tasks import TaskAssigneeError, ensure_task_assignee_allowed
from core.tasks.file import process_file_deletion

TASK_ORDERING_FIELDS = {
    "assignee",
    "priority",
    "start_date",
    "due_date",
    "status",
    "creator",
    "created_at",
}

TASK_LIST_EDIT_ROLES = {
    models.TaskListAccess.Role.EDITOR,
    models.TaskListAccess.Role.OWNER,
}


def _task_parent_select_fields():
    fields = []
    field = "parent"
    for _index in range(get_task_hierarchy_limits().max_depth):
        fields.append(field)
        field = f"{field}__parent"
    return fields


ASSIGNABLE_TASK_PRIORITY_CHOICES = [
    choice
    for choice in models.Task.Priority.choices
    if choice[0] != models.Task.Priority.NONE
]

SHARED_TASK_ACTIONS = {
    "retrieve",
    "activities",
    "follow",
    "comments",
    "attachments",
    "attachment_download",
    "share",
    "subtasks",
    "subtree_impact",
    "parent_candidates",
}


def _require_conversation_membership(user, cid):
    """Prove current IM membership without trusting a client-supplied cid."""

    cid = (cid or "").strip()
    if not cid or len(cid) > 64:
        raise serializers.ValidationError({"cid": "Choose a valid conversation."})
    configuration = getattr(settings, "JUSI_IM_CONFIGURATION", None)
    if not configuration:
        raise PermissionDenied("Conversation membership could not be verified.")
    client = JusiImAdminClient(
        api_url=str(configuration["api_url"]),
        admin_hmac_secret=str(configuration["admin_hmac_secret"]),
        timeout_seconds=float(configuration.get("request_timeout_seconds") or 5),
    )
    try:
        resolved = client.issue_token(
            external_id=external_id_for(user),
            ttl_seconds=60,
        )
        client.get_members(cid, resolved.token)
    except JusiImUnreachableError as exc:
        raise PermissionDenied(
            "Conversation membership could not be verified."
        ) from exc
    except JusiImBadResponseError as exc:
        raise PermissionDenied("You are not a member of this conversation.") from exc
    return cid


def _task_list_role(task_list, user):
    if task_list is None or user is None or not user.is_authenticated:
        return None
    role = (
        models.TaskListAccess.objects.filter(task_list=task_list, user=user)
        .values_list("role", flat=True)
        .first()
    )
    if role is None and task_list.creator_id == user.id:
        return models.TaskListAccess.Role.OWNER
    return role


def _can_edit_task_list(task_list, user):
    return _task_list_role(task_list, user) in TASK_LIST_EDIT_ROLES


def _can_manage_task_content(task, user):
    return (
        task.creator_id == user.id or is_task_assignee(task, user)
    ) or _can_edit_task_list(task.task_list, user)


def _can_comment_on_task(task, user):
    return (
        _can_manage_task_content(task, user)
        or task.followers.filter(id=user.id).exists()
    )


def _task_hierarchy_validation_error(exc):
    return serializers.ValidationError(
        {"parent_id": {"code": exc.code, "detail": str(exc)}}
    )


def _task_recurrence_validation_error(exc):
    return serializers.ValidationError(
        {"recurrence": {"code": exc.code, "detail": str(exc)}}
    )


def _delete_tasks_with_attachments(queryset, *, actor):
    """Delete tasks while applying the normal persisted-file cleanup lifecycle."""

    tasks = list(queryset.prefetch_related("followers"))
    files = list(models.File.objects.filter(task_attachment__task__in=tasks).distinct())
    for file in files:
        if file.deleted_at is None:
            file.soft_delete()
        if file.hard_deleted_at is None:
            file.hard_delete()
        transaction.on_commit(
            lambda file_id=file.id: process_file_deletion.delay(file_id)
        )
    for task in tasks:
        record_task_deletion(task=task, actor=actor)
    models.Task.objects.filter(pk__in=[task.pk for task in tasks]).delete()


def _person_name_expression(relation):
    """Match the user name fallback used by the task list UI."""

    return Lower(
        Coalesce(
            NullIf(F(f"{relation}__full_name"), Value("")),
            NullIf(F(f"{relation}__short_name"), Value("")),
            NullIf(F(f"{relation}__email"), Value("")),
            output_field=CharField(),
        )
    )


def _order_tasks(queryset, ordering="", search_query=""):
    """Keep task lists on the same deterministic order."""

    status_rank = Case(
        When(status=models.Task.Status.TODO, then=Value(0)),
        When(status=models.Task.Status.COMPLETED, then=Value(1)),
        default=Value(2),
        output_field=IntegerField(),
    )
    priority_rank = Case(
        When(priority=models.Task.Priority.URGENT, then=Value(0)),
        When(priority=models.Task.Priority.HIGH, then=Value(1)),
        When(priority=models.Task.Priority.MEDIUM, then=Value(2)),
        When(priority=models.Task.Priority.LOW, then=Value(3)),
        default=Value(None),
        output_field=IntegerField(),
    )
    if ordering:
        descending = ordering.startswith("-")
        field = ordering.removeprefix("-")
        if field not in TASK_ORDERING_FIELDS:
            raise serializers.ValidationError(
                {"ordering": "Use a sortable task column."}
            )

        if field == "assignee":
            queryset = queryset.annotate(
                _task_ordering_value=Coalesce(
                    Min(_person_name_expression("assignees")),
                    _person_name_expression("assignee"),
                )
            )
            expression = F("_task_ordering_value")
        elif field == "creator":
            queryset = queryset.annotate(
                _task_ordering_value=_person_name_expression("creator")
            )
            expression = F("_task_ordering_value")
        elif field == "priority":
            expression = priority_rank
        elif field == "status":
            expression = status_rank
        else:
            expression = F(field)

        ordered_expression = (
            expression.desc(nulls_last=True)
            if descending
            else expression.asc(nulls_last=True)
        )
        return queryset.order_by(ordered_expression, "id")

    business_order = (
        status_rank,
        priority_rank.asc(nulls_last=True),
        F("due_date").asc(nulls_last=True),
        "-updated_at",
        "id",
    )
    if search_query:
        relevance_rank = Case(
            When(title__iexact=search_query, then=Value(0)),
            When(title__istartswith=search_query, then=Value(1)),
            When(title__icontains=search_query, then=Value(2)),
            default=Value(3),
            output_field=IntegerField(),
        )
        return queryset.order_by(relevance_rank, *business_order)
    return queryset.order_by(*business_order)


def _parse_task_person_ids(request, parameter):
    """Parse one bounded, comma-separated UUID filter."""

    raw_value = request.query_params.get(parameter)
    if raw_value in (None, ""):
        return []
    values = [value.strip() for value in raw_value.split(",") if value.strip()]
    try:
        identifiers = list(dict.fromkeys(uuid.UUID(value) for value in values))
    except ValueError as exc:
        raise serializers.ValidationError(
            {parameter: "Use a comma-separated list of valid user IDs."}
        ) from exc
    if not identifiers or len(identifiers) > 20:
        raise serializers.ValidationError({parameter: "Choose between 1 and 20 users."})
    return identifiers


def _filter_task_search(queryset, *, request, user):
    """Apply global-search filters while preserving task visibility rules."""

    raw_search_query = request.query_params.get("q")
    search_query = (raw_search_query or "").strip()
    if raw_search_query is not None:
        if not 2 <= len(search_query) <= 200:
            raise serializers.ValidationError(
                {"q": "Enter between 2 and 200 characters."}
            )
        queryset = queryset.filter(
            Q(title__icontains=search_query) | Q(description__icontains=search_query)
        )

    creator_ids = _parse_task_person_ids(request, "creator_ids")
    if creator_ids:
        queryset = queryset.filter(creator_id__in=creator_ids)

    assignee_ids = _parse_task_person_ids(request, "assignee_ids")
    if assignee_ids:
        queryset = queryset.filter(
            Q(assignees__id__in=assignee_ids) | Q(assignee_id__in=assignee_ids)
        )

    follower_ids = _parse_task_person_ids(request, "follower_ids")
    if follower_ids:
        queryset = queryset.filter(followers__id__in=follower_ids)

    due_filter = request.query_params.get("due", "all")
    valid_due_filters = {
        "all",
        "today",
        "tomorrow",
        "this_week",
        "overdue",
        "no_date",
    }
    if due_filter not in valid_due_filters:
        raise serializers.ValidationError(
            {"due": ("Use all, today, tomorrow, this_week, overdue, or no_date.")}
        )
    local_today = local_date_for_user(user)
    if due_filter == "today":
        queryset = queryset.filter(due_date=local_today)
    elif due_filter == "tomorrow":
        queryset = queryset.filter(due_date=local_today + timedelta(days=1))
    elif due_filter == "this_week":
        queryset = queryset.filter(
            due_date__range=(
                local_today,
                local_today + timedelta(days=6 - local_today.weekday()),
            )
        )
    elif due_filter == "overdue":
        queryset = queryset.filter(
            status=models.Task.Status.TODO,
            due_date__lt=local_today,
        )
    elif due_filter == "no_date":
        queryset = queryset.filter(due_date__isnull=True)

    return queryset.distinct(), search_query


def _filter_task_list(queryset, *, request, user, include_search=True):  # noqa: PLR0912
    """Apply validated list filters without growing the viewset branch count."""

    scope = request.query_params.get("scope", "assigned")
    if scope == "assigned":
        queryset = queryset.filter(Q(assignees=user) | Q(assignee=user)).distinct()
    elif scope == "created":
        queryset = queryset.filter(creator=user)
    elif scope == "following":
        queryset = queryset.filter(followers=user)
    elif scope != "all":
        raise serializers.ValidationError(
            {"scope": "Use assigned, created, following, or all."}
        )

    status_filter = request.query_params.get("status", "all")
    if status_filter == "open":
        queryset = queryset.filter(status=models.Task.Status.TODO)
    elif status_filter != "all":
        valid_statuses = {choice for choice, _label in models.Task.Status.choices}
        if status_filter not in valid_statuses:
            raise serializers.ValidationError(
                {"status": "Use open, all, or a task status."}
            )
        queryset = queryset.filter(status=status_filter)

    priority_filter = request.query_params.get("priority", "all")
    if priority_filter != "all":
        valid_priorities = {choice for choice, _label in models.Task.Priority.choices}
        if priority_filter not in valid_priorities:
            raise serializers.ValidationError(
                {"priority": "Use all, none, low, medium, high, or urgent."}
            )
        queryset = queryset.filter(priority=priority_filter)

    queryset = _filter_by_task_list(
        queryset,
        task_list_filter=request.query_params.get("task_list", "all"),
        user=user,
    )

    search_query = ""
    if include_search:
        queryset, search_query = _filter_task_search(
            queryset,
            request=request,
            user=user,
        )

    time_filter = request.query_params.get("time", "all")
    if time_filter not in TIME_FILTERS:
        raise serializers.ValidationError(
            {"time": "Use all, starting_today, due_today, or overdue."}
        )
    if time_filter == "all":
        return queryset, search_query

    queryset = queryset.filter(status=models.Task.Status.TODO).filter(
        Q(assignees__isnull=False) | Q(assignee__isnull=False)
    )
    if time_filter == "starting_today":
        return (
            queryset.filter(start_date=F("_assignee_local_date")).exclude(
                due_date=F("_assignee_local_date")
            ),
            search_query,
        )
    if time_filter == "due_today":
        return queryset.filter(due_date=F("_assignee_local_date")), search_query
    return queryset.filter(due_date__lt=F("_assignee_local_date")), search_query


def _filter_by_task_list(queryset, *, task_list_filter, user):
    """Filter by one active task list without crossing organizations."""

    if task_list_filter == "unassigned":
        return queryset.filter(task_list__isnull=True)
    if task_list_filter == "all":
        return queryset
    organization = get_caller_organization(user)
    try:
        task_list = (
            models.TaskList.objects.filter(
                id=task_list_filter,
                organization=organization,
                is_archived=False,
            )
            .filter(Q(accesses__user=user) | Q(creator=user))
            .distinct()
            .get()
        )
    except (
        ValueError,
        DjangoValidationError,
        models.TaskList.DoesNotExist,
    ) as exc:
        raise serializers.ValidationError(
            {
                "task_list": (
                    "Use all, unassigned, or an active task list from your "
                    "organization."
                )
            }
        ) from exc
    return queryset.filter(task_list=task_list)


def _validate_unique_task_group_name(name, organization, exclude=None):
    queryset = models.TaskGroup.objects.filter(
        organization=organization,
        name__iexact=name,
    )
    if exclude is not None:
        queryset = queryset.exclude(pk=exclude.pk)
    if queryset.exists():
        raise serializers.ValidationError(
            {"name": "This organization already has a task group with this name."}
        )


class TaskAssigneeValidationMixin:
    """Validate assignees against the caller's organization directory."""

    def _validate_assignee(self, assignee):
        request = self.context["request"]
        try:
            ensure_task_assignee_allowed(creator=request.user, assignee=assignee)
        except TaskAssigneeError as exc:
            raise serializers.ValidationError(str(exc)) from exc
        return assignee

    def validate_assignee_id(self, assignee):
        return self._validate_assignee(assignee)

    def validate_assignee_ids(self, assignees):
        if len({assignee.id for assignee in assignees}) != len(assignees):
            raise serializers.ValidationError("Choose each assignee only once.")
        for assignee in assignees:
            self._validate_assignee(assignee)
        return assignees


class TaskFollowerValidationMixin:
    """Validate followers against the caller's organization directory."""

    def validate_follower_ids(self, followers):
        request = self.context["request"]
        for follower in followers:
            try:
                ensure_task_assignee_allowed(creator=request.user, assignee=follower)
            except TaskAssigneeError as exc:
                raise serializers.ValidationError(str(exc)) from exc
        return followers


class TaskPlacementValidationMixin:
    """Validate the orthogonal task-list and custom-group properties."""

    def _inherits_editable_parent_task_list(self, task_list, user):
        if getattr(self, "instance", None) is not None:
            return False
        parent_id = self.initial_data.get("parent_id")
        if not parent_id:
            return False
        parent = models.Task.objects.filter(pk=parent_id).first()
        return bool(
            parent
            and parent.task_list_id == task_list.id
            and _can_manage_task_content(parent, user)
        )

    def validate_task_list_id(self, task_list):
        if task_list is None:
            return None
        user = self.context["request"].user
        organization = (
            self.instance.organization
            if getattr(self, "instance", None) is not None
            else get_caller_organization(user)
        )
        if (
            organization is None
            or task_list.organization_id != organization.id
            or task_list.is_archived
            or not (
                _can_edit_task_list(task_list, user)
                or self._inherits_editable_parent_task_list(task_list, user)
            )
        ):
            raise serializers.ValidationError(
                "Choose an active task list you can edit from the task organization."
            )
        return task_list

    def validate_group_id(self, group):
        if group is None:
            return None
        user = self.context["request"].user
        organization = (
            self.instance.organization
            if getattr(self, "instance", None) is not None
            else get_caller_organization(user)
        )
        if organization is None or group.organization_id != organization.id:
            raise serializers.ValidationError(
                "Choose a custom group from the task organization."
            )
        return group

    def validate_placement(self, attrs):
        # A task list and a custom group are deliberately independent. Moving a
        # task between lists must not silently clear its custom group.
        return attrs


class TaskCreateSerializer(
    TaskPlacementValidationMixin,
    TaskAssigneeValidationMixin,
    TaskFollowerValidationMixin,
    serializers.Serializer,
):
    """Input for a task created by the caller and assigned to a colleague."""

    title = serializers.CharField(max_length=500, trim_whitespace=True)
    description = serializers.CharField(
        required=False, allow_blank=True, max_length=5000, default=""
    )
    start_date = serializers.DateField(required=False, allow_null=True)
    due_date = serializers.DateField(required=False, allow_null=True)
    priority = serializers.ChoiceField(
        choices=ASSIGNABLE_TASK_PRIORITY_CHOICES,
        required=False,
        default=models.Task.Priority.MEDIUM,
    )
    assignee_id = serializers.PrimaryKeyRelatedField(
        source="assignee",
        queryset=models.User.objects.all(),
        required=False,
        write_only=True,
    )
    assignee_ids = serializers.ListField(
        source="assignees",
        child=serializers.PrimaryKeyRelatedField(queryset=models.User.objects.all()),
        required=False,
        allow_empty=False,
        max_length=MAX_TASK_ASSIGNEES,
        write_only=True,
    )
    follower_ids = serializers.PrimaryKeyRelatedField(
        source="followers",
        queryset=models.User.objects.all(),
        many=True,
        required=False,
        write_only=True,
    )
    task_list_id = serializers.PrimaryKeyRelatedField(
        source="task_list",
        queryset=models.TaskList.objects.all(),
        required=False,
        allow_null=True,
        write_only=True,
    )
    group_id = serializers.PrimaryKeyRelatedField(
        source="group",
        queryset=models.TaskGroup.objects.all(),
        required=False,
        allow_null=True,
        write_only=True,
    )
    position = serializers.IntegerField(required=False, min_value=0, default=0)
    parent_id = serializers.PrimaryKeyRelatedField(
        source="parent",
        queryset=models.Task.objects.all(),
        required=False,
        allow_null=True,
        write_only=True,
    )
    recurrence = serializers.JSONField(required=False, write_only=True)
    reminder = TaskReminderPreferenceSerializer(required=False, write_only=True)

    def validate_parent_id(self, parent):
        if parent is None:
            return None
        request = self.context["request"]
        if not _can_manage_task_content(parent, request.user):
            raise serializers.ValidationError(
                "Choose a parent task you can edit.", code="task_parent_forbidden"
            )
        if visible_task_ancestor_path(parent, request.user) is None:
            raise serializers.ValidationError(
                "The complete parent chain must be visible.",
                code="task_parent_chain_hidden",
            )
        return parent

    def validate(self, attrs):
        if "assignee_id" in self.initial_data and "assignee_ids" in self.initial_data:
            raise serializers.ValidationError(
                {"assignee_ids": "Use assignee_ids instead of assignee_id."}
            )
        attrs = self.validate_placement(attrs)
        recurrence = attrs.get("recurrence")
        if recurrence is not None:
            recurrence_serializer = TaskRecurrenceInputSerializer(data=recurrence)
            recurrence_serializer.is_valid(raise_exception=True)
            attrs["recurrence"] = recurrence_serializer.validated_data
            if attrs.get("parent") is not None:
                raise serializers.ValidationError(
                    {
                        "recurrence": {
                            "code": "task_recurrence_hierarchy_forbidden",
                            "detail": "A recurring task must be a hierarchy root.",
                        }
                    }
                )
        if attrs.get("start_date") is None:
            attrs["start_date"] = local_date_for_user(self.context["request"].user)
        if (
            attrs.get("start_date")
            and attrs.get("due_date")
            and attrs["start_date"] > attrs["due_date"]
        ):
            raise serializers.ValidationError(
                {"due_date": "Due date cannot be earlier than start date."}
            )
        return attrs


class TaskRecurrenceInputSerializer(serializers.Serializer):
    """Validated schedule fields; the timezone always comes from the owner."""

    frequency = serializers.ChoiceField(
        choices=models.TaskRecurrenceRule.Frequency.choices,
        required=False,
    )
    interval = serializers.IntegerField(required=False, min_value=1, max_value=365)
    end_date = serializers.DateField(required=False, allow_null=True)
    max_occurrences = serializers.IntegerField(
        required=False, allow_null=True, min_value=1, max_value=1000
    )

    def validate(self, attrs):
        if (
            attrs.get("end_date") is not None
            and attrs.get("max_occurrences") is not None
        ):
            raise serializers.ValidationError(
                "Choose either an end date or a maximum occurrence count."
            )
        return attrs


class TaskUpdateSerializer(
    TaskPlacementValidationMixin,
    TaskAssigneeValidationMixin,
    serializers.ModelSerializer,
):
    """Editable fields and state-machine validation for one task."""

    _TRANSITIONS = {
        models.Task.Status.TODO: {models.Task.Status.COMPLETED},
        models.Task.Status.COMPLETED: {models.Task.Status.TODO},
    }

    title = serializers.CharField(max_length=500, trim_whitespace=True)
    description = serializers.CharField(allow_blank=True, max_length=5000)
    priority = serializers.ChoiceField(
        choices=ASSIGNABLE_TASK_PRIORITY_CHOICES,
        required=False,
    )
    assignee_id = serializers.PrimaryKeyRelatedField(
        source="assignee",
        queryset=models.User.objects.all(),
        required=False,
        write_only=True,
    )
    assignee_ids = serializers.ListField(
        source="assignees",
        child=serializers.PrimaryKeyRelatedField(queryset=models.User.objects.all()),
        required=False,
        allow_empty=False,
        max_length=MAX_TASK_ASSIGNEES,
        write_only=True,
    )
    task_list_id = serializers.PrimaryKeyRelatedField(
        source="task_list",
        queryset=models.TaskList.objects.all(),
        required=False,
        allow_null=True,
        write_only=True,
    )
    group_id = serializers.PrimaryKeyRelatedField(
        source="group",
        queryset=models.TaskGroup.objects.all(),
        required=False,
        allow_null=True,
        write_only=True,
    )
    parent_id = serializers.PrimaryKeyRelatedField(
        source="parent",
        queryset=models.Task.objects.all(),
        required=False,
        allow_null=True,
        write_only=True,
    )
    confirm_subtree_node_count = serializers.IntegerField(
        required=False, min_value=1, write_only=True
    )
    recurrence_scope = serializers.ChoiceField(
        choices=["one", "following"], required=False, write_only=True
    )

    class Meta:
        model = models.Task
        fields = [
            "title",
            "description",
            "start_date",
            "due_date",
            "priority",
            "task_list_id",
            "group_id",
            "parent_id",
            "confirm_subtree_node_count",
            "position",
            "assignee_id",
            "assignee_ids",
            "status",
            "recurrence_scope",
        ]

    def validate(self, attrs):
        if "assignee_id" in self.initial_data and "assignee_ids" in self.initial_data:
            raise serializers.ValidationError(
                {"assignee_ids": "Use assignee_ids instead of assignee_id."}
            )
        attrs = super().validate(attrs)
        attrs = self.validate_placement(attrs)
        start_date = attrs.get("start_date", self.instance.start_date)
        due_date = attrs.get("due_date", self.instance.due_date)
        if start_date and due_date and start_date > due_date:
            raise serializers.ValidationError(
                {"due_date": "Due date cannot be earlier than start date."}
            )
        return attrs

    def validate_status(self, value):
        if self.instance is None or value == self.instance.status:
            return value
        if value not in self._TRANSITIONS.get(self.instance.status, set()):
            raise serializers.ValidationError(
                "This task status transition is not allowed."
            )
        return value

    def validate_parent_id(self, parent):
        if parent is None:
            return None
        request = self.context["request"]
        if not _can_manage_task_content(parent, request.user):
            raise serializers.ValidationError(
                "Choose a parent task you can edit.", code="task_parent_forbidden"
            )
        if visible_task_ancestor_path(parent, request.user) is None:
            raise serializers.ValidationError(
                "The complete parent chain must be visible.",
                code="task_parent_chain_hidden",
            )
        return parent

    def update(self, instance, validated_data):
        validated_data.pop("confirm_subtree_node_count", None)
        validated_data.pop("recurrence_scope", None)
        assignees = validated_data.pop("assignees", None)
        legacy_assignee = validated_data.get("assignee")
        if legacy_assignee is not None:
            assignees = [legacy_assignee]
        previous_status = instance.status
        instance = super().update(instance, validated_data)
        if assignees is not None:
            set_task_assignees(instance, assignees)
        if instance.status == previous_status:
            return instance
        instance.completed_at = (
            timezone.now() if instance.status == models.Task.Status.COMPLETED else None
        )
        instance.save(update_fields=["completed_at", "updated_at"])
        return instance


class TaskFollowerSerializer(
    TaskFollowerValidationMixin,
    serializers.Serializer,
):
    """One organization member to add to a task's followers."""

    follower_ids = serializers.PrimaryKeyRelatedField(
        source="followers",
        queryset=models.User.objects.all(),
        many=True,
        write_only=True,
    )


class TaskSubtaskOrderSerializer(serializers.Serializer):
    """An exact ordered snapshot of one parent's direct children."""

    task_ids = serializers.ListField(
        child=serializers.UUIDField(),
        allow_empty=True,
    )

    def validate_task_ids(self, task_ids):
        if len(set(task_ids)) != len(task_ids):
            raise serializers.ValidationError("Choose each subtask only once.")
        return task_ids


class TaskShareSerializer(serializers.Serializer):
    """One or more conversations receiving the same task card."""

    conversation_ids = serializers.ListField(
        child=serializers.CharField(max_length=64, trim_whitespace=True),
        allow_empty=False,
        max_length=20,
    )

    def validate_conversation_ids(self, value):
        return list(dict.fromkeys(value))


class TaskSavedViewViewSet(
    mixins.CreateModelMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """Personal saved task workspace configurations for the active organization."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = TaskSavedViewSerializer
    pagination_class = None
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]
    maximum_views = 50

    def _organization(self):
        return get_caller_organization(self.request.user)

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["organization"] = self._organization()
        return context

    def get_queryset(self):
        organization = self._organization()
        if organization is None:
            return models.TaskSavedView.objects.none()
        return models.TaskSavedView.objects.filter(
            organization=organization,
            owner=self.request.user,
        ).order_by("position", "created_at", "id")

    def perform_create(self, serializer):
        organization = self._organization()
        if organization is None:
            raise serializers.ValidationError(
                {"detail": "Join an organization before saving a task view."}
            )
        queryset = models.TaskSavedView.objects.filter(
            organization=organization,
            owner=self.request.user,
        )
        with transaction.atomic():
            models.User.objects.select_for_update().get(pk=self.request.user.pk)
            if queryset.count() >= self.maximum_views:
                raise serializers.ValidationError(
                    {"detail": "You can save at most 50 task views."}
                )
            if serializer.validated_data.get("is_default", False):
                queryset.filter(is_default=True).update(is_default=False)
            position = serializer.validated_data.get("position")
            if position is None:
                maximum_position = queryset.aggregate(value=Max("position"))["value"]
                position = 0 if maximum_position is None else maximum_position + 1
            serializer.save(
                organization=organization,
                owner=self.request.user,
                position=position,
            )

    def perform_update(self, serializer):
        view = self.get_object()
        with transaction.atomic():
            models.User.objects.select_for_update().get(pk=self.request.user.pk)
            if serializer.validated_data.get("is_default", False):
                models.TaskSavedView.objects.filter(
                    organization=view.organization,
                    owner=view.owner,
                    is_default=True,
                ).exclude(pk=view.pk).update(is_default=False)
            serializer.save()


class TaskListGroupViewSet(
    mixins.CreateModelMixin,
    mixins.ListModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """Organization sections used to group task lists in navigation."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = TaskListGroupSerializer
    pagination_class = None
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["can_manage_all_task_lists"] = is_caller_org_admin(self.request.user)
        return context

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.TaskListGroup.objects.none()
        return (
            models.TaskListGroup.objects.filter(organization=organization)
            .select_related("creator")
            .annotate(
                _list_count=Count(
                    "task_lists",
                    filter=Q(
                        task_lists__is_archived=False,
                        task_lists__accesses__user=self.request.user,
                    ),
                    distinct=True,
                )
            )
        )

    def perform_create(self, serializer):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            raise serializers.ValidationError(
                {"detail": "Join an organization before creating a task-list group."}
            )
        self._validate_unique_name(serializer.validated_data["name"], organization)
        serializer.save(organization=organization, creator=self.request.user)

    def perform_update(self, serializer):
        group = self.get_object()
        self._ensure_can_manage(group)
        name = serializer.validated_data.get("name", group.name)
        self._validate_unique_name(name, group.organization, exclude=group)
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        group = self.get_object()
        self._ensure_can_manage(group)
        group.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _ensure_can_manage(self, group):
        if group.creator_id != self.request.user.id and not is_caller_org_admin(
            self.request.user
        ):
            raise PermissionDenied(
                "Only the task-list group creator or an organization administrator can manage it."
            )

    @staticmethod
    def _validate_unique_name(name, organization, exclude=None):
        queryset = models.TaskListGroup.objects.filter(
            organization=organization,
            name__iexact=name,
        )
        if exclude is not None:
            queryset = queryset.exclude(pk=exclude.pk)
        if queryset.exists():
            raise serializers.ValidationError(
                {
                    "name": "This organization already has a task-list group with this name."
                }
            )


class TaskListViewSet(
    mixins.CreateModelMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """Organization task lists that contain ordered custom groups."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = TaskListSerializer
    pagination_class = None
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["can_manage_all_task_lists"] = is_caller_org_admin(self.request.user)
        return context

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.TaskList.objects.none()
        queryset = (
            models.TaskList.objects.filter(organization=organization)
            .filter(Q(accesses__user=self.request.user) | Q(creator=self.request.user))
            .distinct()
        )
        queryset = queryset.filter(
            is_archived=self.request.query_params.get("archived") == "true"
        ).annotate(_task_count=Count("tasks", distinct=True))
        return queryset.select_related("creator", "list_group").prefetch_related(
            Prefetch(
                "groups",
                queryset=models.TaskGroup.objects.annotate(
                    _task_count=Count("tasks", distinct=True)
                ),
            ),
            Prefetch(
                "accesses",
                queryset=models.TaskListAccess.objects.filter(user=self.request.user),
                to_attr="_current_user_accesses",
            ),
        )

    def perform_create(self, serializer):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            raise serializers.ValidationError(
                {"detail": "Join an organization before creating a task list."}
            )
        self._validate_list_group(
            serializer.validated_data.get("list_group"), organization
        )
        self._validate_unique_name(serializer.validated_data["name"], organization)
        with transaction.atomic():
            task_list = serializer.save(
                organization=organization, creator=self.request.user
            )
            models.TaskListAccess.objects.create(
                task_list=task_list,
                user=self.request.user,
                role=models.TaskListAccess.Role.OWNER,
            )

    def perform_update(self, serializer):
        task_list = self.get_object()
        self._ensure_can_manage(task_list)
        name = serializer.validated_data.get("name", task_list.name)
        if "list_group" in serializer.validated_data:
            self._validate_list_group(
                serializer.validated_data["list_group"], task_list.organization
            )
        self._validate_unique_name(name, task_list.organization, exclude=task_list)
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        task_list = self.get_object()
        self._ensure_is_owner(task_list)
        with transaction.atomic():
            if request.query_params.get("delete_unassigned") == "true":
                _delete_tasks_with_attachments(
                    task_list.tasks.filter(
                        assignees__isnull=True, assignee__isnull=True
                    ),
                    actor=request.user,
                )
            task_list.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get", "post"])
    def shares(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        task_list = self.get_object()
        self._ensure_can_manage(task_list)
        if request.method == "GET":
            accesses = models.TaskListAccess.objects.filter(
                task_list=task_list
            ).select_related("user")
            return Response(
                TaskListAccessSerializer(
                    accesses, many=True, context={"request": request}
                ).data
            )

        user_id = request.data.get("user_id")
        role = request.data.get("role")
        if role not in {
            models.TaskListAccess.Role.VIEWER,
            models.TaskListAccess.Role.EDITOR,
        }:
            raise serializers.ValidationError(
                {"role": "Use viewer or editor when sharing a task list."}
            )
        user = get_object_or_404(models.User, pk=user_id)
        try:
            ensure_task_assignee_allowed(creator=request.user, assignee=user)
        except TaskAssigneeError as exc:
            raise serializers.ValidationError({"user_id": str(exc)}) from exc
        existing_access = models.TaskListAccess.objects.filter(
            task_list=task_list, user=user
        ).first()
        if user.id == request.user.id:
            raise PermissionDenied("Use the remove action to leave a task list.")
        if (
            existing_access is not None
            and existing_access.role == models.TaskListAccess.Role.OWNER
        ):
            raise PermissionDenied("The task-list owner's role cannot be changed.")
        access, created = models.TaskListAccess.objects.update_or_create(
            task_list=task_list,
            user=user,
            defaults={"role": role},
        )
        return Response(
            TaskListAccessSerializer(access, context={"request": request}).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    @action(
        detail=True,
        methods=["patch", "delete"],
        url_path=r"shares/(?P<user_id>[^/.]+)",
    )
    def share_detail(self, request, user_id=None, *args, **kwargs):
        task_list = self.get_object()
        self._ensure_can_manage(task_list)
        access = get_object_or_404(
            models.TaskListAccess.objects.select_related("user"),
            task_list=task_list,
            user_id=user_id,
        )
        if access.user_id == request.user.id:
            raise PermissionDenied("Use the remove action to leave a task list.")
        if access.role == models.TaskListAccess.Role.OWNER:
            raise PermissionDenied("The task-list owner cannot be changed here.")
        if request.method == "DELETE":
            access.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        role = request.data.get("role")
        if role not in {
            models.TaskListAccess.Role.VIEWER,
            models.TaskListAccess.Role.EDITOR,
        }:
            raise serializers.ValidationError({"role": "Use viewer or editor."})
        access.role = role
        access.save(update_fields=["role", "updated_at"])
        return Response(
            TaskListAccessSerializer(access, context={"request": request}).data
        )

    @action(detail=True, methods=["post"])
    def leave(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        task_list = self.get_object()
        access = get_object_or_404(
            models.TaskListAccess, task_list=task_list, user=request.user
        )
        if access.role == models.TaskListAccess.Role.OWNER:
            raise PermissionDenied(
                "The task-list owner must delete the task list instead of leaving it."
            )
        access.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get", "post"])
    def groups(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        task_list = self.get_object()
        if request.method == "GET":
            return Response(
                TaskGroupSerializer(
                    task_list.groups.annotate(
                        _task_count=Count("tasks", distinct=True)
                    ),
                    many=True,
                    context={"request": request},
                ).data
            )
        self._ensure_can_manage(task_list)
        serializer = TaskGroupSerializer(
            data=request.data,
            context={"request": request},
        )
        serializer.is_valid(raise_exception=True)
        _validate_unique_task_group_name(
            serializer.validated_data["name"], task_list.organization
        )
        group = serializer.save(
            task_list=task_list,
            organization=task_list.organization,
            creator=request.user,
        )
        return Response(
            TaskGroupSerializer(group, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )

    def _ensure_can_manage(self, task_list):
        if not _can_edit_task_list(task_list, self.request.user):
            raise PermissionDenied(
                "Only task-list editors and the owner can manage it."
            )

    def _ensure_is_owner(self, task_list):
        if (
            _task_list_role(task_list, self.request.user)
            != models.TaskListAccess.Role.OWNER
        ):
            raise PermissionDenied("Only the task-list owner can delete it.")

    @staticmethod
    def _validate_list_group(group, organization):
        if group is not None and group.organization_id != organization.id:
            raise serializers.ValidationError(
                {
                    "list_group_id": "The task-list group belongs to another organization."
                }
            )

    @staticmethod
    def _validate_unique_name(name, organization, exclude=None):
        queryset = models.TaskList.objects.filter(
            organization=organization,
            name__iexact=name,
        )
        if exclude is not None:
            queryset = queryset.exclude(pk=exclude.pk)
        if queryset.exists():
            raise serializers.ValidationError(
                {"name": "This organization already has a task list with this name."}
            )


class TaskGroupViewSet(
    mixins.CreateModelMixin,
    mixins.ListModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """Manage organization custom groups independently from task lists."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = TaskGroupSerializer
    pagination_class = None
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.TaskGroup.objects.none()
        return (
            models.TaskGroup.objects.filter(organization=organization)
            .annotate(_task_count=Count("tasks", distinct=True))
            .select_related("task_list", "creator")
        )

    def perform_create(self, serializer):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            raise serializers.ValidationError(
                {"detail": "Join an organization before creating a task group."}
            )
        _validate_unique_task_group_name(
            serializer.validated_data["name"], organization
        )
        serializer.save(organization=organization, creator=self.request.user)

    def perform_update(self, serializer):
        group = self.get_object()
        self._ensure_can_manage(group)
        name = serializer.validated_data.get("name", group.name)
        _validate_unique_task_group_name(
            name,
            group.organization,
            exclude=group,
        )
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        group = self.get_object()
        self._ensure_can_manage(group)
        if group.tasks.exists():
            raise serializers.ValidationError(
                {"detail": "Only empty task groups can be deleted."}
            )
        group.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _ensure_can_manage(self, group):
        can_manage_legacy_group = group.task_list is not None and _can_edit_task_list(
            group.task_list, self.request.user
        )
        if group.creator_id != self.request.user.id and not can_manage_legacy_group:
            raise PermissionDenied(
                "Only the group creator or a legacy task-list editor can manage it."
            )


class TaskAttachmentCreateSerializer(serializers.Serializer):
    """Attach one completed upload owned by the caller to a task."""

    file_id = serializers.PrimaryKeyRelatedField(
        source="file",
        queryset=models.File.objects.all(),
    )

    def validate_file_id(self, file):
        request = self.context["request"]
        if file.creator_id != request.user.id:
            raise serializers.ValidationError("You can only attach your own upload.")
        if file.type != models.FileTypeChoices.TASK_ATTACHMENT:
            raise serializers.ValidationError("This upload is not a task attachment.")
        if (
            file.upload_state != models.FileUploadStateChoices.READY
            or file.deleted_at is not None
            or file.hard_deleted_at is not None
        ):
            raise serializers.ValidationError("The upload is not ready.")
        if models.TaskAttachment.objects.filter(file=file).exists():
            raise serializers.ValidationError("This upload is already attached.")
        return file


class TaskViewSet(
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.ListModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """Tasks visible to their direct collaborators."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = TaskSerializer
    pagination_class = Pagination
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_object(self):
        task = super().get_object()
        shared_via = (self.request.query_params.get("shared_via") or "").strip()
        prepare_task_hierarchy_visibility(
            [task], self.request.user, shared_via=shared_via
        )
        if (
            visible_task_ancestor_path(task, self.request.user, shared_via=shared_via)
            is None
        ):
            raise NotFound()
        return task

    def get_queryset(self):
        user = self.request.user
        parent_fields = _task_parent_select_fields()
        shared_via = ""
        if self.action in SHARED_TASK_ACTIONS:
            shared_via = (self.request.query_params.get("shared_via") or "").strip()
            if shared_via:
                _require_conversation_membership(user, shared_via)
        queryset = (
            models.Task.objects.filter(
                Q(creator=user)
                | Q(assignees=user)
                | Q(assignee=user)
                | Q(followers=user)
                | Q(task_list__accesses__user=user)
                | Q(conversation_shares__cid=shared_via)
            )
            .distinct()
            .annotate(
                _can_edit_task_list=Exists(
                    models.TaskListAccess.objects.filter(
                        task_list_id=OuterRef("task_list_id"),
                        user=user,
                        role__in=TASK_LIST_EDIT_ROLES,
                    )
                ),
                _direct_subtask_count=Count("subtasks", distinct=True),
            )
            .select_related(
                "creator",
                "assignee",
                "recurrence_rule",
                "parent",
                "task_list",
                "group",
                "source_action_item__room",
                *parent_fields,
            )
            .prefetch_related("assignees", "followers")
        )
        queryset = filter_visible_task_hierarchy(queryset, user, shared_via=shared_via)
        queryset = annotate_assignee_local_date(queryset, user=user)
        search_query = ""
        if self.action == "list":
            queryset, search_query = _filter_task_list(
                queryset,
                request=self.request,
                user=user,
            )
        ordering = (
            self.request.query_params.get("ordering", "")
            if self.action == "list"
            else ""
        )
        return _order_tasks(queryset, ordering, search_query)

    def list(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        queryset = self.get_queryset()
        page = self.paginate_queryset(queryset)
        tasks = list(page if page is not None else queryset)
        hierarchy_data = prepare_task_hierarchy_data(tasks, request.user)
        tasks = [
            task
            for task in tasks
            if visible_task_ancestor_path(task, request.user) is not None
        ]
        payload = TaskSerializer(
            tasks,
            many=True,
            context={"request": request, "_task_hierarchy_cache": hierarchy_data},
        ).data
        if page is not None:
            return self.get_paginated_response(payload)
        return Response(payload)

    @action(detail=False, methods=["get"], url_path="activity")
    def activity(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        """Return a newest-first feed for every task visible to the caller."""

        visible_task_ids = self.get_queryset().order_by().values("id")
        queryset = (
            models.TaskActivity.objects.filter(task_id__in=visible_task_ids)
            .select_related("actor", "task")
            .order_by("-created_at")
        )
        page = self.paginate_queryset(queryset)
        activities = page if page is not None else queryset
        payload = TaskActivitySerializer(activities, many=True).data
        if page is not None:
            return self.get_paginated_response(payload)
        return Response(payload)

    @action(
        detail=False,
        methods=["get", "patch"],
        url_path="settings",
        url_name="settings",
    )
    def task_settings(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        """Read or update the caller's cross-device task preferences."""

        preference, _created = models.TaskPreference.objects.get_or_create(
            user=request.user
        )
        if request.method == "PATCH":
            serializer = TaskPreferenceSerializer(
                preference,
                data=request.data,
                partial=True,
            )
            serializer.is_valid(raise_exception=True)
            preference = serializer.save()
            if {
                "daily_reminder_enabled",
                "default_reminder_minutes",
            } & serializer.validated_data.keys():
                supersede_pending_task_reminders(recipient=request.user)
        return Response(TaskPreferenceSerializer(preference).data)

    @action(detail=True, methods=["get", "patch"], url_path="reminder")
    def reminder(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        """Read or update the caller's isolated reminder for one related task."""

        task = self.get_object()
        if not is_task_reminder_participant(task, request.user):
            raise PermissionDenied(
                "Only a task assignee, creator, or follower can manage their reminder."
            )
        global_preference = models.TaskPreference.objects.filter(
            user=request.user
        ).first() or models.TaskPreference(user=request.user)
        preference = models.TaskReminderPreference.objects.filter(
            task=task,
            user=request.user,
        ).first() or models.TaskReminderPreference(
            task=task,
            user=request.user,
            enabled=is_task_assignee(task, request.user),
        )
        context = {"global_preference": global_preference}
        if request.method == "PATCH":
            serializer = TaskReminderPreferenceSerializer(
                preference,
                data=request.data,
                partial=True,
                context=context,
            )
            serializer.is_valid(raise_exception=True)
            with transaction.atomic():
                preference = serializer.save()
                supersede_pending_task_reminders(
                    recipient=request.user,
                    task=task,
                )
        return Response(
            TaskReminderPreferenceSerializer(
                preference,
                context=context,
            ).data
        )

    @action(detail=True, methods=["post"])
    def share(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        """Record card delivery targets without changing task roles."""

        task = self.get_object()
        # `get_object()` only proves the task is visible to the caller (e.g. a
        # task-list VIEWER, a follower, or someone who merely received a shared
        # card). Sharing the card leaks task content into up to 20 conversations,
        # so require content-management permission. A follower is deliberately
        # insufficient: every visible viewer may follow a task, so treating that
        # role as a share grant would let a read-only viewer self-escalate.
        if not _can_manage_task_content(task, request.user):
            raise PermissionDenied("Only task editors can share this task.")
        serializer = TaskShareSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        cids = [
            _require_conversation_membership(request.user, cid)
            for cid in serializer.validated_data["conversation_ids"]
        ]
        try:
            validate_parent_visibility_for_collaborators(
                parent=task.parent,
                conversation_ids=cids,
            )
        except TaskHierarchyError as exc:
            raise _task_hierarchy_validation_error(exc) from exc
        models.TaskConversationShare.objects.bulk_create(
            [
                models.TaskConversationShare(
                    task=task,
                    cid=cid,
                    shared_by=request.user,
                )
                for cid in cids
            ],
            ignore_conflicts=True,
        )
        return Response({"conversation_ids": cids})

    @action(detail=False, methods=["get"], url_path="conversation")
    def conversation(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        """List every task card associated with one current conversation."""

        cid = _require_conversation_membership(
            request.user,
            request.query_params.get("cid"),
        )
        queryset = (
            models.Task.objects.filter(conversation_shares__cid=cid)
            .distinct()
            .annotate(
                _can_edit_task_list=Exists(
                    models.TaskListAccess.objects.filter(
                        task_list_id=OuterRef("task_list_id"),
                        user=request.user,
                        role__in=TASK_LIST_EDIT_ROLES,
                    )
                ),
                _direct_subtask_count=Count("subtasks", distinct=True),
            )
            .select_related(
                "creator",
                "assignee",
                "task_list",
                "group",
                *_task_parent_select_fields(),
            )
            .prefetch_related("assignees", "followers")
            .order_by("status", "due_date", "-conversation_shares__created_at")
        )
        queryset = filter_visible_task_hierarchy(queryset, request.user, shared_via=cid)
        queryset = annotate_assignee_local_date(queryset, user=request.user)
        tasks = list(queryset)
        hierarchy_data = prepare_task_hierarchy_data(
            tasks, request.user, shared_via=cid
        )
        tasks = [
            task
            for task in tasks
            if visible_task_ancestor_path(task, request.user, shared_via=cid)
            is not None
        ]
        return Response(
            TaskSerializer(
                tasks,
                many=True,
                context={
                    "request": request,
                    "_task_hierarchy_cache": hierarchy_data,
                },
            ).data
        )

    def create(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        serializer = TaskCreateSerializer(
            data=request.data,
            context={"request": request},
        )
        serializer.is_valid(raise_exception=True)
        validated_data = dict(serializer.validated_data)
        assignees = validated_data.pop("assignees", None)
        legacy_assignee = validated_data.pop("assignee", None)
        if assignees is None:
            assignees = [legacy_assignee or request.user]
        followers = validated_data.pop("followers", [])
        parent = validated_data.pop("parent", None)
        recurrence = validated_data.pop("recurrence", None)
        reminder = validated_data.pop("reminder", None)
        organization = get_caller_organization(request.user)
        with transaction.atomic():
            lock_task_hierarchy_scopes(
                getattr(organization, "id", None),
                getattr(parent, "organization_id", None),
            )
            try:
                validate_parent_visibility_for_collaborators(
                    parent=parent,
                    users=[request.user, *assignees, *followers],
                    task_list=validated_data.get("task_list"),
                )
                validate_task_parent_change(
                    task=None,
                    parent=parent,
                    organization=organization,
                )
            except TaskHierarchyError as exc:
                raise _task_hierarchy_validation_error(exc) from exc
            task = models.Task.objects.create(
                creator=request.user,
                assignee=assignees[0],
                organization=organization,
                parent=parent,
                **validated_data,
            )
            set_task_assignees(task, assignees)
            task.followers.set(followers)
            if reminder is not None:
                models.TaskReminderPreference.objects.create(
                    task=task,
                    user=request.user,
                    **reminder,
                )
            record_task_created(task=task, actor=request.user)
            record_task_assignment(
                task=task,
                event=models.TaskImDelivery.Event.ASSIGNED,
            )
            if recurrence is not None:
                try:
                    create_task_recurrence_rule(
                        task=task,
                        owner=request.user,
                        recurrence=recurrence,
                    )
                    task.refresh_from_db()
                except TaskRecurrenceError as exc:
                    raise _task_recurrence_validation_error(exc) from exc
        return Response(
            TaskSerializer(task, context={"request": request}).data,
            status=201,
        )

    def partial_update(self, request, *args, **kwargs):  # noqa: PLR0912, PLR0915
        visible_task = self.get_object()
        scope_ids = [visible_task.organization_id]
        requested_parent_id = request.data.get("parent_id")
        try:
            requested_parent_uuid = (
                uuid.UUID(str(requested_parent_id)) if requested_parent_id else None
            )
        except (TypeError, ValueError, AttributeError):
            requested_parent_uuid = None
        if requested_parent_uuid is not None:
            parent_organization_id = (
                models.Task.objects.filter(pk=requested_parent_uuid)
                .values_list("organization_id", flat=True)
                .first()
            )
            scope_ids.append(parent_organization_id)
        with transaction.atomic():
            lock_task_hierarchy_scopes(*scope_ids)
            task = visible_task
            if task.source_action_item_id is not None:
                models.ActionItem.objects.select_for_update().get(
                    pk=task.source_action_item_id
                )
            task = (
                models.Task.objects.select_for_update(of=("self",))
                .select_related(
                    "creator",
                    "assignee",
                    "recurrence_rule",
                    "parent",
                    "task_list",
                    "group",
                    "source_action_item__room",
                )
                .prefetch_related("assignees")
                .get(pk=task.pk)
            )
            history_snapshot = snapshot_task(task)
            previous_assignee_ids = task_assignee_ids(task)
            requested_fields = set(request.data)
            allowed_fields = {
                "title",
                "description",
                "start_date",
                "due_date",
                "priority",
                "task_list_id",
                "group_id",
                "parent_id",
                "confirm_subtree_node_count",
                "position",
                "assignee_id",
                "assignee_ids",
                "status",
                "recurrence_scope",
            }
            if not requested_fields or not requested_fields <= allowed_fields:
                raise serializers.ValidationError(
                    {"detail": "Provide only editable task fields."}
                )
            can_edit_list = _can_edit_task_list(task.task_list, request.user)
            if task.creator_id != request.user.id and not can_edit_list:
                if not is_task_assignee(task, request.user):
                    raise PermissionDenied("Only task editors can update this task.")
            serializer = TaskUpdateSerializer(
                task,
                data=request.data,
                partial=True,
                context={"request": request},
            )
            serializer.is_valid(raise_exception=True)
            recurrence_scope = serializer.validated_data.get("recurrence_scope")
            inherited_fields = {
                "title",
                "description",
                "start_date",
                "due_date",
                "priority",
                "task_list_id",
                "group_id",
                "assignee_id",
                "assignee_ids",
            }
            recurrence_is_active = bool(
                task.recurrence_rule_id and task.recurrence_rule.is_active
            )
            if recurrence_is_active and requested_fields & inherited_fields:
                if recurrence_scope is None:
                    raise serializers.ValidationError(
                        {
                            "recurrence_scope": (
                                "Choose whether to change only this task or this "
                                "and following tasks."
                            )
                        }
                    )
            prospective_parent = serializer.validated_data.get("parent", task.parent)
            prospective_assignees = serializer.validated_data.get("assignees")
            legacy_assignee = serializer.validated_data.get("assignee")
            if prospective_assignees is not None or legacy_assignee is not None:
                try:
                    validate_parent_visibility_for_collaborators(
                        parent=prospective_parent,
                        users=prospective_assignees or [legacy_assignee],
                    )
                except TaskHierarchyError as exc:
                    raise _task_hierarchy_validation_error(exc) from exc
            if "task_list" in serializer.validated_data:
                try:
                    validate_parent_visibility_for_collaborators(
                        parent=prospective_parent,
                        task_list=serializer.validated_data["task_list"],
                    )
                except TaskHierarchyError as exc:
                    raise _task_hierarchy_validation_error(exc) from exc
            if "parent" in serializer.validated_data:
                moved_nodes = task_subtree(task, for_update=True)
                if any(
                    not _can_manage_task_content(node, request.user)
                    for node in moved_nodes
                ):
                    raise PermissionDenied(
                        "You must be able to edit every task in the moved subtree."
                    )
                if len(moved_nodes) > 1 and serializer.validated_data.get(
                    "confirm_subtree_node_count"
                ) != len(moved_nodes):
                    raise serializers.ValidationError(
                        {
                            "confirm_subtree_node_count": {
                                "code": "task_subtree_confirmation_required",
                                "detail": (
                                    "Confirm the current subtree node count before "
                                    "moving a parent task."
                                ),
                                "expected": len(moved_nodes),
                            }
                        }
                    )
                try:
                    validate_subtree_parent_visibility(
                        subtree=moved_nodes,
                        parent=serializer.validated_data["parent"],
                    )
                    validate_task_parent_change(
                        task=task,
                        parent=serializer.validated_data["parent"],
                        organization=task.organization,
                    )
                except TaskHierarchyError as exc:
                    raise _task_hierarchy_validation_error(exc) from exc
            serializer.save()
            if recurrence_scope == "following" and not recurrence_is_active:
                raise serializers.ValidationError(
                    {"recurrence_scope": "The recurrence rule is not active."}
                )
            if recurrence_scope == "following":
                try:
                    update_task_recurrence_rule(
                        task=task,
                        actor=request.user,
                        reset_schedule=bool(
                            requested_fields & {"start_date", "due_date"}
                        ),
                    )
                except TaskRecurrenceError as exc:
                    raise _task_recurrence_validation_error(exc) from exc
            activities = record_task_changes(
                task=task,
                actor=request.user,
                before=history_snapshot,
            )
            status_activity = next(
                (
                    activity
                    for activity in activities
                    if activity.event == models.TaskActivity.Event.STATUS_CHANGED
                ),
                None,
            )
            if status_activity is not None:
                sync_action_item_from_task_status(activity=status_activity)
            current_assignee_ids = task_assignee_ids(task)
            if current_assignee_ids != previous_assignee_ids:
                record_task_assignment(
                    task=task,
                    event=models.TaskImDelivery.Event.REASSIGNED,
                    recipient_ids=current_assignee_ids - previous_assignee_ids,
                )
            else:
                date_activity = next(
                    (
                        activity
                        for activity in activities
                        if activity.event == models.TaskActivity.Event.DATES_CHANGED
                    ),
                    None,
                )
                if date_activity is not None:
                    record_task_date_change(activity=date_activity)
                if status_activity is not None:
                    record_task_status_change(activity=status_activity)
                priority_activity = next(
                    (
                        activity
                        for activity in activities
                        if activity.event == models.TaskActivity.Event.PRIORITY_CHANGED
                    ),
                    None,
                )
                if priority_activity is not None:
                    record_task_priority_change(activity=priority_activity)
            if (
                status_activity is not None
                and task.status == models.Task.Status.COMPLETED
                and task.recurrence_rule_id is not None
            ):
                materialize_task_recurrence(task.recurrence_rule_id, force=True)
            response_data = TaskSerializer(task, context={"request": request}).data
        return Response(response_data)

    @action(detail=True, methods=["post", "patch", "delete"])
    def recurrence(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        """Create, update or stop the current-and-following recurrence rule."""

        visible_task = self.get_object()
        if visible_task.creator_id != request.user.id:
            raise PermissionDenied("Only the task creator can manage recurrence.")
        if request.method == "DELETE":
            try:
                deactivate_task_recurrence_rule(
                    task=visible_task,
                    actor=request.user,
                )
            except TaskRecurrenceError as exc:
                raise _task_recurrence_validation_error(exc) from exc
            visible_task.refresh_from_db()
            return Response(
                TaskSerializer(visible_task, context={"request": request}).data
            )

        serializer = TaskRecurrenceInputSerializer(
            data=request.data,
            partial=visible_task.recurrence_rule_id is not None,
        )
        serializer.is_valid(raise_exception=True)
        if (
            visible_task.recurrence_rule_id is None
            and "frequency" not in serializer.validated_data
        ):
            raise serializers.ValidationError(
                {"frequency": "This field is required for a new recurrence rule."}
            )
        if not serializer.validated_data:
            raise serializers.ValidationError(
                {"detail": "Provide at least one recurrence field."}
            )
        try:
            update_task_recurrence_rule(
                task=visible_task,
                actor=request.user,
                recurrence=serializer.validated_data,
                reset_schedule=True,
            )
        except TaskRecurrenceError as exc:
            raise _task_recurrence_validation_error(exc) from exc
        visible_task.refresh_from_db()
        return Response(TaskSerializer(visible_task, context={"request": request}).data)

    def destroy(self, request, *args, **kwargs):
        visible_task = self.get_object()
        with transaction.atomic():
            lock_task_hierarchy_scopes(visible_task.organization_id)
            task = (
                models.Task.objects.select_for_update(of=("self",))
                .select_related("task_list")
                .get(pk=visible_task.pk)
            )
            subtree = task_subtree(task, for_update=True)
            if any(
                node.creator_id != request.user.id
                and not _can_edit_task_list(node.task_list, request.user)
                for node in subtree
            ):
                raise PermissionDenied(
                    "You must be able to delete every task in the subtree."
                )
            if len(subtree) > 1:
                try:
                    confirmed_count = int(
                        request.query_params.get("confirm_subtree_node_count", "")
                    )
                except ValueError:
                    confirmed_count = 0
                if confirmed_count != len(subtree):
                    raise serializers.ValidationError(
                        {
                            "confirm_subtree_node_count": {
                                "code": "task_subtree_confirmation_required",
                                "detail": (
                                    "Confirm the current subtree node count before "
                                    "deleting a parent task."
                                ),
                                "expected": len(subtree),
                            }
                        }
                    )
            action_item_ids = [
                node.source_action_item_id
                for node in subtree
                if node.source_action_item_id is not None
            ]
            if action_item_ids:
                models.ActionItem.objects.filter(pk__in=action_item_ids).update(
                    task_id=None
                )
            recurrence_rule_ids = {
                node.recurrence_rule_id
                for node in subtree
                if node.recurrence_rule_id is not None
            }
            if recurrence_rule_ids:
                models.TaskRecurrenceRule.objects.filter(
                    pk__in=recurrence_rule_ids
                ).update(is_active=False, next_occurrence_date=None, last_error="")
            _delete_tasks_with_attachments(
                models.Task.objects.filter(pk__in=[node.pk for node in subtree]),
                actor=request.user,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get"], url_path="subtree-impact")
    def subtree_impact(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        task = self.get_object()
        subtree = task_subtree(task)
        shared_via = (request.query_params.get("shared_via") or "").strip()
        chains = prepare_task_hierarchy_visibility(
            subtree, request.user, shared_via=shared_via
        )
        if any(
            visible_task_ancestor_path(node, request.user, shared_via=shared_via)
            is None
            for node in subtree
        ):
            raise PermissionDenied("The complete task subtree must be visible.")
        return Response(
            {
                "task_id": str(task.pk),
                "node_count": len(subtree),
                "descendant_count": len(subtree) - 1,
                "maximum_depth": max(len(chain) - 1 for chain in chains.values()),
            }
        )

    @action(detail=True, methods=["get"])
    def subtasks(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        parent = self.get_object()
        shared_via = (request.query_params.get("shared_via") or "").strip()
        queryset = (
            self.get_queryset().filter(parent=parent).order_by("position", "created_at")
        )
        candidates = list(queryset)
        hierarchy_data = prepare_task_hierarchy_data(
            candidates,
            request.user,
            shared_via=shared_via,
        )
        children = [
            task
            for task in candidates
            if visible_task_ancestor_path(
                task,
                request.user,
                shared_via=shared_via,
            )
            is not None
        ]
        return Response(
            TaskSerializer(
                children,
                many=True,
                context={
                    "request": request,
                    "_task_hierarchy_cache": hierarchy_data,
                },
            ).data
        )

    @action(detail=True, methods=["post"], url_path="subtasks/reorder")
    def reorder_subtasks(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        """Atomically replace the display order of all direct subtasks."""

        visible_parent = self.get_object()
        serializer = TaskSubtaskOrderSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        ordered_ids = serializer.validated_data["task_ids"]
        with transaction.atomic():
            lock_task_hierarchy_scopes(visible_parent.organization_id)
            parent = (
                models.Task.objects.select_for_update(of=("self",))
                .select_related("task_list")
                .get(pk=visible_parent.pk)
            )
            children = list(
                models.Task.objects.select_for_update(of=("self",))
                .filter(parent=parent)
                .select_related("task_list")
                .order_by("position", "created_at")
            )
            if not _can_manage_task_content(parent, request.user) or any(
                not _can_manage_task_content(child, request.user) for child in children
            ):
                raise PermissionDenied(
                    "You must be able to edit the parent and every direct subtask."
                )
            children_by_id = {child.pk: child for child in children}
            if set(ordered_ids) != set(children_by_id):
                raise serializers.ValidationError(
                    {
                        "task_ids": {
                            "code": "task_subtask_order_changed",
                            "detail": (
                                "Refresh subtasks before saving a changed order."
                            ),
                        }
                    }
                )
            ordered_children = []
            for position, child_id in enumerate(ordered_ids):
                child = children_by_id[child_id]
                child.position = position
                ordered_children.append(child)
            models.Task.objects.bulk_update(ordered_children, ["position"])

        hierarchy_data = prepare_task_hierarchy_data(ordered_children, request.user)
        return Response(
            TaskSerializer(
                ordered_children,
                many=True,
                context={
                    "request": request,
                    "_task_hierarchy_cache": hierarchy_data,
                },
            ).data
        )

    @action(detail=True, methods=["get"], url_path="parent-candidates")
    def parent_candidates(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        task = self.get_object()
        excluded_ids = {node.pk for node in task_subtree(task)}
        query = (request.query_params.get("q") or "").strip()
        candidates = self.get_queryset().filter(organization=task.organization)
        if query:
            candidates = candidates.filter(title__icontains=query)
        candidates = list(
            candidates.exclude(pk__in=excluded_ids).order_by("title")[:20]
        )
        prepare_task_hierarchy_visibility(candidates, request.user)
        payload = []
        for candidate in candidates:
            path = visible_task_ancestor_path(candidate, request.user)
            if path is None or not _can_manage_task_content(candidate, request.user):
                continue
            payload.append(
                {
                    "id": str(candidate.pk),
                    "title": candidate.title,
                    "depth": len(path) - 1,
                    "ancestor_path": path,
                }
            )
        return Response(payload)

    @action(detail=True, methods=["get"])
    def activities(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        task = self.get_object()
        activities = task.activities.select_related("actor", "task").order_by(
            "-created_at"
        )
        return Response(TaskActivitySerializer(activities, many=True).data)

    @action(detail=True, methods=["post", "delete"])
    def follow(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        """Let a visible task's current viewer follow or unfollow it."""

        task = self.get_object()
        if request.method == "DELETE":
            task.followers.remove(request.user)
            supersede_ineligible_task_reminders(task=task)
            return Response(TaskSerializer(task, context={"request": request}).data)

        task.followers.add(request.user)
        return Response(TaskSerializer(task, context={"request": request}).data)

    @action(detail=True, methods=["post"], url_path="followers")
    def follower_add(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        """Add one or more followers as the creator or current assignee."""

        task = self.get_object()
        if task.creator_id != request.user.id and not is_task_assignee(
            task, request.user
        ):
            raise PermissionDenied(
                "Only the task creator or assignee can manage followers."
            )
        serializer = TaskFollowerSerializer(
            data=request.data,
            context={"request": request},
        )
        serializer.is_valid(raise_exception=True)
        task.followers.add(*serializer.validated_data["followers"])
        return Response(TaskSerializer(task, context={"request": request}).data)

    @action(
        detail=True,
        methods=["delete"],
        url_path=r"followers/(?P<follower_id>[^/.]+)",
    )
    def follower_remove(self, request, follower_id=None, *args, **kwargs):  # pylint: disable=unused-argument
        """Remove one follower as the creator or current assignee."""

        task = self.get_object()
        if task.creator_id != request.user.id and not is_task_assignee(
            task, request.user
        ):
            raise PermissionDenied(
                "Only the task creator or assignee can manage followers."
            )
        task.followers.remove(follower_id)
        supersede_ineligible_task_reminders(task=task)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["get"], url_path="standalone-count")
    def standalone_count(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        """Return the number of visible tasks that do not belong to a task list."""

        count = self.get_queryset().filter(task_list__isnull=True).count()
        return Response({"count": count})

    @action(detail=False, methods=["get"])
    def statistics(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        """Aggregate the same task set the caller is already allowed to list."""

        hierarchy_scope = request.query_params.get("hierarchy", "include_descendants")
        if hierarchy_scope not in {"include_descendants", "roots_only"}:
            raise serializers.ValidationError(
                {"hierarchy": ("Choose either include_descendants or roots_only.")}
            )
        queryset, _search_query = _filter_task_list(
            self.get_queryset(),
            request=request,
            user=request.user,
            include_search=False,
        )
        if hierarchy_scope == "roots_only":
            queryset = queryset.filter(parent__isnull=True)
        open_statuses = [models.Task.Status.TODO]
        overdue_filter = (
            Q(status__in=open_statuses)
            & (Q(assignees__isnull=False) | Q(assignee__isnull=False))
            & Q(due_date__lt=F("_assignee_local_date"))
        )
        summary = queryset.aggregate(
            total=Count("id", distinct=True),
            open=Count("id", filter=Q(status__in=open_statuses), distinct=True),
            completed=Count(
                "id",
                filter=Q(status=models.Task.Status.COMPLETED),
                distinct=True,
            ),
            overdue=Count("id", filter=overdue_filter, distinct=True),
        )
        summary["completion_rate"] = (
            round(summary["completed"] * 100 / summary["total"])
            if summary["total"]
            else 0
        )
        workload_by_id = {}
        for task in queryset.select_related("assignee").prefetch_related("assignees"):
            assignees = list(task.assignees.all())
            if not assignees and task.assignee is not None:
                assignees = [task.assignee]
            for assignee in assignees:
                item = workload_by_id.setdefault(
                    assignee.id,
                    {
                        "assignee_id": str(assignee.id),
                        "assignee__full_name": assignee.full_name,
                        "assignee__short_name": assignee.short_name,
                        "assignee__email": assignee.email,
                        "assignee__avatar_url": utils.generate_profile_image_get_url(
                            "avatar", assignee.avatar_key
                        ),
                        "total": 0,
                        "open": 0,
                        "completed": 0,
                        "overdue": 0,
                    },
                )
                item["total"] += 1
                if task.status == models.Task.Status.COMPLETED:
                    item["completed"] += 1
                else:
                    item["open"] += 1
                    if (
                        task.due_date is not None
                        and task.due_date < local_date_for_user(assignee)
                    ):
                        item["overdue"] += 1
        workload = sorted(
            workload_by_id.values(),
            key=lambda item: (
                -item["open"],
                item["assignee__full_name"]
                or item["assignee__short_name"]
                or item["assignee__email"]
                or item["assignee_id"],
            ),
        )
        groups = list(
            queryset.values("group_id", "group__name", "group__sort_order")
            .annotate(
                total=Count("id", distinct=True),
                completed=Count(
                    "id",
                    filter=Q(status=models.Task.Status.COMPLETED),
                    distinct=True,
                ),
            )
            .order_by("group__sort_order", "group__name", "group_id")
        )
        return Response(
            {
                "hierarchy_scope": hierarchy_scope,
                "summary": summary,
                "workload": workload,
                "groups": groups,
            }
        )

    @action(detail=True, methods=["get", "post"])
    def comments(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        task = self.get_object()
        if request.method == "GET":
            comments = task.comments.select_related("author").order_by("created_at")
            return Response(TaskCommentSerializer(comments, many=True).data)

        if not _can_comment_on_task(task, request.user):
            raise PermissionDenied("Only task collaborators can add comments.")

        serializer = TaskCommentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            comment = serializer.save(task=task, author=request.user)
            record_task_comment(comment=comment)
        return Response(TaskCommentSerializer(comment).data, status=201)

    @action(detail=True, methods=["get", "post"])
    def attachments(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        task = self.get_object()
        if request.method == "GET":
            attachments = (
                task.attachments.filter(
                    file__deleted_at__isnull=True,
                    file__hard_deleted_at__isnull=True,
                    file__upload_state=models.FileUploadStateChoices.READY,
                )
                .select_related("file", "uploader")
                .order_by("created_at")
            )
            return Response(
                TaskAttachmentSerializer(
                    attachments,
                    many=True,
                    context={"request": request},
                ).data
            )

        if not _can_manage_task_content(task, request.user):
            raise PermissionDenied("Only task collaborators can add attachments.")

        serializer = TaskAttachmentCreateSerializer(
            data=request.data,
            context={"request": request},
        )
        serializer.is_valid(raise_exception=True)
        attachment = models.TaskAttachment.objects.create(
            task=task,
            file=serializer.validated_data["file"],
            uploader=request.user,
        )
        return Response(
            TaskAttachmentSerializer(attachment, context={"request": request}).data,
            status=201,
        )

    @action(
        detail=True,
        methods=["get"],
        url_path=r"attachments/(?P<attachment_id>[^/.]+)/download",
    )
    def attachment_download(self, request, attachment_id=None, *args, **kwargs):
        """Authorize a task collaborator, then redirect to a short-lived object URL."""
        task = self.get_object()
        attachment = get_object_or_404(
            task.attachments.select_related("file"),
            id=attachment_id,
            file__deleted_at__isnull=True,
            file__hard_deleted_at__isnull=True,
            file__upload_state=models.FileUploadStateChoices.READY,
        )
        return Response(
            status=302,
            headers={"Location": utils.generate_file_download_url(attachment.file)},
        )

    @action(
        detail=True,
        methods=["delete"],
        url_path=r"attachments/(?P<attachment_id>[^/.]+)",
    )
    def attachment_remove(self, request, attachment_id=None, *args, **kwargs):
        """Remove an attachment and queue deletion from its persisted bucket."""
        task = self.get_object()
        if not _can_manage_task_content(task, request.user):
            raise PermissionDenied("Only task collaborators can remove attachments.")
        attachment = get_object_or_404(
            task.attachments.select_related("file"),
            id=attachment_id,
            file__deleted_at__isnull=True,
            file__hard_deleted_at__isnull=True,
        )
        attachment_id = attachment.id
        file = attachment.file
        with transaction.atomic():
            attachment.delete()
            file.soft_delete()
            file.hard_delete()
            models.TaskActivity.objects.create(
                task=task,
                actor=request.user,
                event=models.TaskActivity.Event.ATTACHMENT_REMOVED,
                changes={
                    "attachment": {
                        "id": str(attachment_id),
                        "filename": file.filename,
                    }
                },
            )
            transaction.on_commit(lambda: process_file_deletion.delay(file.id))
        return Response(status=204)
