"""Owner-only administration of the isolated Work governance domain."""

# pylint: disable=missing-class-docstring,missing-function-docstring,abstract-method

from datetime import timedelta

from django.shortcuts import get_object_or_404
from django.utils import timezone

from rest_framework import permissions, serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models
from core.api.directory import get_caller_organization
from core.services.work_governance import (
    change_work_governance_assignment,
    validate_work_governance_permissions,
)


class WorkGovernanceAssignmentSerializer(serializers.Serializer):
    permissions = serializers.ListField(
        child=serializers.CharField(max_length=128),
        allow_empty=True,
    )
    expected_revision = serializers.IntegerField(min_value=0)
    client_request_id = serializers.CharField(min_length=8, max_length=128)

    def validate_permissions(self, value):
        return validate_work_governance_permissions(value)


class WorkGovernanceAssignmentPermission(permissions.IsAuthenticated):
    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        organization = get_caller_organization(request.user)
        if (
            organization is None
            or not organization.is_active
            or organization.archived_at
        ):
            return False
        if not models.Membership.objects.filter(
            organization=organization,
            user=request.user,
            status=models.MembershipStatusChoices.ACTIVE,
            org_role=models.OrgRoleChoices.OWNER,
        ).exists():
            return False
        if request.method not in permissions.SAFE_METHODS:
            authenticated_at = request.session.get("auth_time")
            if not isinstance(authenticated_at, (int, float)):
                return False
            auth_age = timezone.now().timestamp() - authenticated_at
            if auth_age < -5 or auth_age > timedelta(minutes=10).total_seconds():
                return False
        return True


class WorkGovernanceAssignmentListView(APIView):
    permission_classes = [WorkGovernanceAssignmentPermission]

    def get(self, request):
        organization = get_caller_organization(request.user)
        rows = models.WorkGovernanceAssignment.objects.filter(
            organization=organization
        ).select_related("user")
        return Response(
            [
                {
                    "user_id": str(row.user_id),
                    "permissions": row.permissions,
                    "revision": row.revision,
                    "status": row.status,
                }
                for row in rows
            ]
        )


class WorkGovernanceAssignmentDetailView(APIView):
    permission_classes = [WorkGovernanceAssignmentPermission]

    def put(self, request, user_id):
        serializer = WorkGovernanceAssignmentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        organization = get_caller_organization(request.user)
        target = get_object_or_404(models.User, pk=user_id)
        try:
            assignment, event = change_work_governance_assignment(
                organization,
                target,
                permissions=serializer.validated_data["permissions"],
                actor=request.user,
                expected_revision=serializer.validated_data["expected_revision"],
                client_request_id=serializer.validated_data["client_request_id"],
            )
        except serializers.ValidationError as exc:
            detail = exc.detail
            if isinstance(detail, dict) and "expected_revision" in detail:
                return Response(detail, status=status.HTTP_409_CONFLICT)
            raise
        return Response(
            {
                "user_id": str(assignment.user_id),
                "permissions": assignment.permissions,
                "revision": assignment.revision,
                "status": assignment.status,
                "event_seq": event.event_seq,
                "command_id": str(event.command_id),
            },
            status=status.HTTP_200_OK,
        )
