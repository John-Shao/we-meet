"""Approval / workflow API (P5 — 审批).

ApprovalTemplate (read-only listing for the submit picker) + ApprovalInstance
(submit / list "我发起的" & "待我审批" / act / cancel), scoped to the caller's
organization. The serial-chain state machine + approver resolution + IM
notification all live in ``core/services/approval.py``.
"""

from django.db.models import Q

from rest_framework import decorators, mixins, serializers, viewsets
from rest_framework import status as drf_status
from rest_framework.response import Response

from core import models
from core.api import permissions
from core.api.directory import get_caller_organization
from core.api.serializers import UserLightSerializer
from core.api.viewsets import Pagination
from core.services import approval as approval_service


class ApprovalTemplateSerializer(serializers.ModelSerializer):
    class Meta:
        model = models.ApprovalTemplate
        fields = ["id", "name", "description", "form_schema", "flow", "is_active"]
        read_only_fields = fields


class ApprovalTaskSerializer(serializers.ModelSerializer):
    approver = UserLightSerializer(read_only=True)

    class Meta:
        model = models.ApprovalTask
        fields = ["node_index", "approver", "action", "comment", "acted_at"]
        read_only_fields = fields


class ApprovalInstanceSerializer(serializers.ModelSerializer):
    """Output-only view of an instance (input on submit uses ApprovalSubmitSerializer)."""

    applicant = UserLightSerializer(read_only=True)
    template_name = serializers.CharField(source="template.name", read_only=True)
    tasks = ApprovalTaskSerializer(many=True, read_only=True)

    class Meta:
        model = models.ApprovalInstance
        fields = [
            "id",
            "template",
            "template_name",
            "applicant",
            "form_data",
            "status",
            "current_node",
            "tasks",
            "created_at",
        ]
        read_only_fields = fields


class ApprovalSubmitSerializer(serializers.Serializer):
    template = serializers.UUIDField()
    form_data = serializers.JSONField(required=False, default=dict)


class ApprovalTemplateViewSet(viewsets.ReadOnlyModelViewSet):
    """List / retrieve the org's active approval templates (for the submit picker)."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = ApprovalTemplateSerializer
    pagination_class = Pagination

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.ApprovalTemplate.objects.none()
        return models.ApprovalTemplate.objects.filter(
            organization=organization, is_active=True
        ).order_by("name")


class ApprovalInstanceViewSet(
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,
):
    """Submit + list + act/cancel on approval instances the caller is involved in."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = ApprovalInstanceSerializer
    pagination_class = Pagination

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.ApprovalInstance.objects.none()
        user = self.request.user
        qs = (
            models.ApprovalInstance.objects.filter(organization=organization)
            .filter(Q(applicant=user) | Q(tasks__approver=user))
            .distinct()
            .select_related("applicant", "template")
            .prefetch_related("tasks__approver")
        )
        role = self.request.query_params.get("role")
        if role == "mine":
            qs = qs.filter(applicant=user)
        elif role == "pending":
            # Only the frontier (current) task is ever PENDING, so an open PENDING
            # task assigned to me == an instance awaiting my action.
            qs = qs.filter(
                status=models.ApprovalStatusChoices.PENDING,
                tasks__approver=user,
                tasks__action=models.ApprovalActionChoices.PENDING,
            ).distinct()
        return qs

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["request"] = self.request
        return context

    def create(self, request, *args, **kwargs):
        submit = ApprovalSubmitSerializer(data=request.data)
        submit.is_valid(raise_exception=True)
        organization = get_caller_organization(request.user)
        if organization is None:
            raise serializers.ValidationError(
                {"detail": "No active organization membership."}
            )
        template = models.ApprovalTemplate.objects.filter(
            id=submit.validated_data["template"],
            organization=organization,
            is_active=True,
        ).first()
        if template is None:
            raise serializers.ValidationError({"template": "not found"})
        instance = approval_service.submit(
            template, request.user, submit.validated_data.get("form_data") or {}
        )
        return Response(
            ApprovalInstanceSerializer(instance, context={"request": request}).data,
            status=drf_status.HTTP_201_CREATED,
        )

    @decorators.action(detail=True, methods=["post"])
    def act(self, request, pk=None):  # pylint: disable=unused-argument
        """Approve / reject the current node (must be the current approver)."""
        instance = self.get_object()
        data = request.data or {}
        instance = approval_service.act(
            instance, request.user, data.get("action"), data.get("comment", "")
        )
        return Response(
            ApprovalInstanceSerializer(instance, context={"request": request}).data
        )

    @decorators.action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):  # pylint: disable=unused-argument
        """Applicant cancels a still-pending instance."""
        instance = self.get_object()
        instance = approval_service.cancel(instance, request.user)
        return Response(
            ApprovalInstanceSerializer(instance, context={"request": request}).data
        )
