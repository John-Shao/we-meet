"""Minimal standalone task API."""

from django.db.models import Q
from django.utils import timezone

from rest_framework import mixins, serializers, viewsets
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from core import models
from core.api import permissions
from core.api.serializers import TaskSerializer
from core.api.viewsets import Pagination


class TaskCreateSerializer(serializers.Serializer):
    """Input for a personal task; the caller is creator and assignee."""

    title = serializers.CharField(max_length=500, trim_whitespace=True)
    description = serializers.CharField(
        required=False, allow_blank=True, max_length=5000, default=""
    )
    due_at = serializers.DateTimeField(required=False, allow_null=True)


class TaskUpdateSerializer(serializers.ModelSerializer):
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

    class Meta:
        model = models.Task
        fields = ["title", "description", "due_at", "status"]

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
            timezone.now()
            if instance.status == models.Task.Status.COMPLETED
            else None
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
            valid_statuses = {choice for choice, _label in models.Task.Status.choices}
            if status_filter not in valid_statuses:
                raise serializers.ValidationError(
                    {"status": "Use open, all, or a task status."}
                )
            queryset = queryset.filter(status=status_filter)
        return queryset.order_by("-updated_at")

    def create(self, request, *args, **kwargs):  # pylint: disable=unused-argument
        serializer = TaskCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        task = models.Task.objects.create(
            creator=request.user,
            assignee=request.user,
            **serializer.validated_data,
        )
        return Response(
            TaskSerializer(task, context={"request": request}).data,
            status=201,
        )

    def partial_update(self, request, *args, **kwargs):
        task = self.get_object()
        requested_fields = set(request.data)
        allowed_fields = {"title", "description", "due_at", "status"}
        if not requested_fields or not requested_fields <= allowed_fields:
            raise serializers.ValidationError(
                {"detail": "Provide only editable task fields."}
            )
        if task.creator_id != request.user.id and requested_fields != {"status"}:
            raise PermissionDenied("Assignees can only update the task status.")

        serializer = TaskUpdateSerializer(task, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(
            TaskSerializer(task, context={"request": request}).data
        )
