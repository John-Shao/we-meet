"""Docs membership from directory user IDs; all identity resolution stays on the server."""

from django.conf import settings

from rest_framework import permissions, serializers
from rest_framework.exceptions import APIException, PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models
from core.api.directory import get_caller_organization
from core.services.docs_client import DocsClient, DocsServiceError


class MemberGrantInput(serializers.Serializer):
    doc_id = serializers.UUIDField()
    user_ids = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=100
    )
    role = serializers.ChoiceField(choices=["reader", "commenter", "editor"])


class DocsMemberAccessView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def _users(self, request):
        organization = get_caller_organization(request.user)
        if not organization or not request.user.sub:
            raise PermissionDenied("An active organization identity is required")
        return models.User.objects.filter(
            memberships__organization=organization,
            memberships__status=models.MembershipStatusChoices.ACTIVE,
            is_device=False,
            is_active=True,
        ).distinct()

    def _call(self, request, doc_id, **options):
        cfg = getattr(settings, "DOCS_CONFIGURATION", None) or {}
        if not cfg.get("api_url") or not cfg.get("server_to_server_token"):
            raise APIException("Document service unavailable")
        client = DocsClient(
            str(cfg["api_url"]),
            str(cfg["server_to_server_token"]),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 10),
        )
        try:
            return client.member_access(
                doc_id=str(doc_id), actor_sub=str(request.user.sub), **options
            )
        except DocsServiceError as exc:
            raise APIException("Document membership could not be confirmed") from exc

    def get(self, request):
        doc_id = serializers.UUIDField().run_validation(
            request.query_params.get("doc_id")
        )
        users = self._users(request)
        result = self._call(request, doc_id)
        return Response(
            {
                "user_ids": list(
                    users.filter(sub__in=result["member_subs"]).values_list(
                        "id", flat=True
                    )
                )
            }
        )

    def post(self, request):
        serializer = MemberGrantInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        ids = set(data["user_ids"])
        users = list(self._users(request).filter(id__in=ids))
        if len(users) != len(ids) or any(not user.sub for user in users):
            raise PermissionDenied("Select active users from your directory")
        # Neither recipient sub nor actor identity can be supplied by the client.
        result = self._call(
            request,
            data["doc_id"],
            role=data["role"],
            users=[
                {
                    "sub": str(user.sub),
                    "full_name": user.full_name or user.short_name or "",
                }
                for user in users
            ],
        )
        statuses = {row["sub"]: row["status"] for row in result["results"]}
        return Response(
            {
                "identity": "user_id",
                "role": data["role"],
                "results": [
                    {
                        "user_id": str(user.id),
                        "status": statuses.get(str(user.sub), "failed"),
                    }
                    for user in users
                ],
            }
        )
