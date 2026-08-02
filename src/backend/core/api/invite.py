"""The public side of an invite link (P10 M4).

Two endpoints, and the interesting design is in what they refuse to say.

``GET /invite/<code>/`` is reachable without signing in — it has to be, the
whole point is that somebody who has never heard of we-meet can open a link and
see whose organization is asking them in. So it returns the smallest thing that
makes the page make sense (organization name, department name, whether approval
is needed) and **nothing about people**. An anonymous endpoint that echoes a
name is a hole in the directory, just a narrow one.

It also answers ``200 {"valid": false}`` for every kind of failure — wrong
code, expired, revoked, exhausted — with the same body and the same status.
Distinguishing them (or using 404 for one and 410 for another) hands out an
oracle: anyone who can ask "does this code exist?" can enumerate codes. The
throttle makes that slow; the uniform answer makes it useless.
"""

import logging

from django.utils.translation import gettext_lazy as _

from rest_framework import serializers, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from core import models
from core.services import invite_links

logger = logging.getLogger(__name__)


class InviteThrottle(AnonRateThrottle):
    """20/min per IP for anonymous code resolution.

    ``scope`` is explicit and its own: DRF buckets ``AnonRateThrottle`` by
    ``throttle_anon_<ip>``, so sharing the default would put this in the same
    bucket as the QR-login panel — which polls every 2s — and the two would
    starve each other. ``core/api/mobile_auth.py:274`` documents the same trap.
    """

    scope = "invite_code"  # rate comes from DEFAULT_THROTTLE_RATES


class InviteResolveView(APIView):
    """What an anonymous visitor is allowed to know about a link."""

    permission_classes = [AllowAny]
    throttle_classes = [InviteThrottle]
    authentication_classes = []

    def get(self, request, code=None, *args, **kwargs):
        link = invite_links.resolve_usable_link(code)
        if link is None:
            # One answer for every failure. See the module docstring.
            return Response({"valid": False})
        return Response(
            {
                "valid": True,
                "organization_name": link.organization.name,
                "department_name": link.department.name if link.department_id else "",
                "org_role": link.org_role,
                "title": link.title,
                "require_approval": link.require_approval,
            }
        )


class InviteApplyView(APIView):
    """Apply to join, using a link. Requires a signed-in user."""

    permission_classes = [IsAuthenticated]

    def post(self, request, code=None, *args, **kwargs):
        link = invite_links.resolve_usable_link(code)
        if link is None:
            # Same wording as the anonymous view: a signed-in attacker is still
            # an attacker, and there is nothing here they should learn either.
            return Response(
                {"detail": _("This link is invalid or has expired.")},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            join_request = invite_links.apply_to_link(link, request.user)
        except invite_links.InviteError as exc:
            return Response(
                {"detail": exc.message, "code": exc.code},
                status=(
                    status.HTTP_409_CONFLICT
                    if exc.code == "already_member"
                    else status.HTTP_400_BAD_REQUEST
                ),
            )
        return Response(
            JoinRequestMineSerializer(join_request).data,
            status=(
                status.HTTP_200_OK
                if join_request.status == models.OrgJoinStatusChoices.APPROVED
                else status.HTTP_201_CREATED
            ),
        )


class JoinRequestMineSerializer(serializers.ModelSerializer):
    """The applicant's own view of their application."""

    organization_name = serializers.CharField(
        source="organization.name", read_only=True
    )
    department_name = serializers.SerializerMethodField()

    class Meta:
        model = models.OrgJoinRequest
        fields = [
            "id",
            "organization_name",
            "department_name",
            "org_role",
            "status",
            "reject_reason",
            "created_at",
            "reviewed_at",
        ]
        read_only_fields = fields

    def get_department_name(self, obj):
        return obj.department.name if obj.department_id else ""


class MyJoinRequestsView(APIView):
    """The applicant's own applications, and the ability to withdraw one."""

    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        queryset = (
            models.OrgJoinRequest.objects.filter(user=request.user)
            .select_related("organization", "department")
            .order_by("-created_at")[:20]
        )
        return Response(JoinRequestMineSerializer(queryset, many=True).data)


class CancelJoinRequestView(APIView):
    """Withdraw a pending application."""

    permission_classes = [IsAuthenticated]

    def post(self, request, pk=None, *args, **kwargs):
        join_request = models.OrgJoinRequest.objects.filter(
            pk=pk, user=request.user, status=models.OrgJoinStatusChoices.PENDING
        ).first()
        if join_request is None:
            return Response(
                {"detail": _("No pending application found.")},
                status=status.HTTP_404_NOT_FOUND,
            )
        join_request.status = models.OrgJoinStatusChoices.CANCELLED
        join_request.save(update_fields=["status", "updated_at"])
        return Response(JoinRequestMineSerializer(join_request).data)
