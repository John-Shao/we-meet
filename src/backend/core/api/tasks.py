"""Minimal standalone task API."""

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Case, Count, F, IntegerField, Q, Value, When
from django.shortcuts import get_object_or_404
from django.utils import timezone

from rest_framework import mixins, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from core import models, utils
from core.api import permissions
from core.api.directory import get_caller_organization, is_caller_org_admin
from core.api.serializers import (
    TaskActivitySerializer,
    TaskAttachmentSerializer,
    TaskCommentSerializer,
    TaskLabelSerializer,
    TaskSerializer,
)
from core.api.viewsets import Pagination
from core.services.task_action_item_sync import sync_action_item_from_task_status
from core.services.task_history import (
    record_task_changes,
    record_task_created,
    snapshot_task,
)
from core.services.task_notifications import (
    record_task_assignment,
    record_task_comment,
    record_task_date_change,
    record_task_priority_change,
    record_task_status_change,
)
from core.services.task_time import TIME_FILTERS, annotate_assignee_local_date
from core.services.tasks import TaskAssigneeError, ensure_task_assignee_allowed
from core.tasks.file import process_file_deletion


def _order_tasks(queryset):
    """Keep top-level and subtask lists on the same deterministic order."""

    status_rank = Case(
        When(status=models.Task.Status.IN_PROGRESS, then=Value(0)),
        When(status=models.Task.Status.TODO, then=Value(1)),
        When(status=models.Task.Status.COMPLETED, then=Value(2)),
        When(status=models.Task.Status.CANCELED, then=Value(3)),
        default=Value(4),
        output_field=IntegerField(),
    )
    priority_rank = Case(
        When(priority=models.Task.Priority.URGENT, then=Value(0)),
        When(priority=models.Task.Priority.HIGH, then=Value(1)),
        When(priority=models.Task.Priority.MEDIUM, then=Value(2)),
        When(priority=models.Task.Priority.LOW, then=Value(3)),
        When(priority=models.Task.Priority.NONE, then=Value(4)),
        default=Value(5),
        output_field=IntegerField(),
    )
    return queryset.order_by(
        status_rank,
        priority_rank,
        F("due_date").asc(nulls_last=True),
        "-updated_at",
        "id",
    )


def _filter_task_list(queryset, *, request, user):
    """Apply validated list filters without growing the viewset branch count."""

    queryset = queryset.filter(parent__isnull=True)
    scope = request.query_params.get("scope", "assigned")
    if scope == "assigned":
        queryset = queryset.filter(assignee=user)
    elif scope == "created":
        queryset = queryset.filter(creator=user)
    elif scope != "all":
        raise serializers.ValidationError({"scope": "Use assigned, created, or all."})

    status_filter = request.query_params.get("status", "all")
    if status_filter == "open":
        queryset = queryset.exclude(
            status__in=[models.Task.Status.COMPLETED, models.Task.Status.CANCELED]
        )
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

    queryset = _filter_by_label(
        queryset,
        label_filter=request.query_params.get("label", "all"),
        user=user,
    )

    time_filter = request.query_params.get("time", "all")
    if time_filter not in TIME_FILTERS:
        raise serializers.ValidationError(
            {"time": "Use all, starting_today, due_today, or overdue."}
        )
    if time_filter == "all":
        return queryset

    queryset = queryset.filter(
        status__in=[models.Task.Status.TODO, models.Task.Status.IN_PROGRESS],
        assignee__isnull=False,
    )
    if time_filter == "starting_today":
        return queryset.filter(start_date=F("_assignee_local_date")).exclude(
            due_date=F("_assignee_local_date")
        )
    if time_filter == "due_today":
        return queryset.filter(due_date=F("_assignee_local_date"))
    return queryset.filter(due_date__lt=F("_assignee_local_date"))


def _filter_by_label(queryset, *, label_filter, user):
    """Apply one organization-scoped label or the explicit unlabeled filter."""

    if label_filter == "unlabeled":
        return queryset.filter(labels__isnull=True)
    if label_filter == "all":
        return queryset
    organization = get_caller_organization(user)
    try:
        label = models.TaskLabel.objects.get(
            id=label_filter,
            organization=organization,
        )
    except (
        ValueError,
        DjangoValidationError,
        models.TaskLabel.DoesNotExist,
    ) as exc:
        raise serializers.ValidationError(
            {"label": "Use all, unlabeled, or a label from your organization."}
        ) from exc
    return queryset.filter(labels=label)


class TaskAssigneeValidationMixin:
    """Validate assignees against the caller's organization directory."""

    def validate_assignee_id(self, assignee):
        request = self.context["request"]
        try:
            ensure_task_assignee_allowed(creator=request.user, assignee=assignee)
        except TaskAssigneeError as exc:
            raise serializers.ValidationError(str(exc)) from exc
        return assignee


class TaskLabelsValidationMixin:
    """Keep task labels within one stable organization boundary."""

    max_labels = 5

    def validate_label_ids(self, labels):
        if len(labels) > self.max_labels:
            raise serializers.ValidationError(
                f"Choose at most {self.max_labels} task labels."
            )
        organization = (
            self.instance.organization
            if getattr(self, "instance", None) is not None
            else get_caller_organization(self.context["request"].user)
        )
        if labels and (
            organization is None
            or any(label.organization_id != organization.id for label in labels)
        ):
            raise serializers.ValidationError(
                "Choose labels from the task organization."
            )
        return labels


class TaskCreateSerializer(
    TaskLabelsValidationMixin,
    TaskAssigneeValidationMixin,
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
        choices=models.Task.Priority.choices,
        required=False,
        default=models.Task.Priority.NONE,
    )
    assignee_id = serializers.PrimaryKeyRelatedField(
        source="assignee",
        queryset=models.User.objects.all(),
        required=False,
        write_only=True,
    )
    label_ids = serializers.PrimaryKeyRelatedField(
        source="labels",
        queryset=models.TaskLabel.objects.all(),
        many=True,
        required=False,
        write_only=True,
    )

    def validate(self, attrs):
        if (
            attrs.get("start_date")
            and attrs.get("due_date")
            and attrs["start_date"] > attrs["due_date"]
        ):
            raise serializers.ValidationError(
                {"due_date": "Due date cannot be earlier than start date."}
            )
        return attrs


class TaskUpdateSerializer(
    TaskLabelsValidationMixin,
    TaskAssigneeValidationMixin,
    serializers.ModelSerializer,
):
    """Editable fields and state-machine validation for one task."""

    _TRANSITIONS = {
        models.Task.Status.TODO: {
            models.Task.Status.IN_PROGRESS,
            models.Task.Status.COMPLETED,
            models.Task.Status.CANCELED,
        },
        models.Task.Status.IN_PROGRESS: {
            models.Task.Status.TODO,
            models.Task.Status.COMPLETED,
            models.Task.Status.CANCELED,
        },
        models.Task.Status.COMPLETED: {models.Task.Status.TODO},
        models.Task.Status.CANCELED: {models.Task.Status.TODO},
    }

    title = serializers.CharField(max_length=500, trim_whitespace=True)
    description = serializers.CharField(allow_blank=True, max_length=5000)
    assignee_id = serializers.PrimaryKeyRelatedField(
        source="assignee",
        queryset=models.User.objects.all(),
        required=False,
        write_only=True,
    )
    label_ids = serializers.PrimaryKeyRelatedField(
        source="labels",
        queryset=models.TaskLabel.objects.all(),
        many=True,
        required=False,
        write_only=True,
    )

    class Meta:
        model = models.Task
        fields = [
            "title",
            "description",
            "start_date",
            "due_date",
            "priority",
            "label_ids",
            "assignee_id",
            "status",
        ]

    def validate(self, attrs):
        attrs = super().validate(attrs)
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

    def update(self, instance, validated_data):
        previous_status = instance.status
        instance = super().update(instance, validated_data)
        if instance.status == previous_status:
            return instance
        instance.completed_at = (
            timezone.now() if instance.status == models.Task.Status.COMPLETED else None
        )
        instance.save(update_fields=["completed_at", "updated_at"])
        return instance


class TaskLabelViewSet(
    mixins.CreateModelMixin,
    mixins.ListModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """Organization-scoped reusable labels managed by task collaborators."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = TaskLabelSerializer
    pagination_class = None
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["can_manage_all_labels"] = is_caller_org_admin(self.request.user)
        return context

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.TaskLabel.objects.none()
        return models.TaskLabel.objects.filter(organization=organization).order_by(
            "name", "id"
        )

    def perform_create(self, serializer):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            raise serializers.ValidationError(
                {"detail": "Join an organization before creating task labels."}
            )
        self._validate_unique_name(serializer.validated_data["name"], organization)
        serializer.save(organization=organization, creator=self.request.user)

    def perform_update(self, serializer):
        label = self.get_object()
        self._ensure_can_manage(label)
        name = serializer.validated_data.get("name", label.name)
        self._validate_unique_name(name, label.organization, exclude=label)
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        label = self.get_object()
        self._ensure_can_manage(label)
        label.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _ensure_can_manage(self, label):
        if label.creator_id != self.request.user.id and not is_caller_org_admin(
            self.request.user
        ):
            raise PermissionDenied(
                "Only the label creator or an organization administrator can manage it."
            )

    @staticmethod
    def _validate_unique_name(name, organization, exclude=None):
        queryset = models.TaskLabel.objects.filter(
            organization=organization,
            name__iexact=name,
        )
        if exclude is not None:
            queryset = queryset.exclude(pk=exclude.pk)
        if queryset.exists():
            raise serializers.ValidationError(
                {"name": "This organization already has a label with this name."}
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
    viewsets.GenericViewSet,
):
    """Tasks visible to direct or inherited parent collaborators."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = TaskSerializer
    pagination_class = Pagination
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self):
        user = self.request.user
        queryset = (
            models.Task.objects.filter(
                Q(creator=user)
                | Q(assignee=user)
                | Q(parent__creator=user)
                | Q(parent__assignee=user)
            )
            .distinct()
            .select_related(
                "creator",
                "assignee",
                "parent__creator",
                "parent__assignee",
                "source_action_item__room",
            )
            .prefetch_related("labels")
            .annotate(
                _subtask_count=Count("subtasks", distinct=True),
                _completed_subtask_count=Count(
                    "subtasks",
                    filter=Q(subtasks__status=models.Task.Status.COMPLETED),
                    distinct=True,
                ),
            )
        )
        queryset = annotate_assignee_local_date(queryset)
        if self.action == "list":
            queryset = _filter_task_list(
                queryset,
                request=self.request,
                user=user,
            )
        return _order_tasks(queryset)

    def create(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        serializer = TaskCreateSerializer(
            data=request.data,
            context={"request": request},
        )
        serializer.is_valid(raise_exception=True)
        validated_data = dict(serializer.validated_data)
        assignee = validated_data.pop("assignee", request.user)
        labels = validated_data.pop("labels", [])
        with transaction.atomic():
            task = models.Task.objects.create(
                creator=request.user,
                assignee=assignee,
                organization=get_caller_organization(request.user),
                **validated_data,
            )
            task.labels.set(labels)
            record_task_created(task=task, actor=request.user)
            record_task_assignment(
                task=task,
                event=models.TaskImDelivery.Event.ASSIGNED,
            )
        return Response(
            TaskSerializer(task, context={"request": request}).data,
            status=201,
        )

    def partial_update(self, request, *args, **kwargs):
        with transaction.atomic():
            task = self.get_object()
            if task.source_action_item_id is not None:
                models.ActionItem.objects.select_for_update().get(
                    pk=task.source_action_item_id
                )
            task = (
                models.Task.objects.select_for_update(of=("self",))
                .select_related(
                    "creator",
                    "assignee",
                    "parent__creator",
                    "parent__assignee",
                    "source_action_item__room",
                )
                .prefetch_related("labels")
                .get(pk=task.pk)
            )
            history_snapshot = snapshot_task(task)
            previous_assignee_id = task.assignee_id
            requested_fields = set(request.data)
            allowed_fields = {
                "title",
                "description",
                "start_date",
                "due_date",
                "priority",
                "label_ids",
                "assignee_id",
                "status",
            }
            if not requested_fields or not requested_fields <= allowed_fields:
                raise serializers.ValidationError(
                    {"detail": "Provide only editable task fields."}
                )
            if task.creator_id != request.user.id and requested_fields != {"status"}:
                raise PermissionDenied("Assignees can only update the task status.")
            if task.creator_id != request.user.id and (
                task.status == models.Task.Status.CANCELED
                or request.data.get("status") == models.Task.Status.CANCELED
            ):
                raise PermissionDenied(
                    "Only the task creator can cancel or reopen a canceled task."
                )

            serializer = TaskUpdateSerializer(
                task,
                data=request.data,
                partial=True,
                context={"request": request},
            )
            serializer.is_valid(raise_exception=True)
            serializer.save()
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
            if task.assignee_id != previous_assignee_id:
                record_task_assignment(
                    task=task,
                    event=models.TaskImDelivery.Event.REASSIGNED,
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
            response_data = TaskSerializer(task, context={"request": request}).data
        return Response(response_data)

    @action(detail=True, methods=["get"])
    def activities(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        task = self.get_object()
        activities = task.activities.select_related("actor").order_by("-created_at")
        return Response(TaskActivitySerializer(activities, many=True).data)

    @action(detail=True, methods=["get", "post"])
    def subtasks(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        parent = self.get_object()
        if request.method == "GET":
            subtasks = _order_tasks(
                parent.subtasks.select_related(
                    "creator",
                    "assignee",
                    "parent__creator",
                    "parent__assignee",
                )
                .prefetch_related("labels")
                .annotate(
                    _subtask_count=Count("subtasks", distinct=True),
                    _completed_subtask_count=Count(
                        "subtasks",
                        filter=Q(subtasks__status=models.Task.Status.COMPLETED),
                        distinct=True,
                    ),
                )
            )
            return Response(
                TaskSerializer(
                    subtasks,
                    many=True,
                    context={"request": request},
                ).data
            )

        if parent.parent_id is not None:
            raise serializers.ValidationError(
                {"parent": "Subtasks can only be created under a top-level task."}
            )

        serializer = TaskCreateSerializer(
            data=request.data,
            context={"request": request},
        )
        serializer.is_valid(raise_exception=True)
        validated_data = dict(serializer.validated_data)
        assignee = validated_data.pop("assignee", request.user)
        labels = validated_data.pop("labels", [])
        with transaction.atomic():
            subtask = models.Task.objects.create(
                parent=parent,
                creator=request.user,
                assignee=assignee,
                organization=parent.organization
                or get_caller_organization(request.user),
                **validated_data,
            )
            subtask.labels.set(labels)
            record_task_created(task=subtask, actor=request.user)
            record_task_assignment(
                task=subtask,
                event=models.TaskImDelivery.Event.ASSIGNED,
            )
        return Response(
            TaskSerializer(subtask, context={"request": request}).data,
            status=201,
        )

    @action(detail=True, methods=["get", "post"])
    def comments(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        task = self.get_object()
        if request.method == "GET":
            comments = task.comments.select_related("author").order_by("created_at")
            return Response(TaskCommentSerializer(comments, many=True).data)

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
            return Response(TaskAttachmentSerializer(attachments, many=True).data)

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
        return Response(TaskAttachmentSerializer(attachment).data, status=201)

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
