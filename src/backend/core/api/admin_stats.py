"""Management console (M 端) overview statistics — read-only, org-scoped.

A single ``stats/overview`` endpoint the console dashboard reads. Everything is
aggregated in a few grouped queries (no per-row work) and cached briefly so a
dashboard refresh can't turn into a query storm.

Org-scoped metrics (members / departments / approvals) filter by the caller's
organization. Meeting / summary counts have no ``organization`` FK yet, so they
are platform-wide — correct for the single-tenant MVP; they must gain org
scoping before multi-tenant rollout.
"""

from datetime import timedelta

from django.core.cache import cache
from django.db.models import Count
from django.db.models.functions import TruncDate
from django.utils import timezone

from rest_framework.response import Response
from rest_framework.views import APIView

from core import models
from core.api.admin_roles import HasOrgPermission
from core.api.directory import get_caller_organization

CACHE_TTL_SECONDS = 60
TREND_DAYS = 14


class AdminStatsOverviewView(APIView):
    """Aggregate counts + a short activity trend for the console dashboard.

    Gated on the **same permission code the console's navigation gates on**
    (``AdminShell.tsx``). It used to be ``IsOrgAdmin``, i.e. owner/administrator
    membership — so hr / it / admin_office, all three of which are granted
    ``org.stats.read``, saw the dashboard entry, clicked it, and got a 403.
    Widening only: owner/administrator hold ``ALL_PERMISSIONS`` and still pass.
    """

    permission_classes = [HasOrgPermission]
    required_permission = "org.stats.read"

    def get(self, request):
        organization = get_caller_organization(request.user)
        if organization is None:
            return Response(self._empty())

        cache_key = f"admin_stats:overview:{organization.id}"
        cached = cache.get(cache_key)
        if cached is not None:
            return Response(cached)

        data = self._compute(organization)
        cache.set(cache_key, data, CACHE_TTL_SECONDS)
        return Response(data)

    def _empty(self):
        return {
            "members": {"total": 0, "active": 0, "suspended": 0, "invited": 0},
            "departments": 0,
            "meetings": 0,
            "summaries": 0,
            "approvals": {"pending": 0, "total": 0},
            "trend": self._empty_trend(),
        }

    def _compute(self, organization):
        member_qs = models.Membership.objects.filter(organization=organization)
        status_counts = {
            row["status"]: row["c"]
            for row in member_qs.values("status").annotate(c=Count("id"))
        }
        members = {
            "total": member_qs.count(),
            "active": status_counts.get(
                models.MembershipStatusChoices.ACTIVE, 0
            ),
            "suspended": status_counts.get(
                models.MembershipStatusChoices.SUSPENDED, 0
            ),
            "invited": status_counts.get(
                models.MembershipStatusChoices.INVITED, 0
            ),
        }

        departments = models.Department.objects.filter(
            organization=organization, deleted_at__isnull=True
        ).count()

        # No organization FK on Room / Summary yet — platform-wide (single-tenant).
        meetings = models.Room.objects.count()
        summaries = models.Summary.objects.count()

        approval_qs = models.ApprovalInstance.objects.filter(
            organization=organization
        )
        approvals = {
            "pending": approval_qs.filter(
                status=models.ApprovalStatusChoices.PENDING
            ).count(),
            "total": approval_qs.count(),
        }

        return {
            "members": members,
            "departments": departments,
            "meetings": meetings,
            "summaries": summaries,
            "approvals": approvals,
            "trend": self._summary_trend(),
        }

    def _summary_trend(self):
        """Meeting-summaries generated per day over the last ``TREND_DAYS``.

        A proxy for meeting activity (each summarized meeting = one row). Missing
        days are filled with zero so the client draws a continuous series.
        """
        since = timezone.now() - timedelta(days=TREND_DAYS - 1)
        rows = (
            models.Summary.objects.filter(created_at__gte=since)
            .annotate(day=TruncDate("created_at"))
            .values("day")
            .annotate(c=Count("id"))
        )
        counts_by_day = {
            row["day"].isoformat(): row["c"] for row in rows if row["day"]
        }
        start = since.date()
        return [
            {
                "date": (start + timedelta(days=i)).isoformat(),
                "count": counts_by_day.get(
                    (start + timedelta(days=i)).isoformat(), 0
                ),
            }
            for i in range(TREND_DAYS)
        ]

    def _empty_trend(self):
        start = (timezone.now() - timedelta(days=TREND_DAYS - 1)).date()
        return [
            {"date": (start + timedelta(days=i)).isoformat(), "count": 0}
            for i in range(TREND_DAYS)
        ]
