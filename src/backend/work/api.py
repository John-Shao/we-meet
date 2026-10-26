"""Authenticated Work APIs; no model calls or meeting reads."""

import uuid

from django.conf import settings

from rest_framework import permissions, serializers
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework.views import APIView

from . import access, agent_runs, local_runs, review_runs, runs


class WorkUser(permissions.BasePermission):
    """Require a real active account and, when enabled, two-layer Work access."""

    def has_permission(self, request, view):
        user = request.user
        if not access.identity_ok(user):
            return False
        if not access.enabled():
            return True
        organization = access.request_organization(request)
        code = access.check(user, organization, getattr(view, "work_feature", None))
        if code:
            raise access.denial(code)
        request.work_organization_id = organization
        return True


class WorkPagination(PageNumberPagination):
    page_size = 20


def request_key(request):
    try:
        return uuid.UUID(request.headers.get("Idempotency-Key", ""))
    except (ValueError, AttributeError) as exc:
        raise serializers.ValidationError({"code": "invalid_idempotency_key"}) from exc


class CapabilitiesView(APIView):
    """Server authority for visible features."""

    permission_classes = [WorkUser]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    def get(self, request):
        agent_enabled = agent_runs.enabled(request.user)
        reviewer_enabled = review_runs.enabled(request.user)
        local_enabled = local_runs.enabled(request.user)
        return Response(
            {
                "enabled": settings.WORK_ENABLED,
                "skills": ["office_agent"] if agent_enabled else [],
                "agent_enabled": agent_enabled,
                "agent_model": settings.WORK_AGENT_MODEL if agent_enabled else "",
                "agent_max_context_bytes": 400000,
                "agent_token_budget": settings.WORK_AGENT_TOKEN_BUDGET,
                "review_enabled": reviewer_enabled,
                "review_model": settings.WORK_REVIEW_MODEL if reviewer_enabled else "",
                "review_token_budget": settings.WORK_REVIEW_TOKEN_BUDGET,
                "local_agent_enabled": local_enabled,
                "coordination_contract": "work-device/v1",
                "remote_agent_enabled": bool(
                    local_enabled and settings.WORK_REMOTE_AGENT_ENABLED
                ),
                "daily_token_budget": runs.daily_budget(
                    access.request_organization_id(request)
                ),
            }
        )
