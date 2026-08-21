"""Minimal standalone task API."""

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from core import models
from core.api import permissions
from core.api.serializers import (
    TaskActivitySerializer,
    TaskCommentSerializer,
    TaskSerializer,
)
from core.api.viewsets import Pagination
from core.services.task_history import (
    record_task_changes,
    record_task_created,
    snapshot_task,
)
from core.services.task_notifications import record_task_assignment, record_task_comment
from core.services.tasks import TaskAssigneeError, ensure_task_assignee_allowed


class TaskAssigneeValidationMixin:
    """Validate assignees against the caller's organization directory."""

    def validate_assignee_id(self, assignee):
        request = self.context["request"]
        try:
            ensure_task_assignee_allowed(creator=request.user, assignee=assignee)
        except TaskAssigneeError as exc:
            raise serializers.ValidationError(str(exc)) from exc
        return assignee


class TaskCreateSerializer(TaskAssigneeValidationMixin, serializers.Serializer):
    """Input for a task created by the caller and assigned to a colleague."""

    title = serializers.CharField(max_length=500, trim_whitespace=True)
    description = serializers.CharField(
        required=False, allow_blank=True, max_length=5000, default=""
    )
    start_date = serializers.DateField(required=False, allow_null=True)
    due_date = serializers.DateField(required=False, allow_null=True)
    assignee_id = serializers.PrimaryKeyRelatedField(
        source="assignee",
        queryset=models.User.objects.all(),
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


class TaskUpdateSerializer(TaskAssigneeValidationMixin, serializers.ModelSerializer):
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

    class Meta:
        model = models.Task
        fields = [
            "title",
            "description",
            "start_date",
            "due_date",
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


class TaskViewSet(
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.ListModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """Tasks visible to the caller as creator or assignee."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = TaskSerializer
    pagination_class = Pagination
    http_method_names = ["get", "post", "patch", "head", "options"]

    def get_queryset(self):
        user = self.request.user
        queryset = (
            models.Task.objects.filter(Q(creator=user) | Q(assignee=user))
            .distinct()
            .select_related(
                "creator",
                "assignee",
                "source_action_item__room",
            )
        )
        if self.action == "list":
            scope = self.request.query_params.get("scope", "assigned")
            if scope == "assigned":
                queryset = queryset.filter(assignee=user)
            elif scope == "created":
                queryset = queryset.filter(creator=user)
            elif scope != "all":
                raise serializers.ValidationError(
                    {"scope": "Use assigned, created, or all."}
                )

            status_filter = self.request.query_params.get("status", "all")
            if status_filter == "open":
                queryset = queryset.exclude(
                    status__in=[
                        models.Task.Status.COMPLETED,
                        models.Task.Status.CANCELED,
                    ]
                )
            elif status_filter != "all":
                valid_statuses = {
                    choice for choice, _label in models.Task.Status.choices
                }
                if status_filter not in valid_statuses:
                    raise serializers.ValidationError(
                        {"status": "Use open, all, or a task status."}
                    )
                queryset = queryset.filter(status=status_filter)
        return queryset.order_by("-updated_at")

    def create(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        serializer = TaskCreateSerializer(
            data=request.data,
            context={"request": request},
        )
        serializer.is_valid(raise_exception=True)
        validated_data = dict(serializer.validated_data)
        assignee = validated_data.pop("assignee", request.user)
        with transaction.atomic():
            task = models.Task.objects.create(
                creator=request.user,
                assignee=assignee,
                **validated_data,
            )
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
            history_snapshot = snapshot_task(task)
            previous_assignee_id = task.assignee_id
            requested_fields = set(request.data)
            allowed_fields = {
                "title",
                "description",
                "start_date",
                "due_date",
                "assignee_id",
                "status",
            }
            if not requested_fields or not requested_fields <= allowed_fields:
                raise serializers.ValidationError(
                    {"detail": "Provide only editable task fields."}
                )
            if task.creator_id != request.user.id and requested_fields != {"status"}:
                raise PermissionDenied("Assignees can only update the task status.")

            serializer = TaskUpdateSerializer(
                task,
                data=request.data,
                partial=True,
                context={"request": request},
            )
            serializer.is_valid(raise_exception=True)
            serializer.save()
            record_task_changes(
                task=task,
                actor=request.user,
                before=history_snapshot,
            )
            if task.assignee_id != previous_assignee_id:
                record_task_assignment(
                    task=task,
                    event=models.TaskImDelivery.Event.REASSIGNED,
                )
            response_data = TaskSerializer(task, context={"request": request}).data
        return Response(response_data)

    @action(detail=True, methods=["get"])
    def activities(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        task = self.get_object()
        activities = task.activities.select_related("actor").order_by("-created_at")
        return Response(TaskActivitySerializer(activities, many=True).data)

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
