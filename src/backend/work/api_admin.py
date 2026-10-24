"""Customer-side Work seat administration (P1-A).

Tenant authority comes from the caller's admin context — the primary active
membership — never from the data-plane ``X-Organization-Id`` header. The header
is only checked for disagreement: silently ignoring it would let the console
believe it manages tenant A while writing to tenant B.

Every grant mutation delegates to :mod:`work.grants`; this module owns
authorization, scoping and response shaping, and never writes the grant table
itself. Seat state is derived with subqueries, never a join to membership:
memberships are one row per department, so a join would repeat a grant once per
department and corrupt both ``count`` and pagination.
"""

import csv
import json
import uuid
from datetime import datetime, time

from django.conf import settings
from django.db.models import Exists, OuterRef, Q, Subquery, TextField, Value
from django.db.models.functions import Cast, Replace
from django.http import StreamingHttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from rest_framework import exceptions, serializers, status
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import SAFE_METHODS
from rest_framework.response import Response
from rest_framework.views import APIView

from core.api.permissions import IsAuthenticated
from core.models import Membership, MembershipStatusChoices
from core.services.org_permissions import get_admin_context

from . import audit, grants
from .models import WorkAccessAudit, WorkMemberGrant, WorkOrganizationEntitlement

CHANGED_KEYS = (
    "enabled",
    "source",
    "expires_at",
    "revoked_reason",
    "daily_token_budget",
    "member_limit",
)
AUDIT_COLUMNS = (
    "created_at",
    "action",
    "actor_label",
    "target_type",
    "target_id",
    "request_id",
    "changed",
)
SEARCH_FIELDS = ("user__full_name", "user__short_name", "user__sub")


def _deny(code, *, meta=None):
    detail = {"code": code}
    if meta is not None:
        detail["meta"] = meta
    raise exceptions.PermissionDenied(detail)


def _require_matching_header(request, organization):
    """Reject a header that disagrees with the admin context.

    Ignoring it silently is the dangerous option: a console that sends tenant B
    while authenticated against tenant A would happily manage A.
    """
    header = request.headers.get("X-Organization-Id")
    if not header:
        return
    try:
        declared = uuid.UUID(header)
    except (AttributeError, TypeError, ValueError):
        _deny("organization_mismatch")
    if declared != organization.id:
        _deny("organization_mismatch")


class WorkAdminPermission(IsAuthenticated):
    """Authenticated, tenant-resolved, and holding the endpoint's permission.

    Denials carry a machine-readable ``code`` — the console branches on it, and
    the project's exception handler only rewrites ``ValidationError``, so a bare
    ``return False`` would reach the browser as DRF's anonymous ``detail`` body.
    """

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        context = get_admin_context(request)
        organization = context.organization
        if organization is None:
            _deny("organization_required_for_work_admin")
        if organization.archived_at is not None:
            if request.method not in SAFE_METHODS:
                _deny("organization_read_only")
        elif not organization.is_active:
            # Suspended means governance is off, not read-only: the whole
            # console is closed, reads included.
            _deny("organization_suspended")
        _require_matching_header(request, organization)

        required = getattr(view, "required_permission", None)
        if required is None:  # misconfiguration — fail closed, loudly
            raise RuntimeError(
                f"{view.__class__.__name__} is missing required_permission"
            )
        if not context.has(required):
            _deny("missing_permission", meta={"permission": required})
        return True


class WorkAdminView(APIView):
    """Read/write permission split plus the shared tenant helpers."""

    permission_classes = [WorkAdminPermission]
    read_permission = "org.work_grant.read"
    write_permission = "org.work_grant.write"

    def get_permissions(self):
        self.required_permission = (
            self.read_permission
            if self.request.method in SAFE_METHODS
            else self.write_permission
        )
        return super().get_permissions()

    @property
    def admin_context(self):
        return get_admin_context(self.request)

    @property
    def organization(self):
        return self.admin_context.organization

    def require_scope(self, user_id):
        """Scoped administrators may only touch people inside their subtree.

        The check is per-row EXISTS, not the caller's primary department: a
        person can hold an organization-level primary row *and* a row in the
        administrator's department, and that person is in scope.
        """
        if not _in_scope(self.admin_context, self.organization, user_id):
            raise exceptions.PermissionDenied({"code": "member_out_of_scope"})


def _scoped_memberships(context, organization):
    return context.filter_memberships(
        Membership.objects.filter(organization=organization)
    )


def _in_scope(context, organization, user_id):
    if not context.is_scoped:
        return True
    return _scoped_memberships(context, organization).filter(user_id=user_id).exists()


def _limit_to_scope(queryset, context, organization):
    if not context.is_scoped:
        return queryset
    in_scope = _scoped_memberships(context, organization).filter(
        user_id=OuterRef("user_id")
    )
    return queryset.filter(Exists(in_scope))


def _grant_queryset(organization):
    """Grants annotated with membership state, one row per natural person."""
    active = Membership.objects.filter(
        organization_id=OuterRef("organization_id"),
        user_id=OuterRef("user_id"),
        status=MembershipStatusChoices.ACTIVE,
    )
    left = Membership.objects.filter(
        organization_id=OuterRef("organization_id"),
        user_id=OuterRef("user_id"),
        status=MembershipStatusChoices.LEFT,
    ).order_by("-left_at", "-created_at")
    latest = Membership.objects.filter(
        organization_id=OuterRef("organization_id"),
        user_id=OuterRef("user_id"),
    ).order_by("-updated_at", "-created_at", "id")
    return (
        WorkMemberGrant.objects.filter(organization_id=organization.id)
        .select_related("organization", "user")
        .annotate(
            has_active_membership=Exists(active),
            has_left_membership=Exists(left),
            latest_left_at=Subquery(left.values("left_at")[:1]),
            latest_membership_status=Subquery(latest.values("status")[:1]),
        )
    )


def _load_grant(organization, user_id):
    return _grant_queryset(organization).filter(user_id=user_id).first()


def _display_name(user):
    return user.full_name or user.short_name or user.sub


def _grant_status(grant, now):
    """Deterministic precedence: revoked > disabled > expired > active."""
    if grant.revoked_at is not None:
        return "revoked"
    if not grant.enabled:
        return "disabled"
    if grant.expires_at is not None and grant.expires_at <= now:
        return "expired"
    return "active"


def _membership_state(grant):
    if grant.has_active_membership:
        return "active", None
    if grant.has_left_membership:
        return "left", grant.latest_left_at
    return grant.latest_membership_status or "", None


def _grant_row(grant, now):
    membership_state, left_at = _membership_state(grant)
    return {
        "user_id": str(grant.user_id),
        "display_name": _display_name(grant.user),
        "enabled": grant.enabled,
        "source": grant.source,
        "expires_at": grant.expires_at,
        "status": _grant_status(grant, now),
        "revoked_at": grant.revoked_at,
        "revoked_reason": grant.revoked_reason,
        "revoked_by": (
            str(grant.revoked_by_id) if grant.revoked_by_id is not None else None
        ),
        "membership_state": membership_state,
        "left_at": left_at,
    }


def _status_filter(value, now):
    if value == "active":
        return Q(revoked_at__isnull=True, enabled=True) & (
            Q(expires_at__isnull=True) | Q(expires_at__gt=now)
        )
    if value == "expired":
        return Q(revoked_at__isnull=True, enabled=True, expires_at__lte=now)
    if value == "disabled":
        return Q(revoked_at__isnull=True, enabled=False)
    if value == "revoked":
        return Q(revoked_at__isnull=False)
    return None


def _uuid_prefix(value):
    compact = value.replace("-", "")
    return 8 <= len(compact) <= 32 and all(
        character in "0123456789abcdefABCDEF" for character in compact
    )


def _search(queryset, organization, query):
    """Name / subject / employee number / uuid prefix — never email or phone.

    Searching email would turn the box into an oracle that confirms whether a
    guessed address belongs to a colleague.
    """
    condition = Q()
    for field in SEARCH_FIELDS:
        condition |= Q(**{f"{field}__icontains": query})
    condition |= Exists(
        Membership.objects.filter(
            organization=organization,
            user_id=OuterRef("user_id"),
            employee_no__icontains=query,
        )
    )
    if _uuid_prefix(query):
        # Both sides lose their dashes: pasting a prefix from either rendering
        # of the UUID must work, including one that crosses a dash boundary.
        compact = query.replace("-", "").lower()
        queryset = queryset.annotate(
            user_id_compact=Replace(
                Cast("user_id", output_field=TextField()),
                Value("-"),
                Value(""),
                output_field=TextField(),
            )
        )
        condition |= Q(user_id_compact__startswith=compact)
    return queryset.filter(condition)


class GrantPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = "page_size"
    max_page_size = 100


class GrantCollectionView(WorkAdminView):
    """``GET`` list and ``POST`` grant for the caller's tenant."""

    def get(self, request):
        now = timezone.now()
        queryset = _limit_to_scope(
            _grant_queryset(self.organization),
            self.admin_context,
            self.organization,
        )

        status_value = (request.query_params.get("status") or "").strip()
        if status_value:
            condition = _status_filter(status_value, now)
            if condition is None:
                return Response(
                    {"code": "invalid_status"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            queryset = queryset.filter(condition)

        query = (request.query_params.get("q") or "").strip()
        if query:
            queryset = _search(queryset, self.organization, query)

        queryset = queryset.order_by("-updated_at", "id")
        paginator = GrantPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        return paginator.get_paginated_response(
            [_grant_row(grant, now) for grant in page]
        )

    def post(self, request):
        serializer = GrantWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user_id = serializer.validated_data["user_id"]
        self.require_scope(user_id)

        existed = WorkMemberGrant.objects.filter(
            organization=self.organization, user_id=user_id
        ).exists()
        grants.grant_member(
            organization_id=self.organization.id,
            user_id=user_id,
            actor=request.user,
            source=WorkMemberGrant.Source.CUSTOMER,
            expires_at=serializer.validated_data.get("expires_at"),
            request_id=audit.request_id(request),
        )
        row = _grant_row(_load_grant(self.organization, user_id), timezone.now())
        return Response(
            row,
            status=status.HTTP_200_OK if existed else status.HTTP_201_CREATED,
        )


class GrantWriteSerializer(serializers.Serializer):
    user_id = serializers.UUIDField()
    expires_at = serializers.DateTimeField(required=False, allow_null=True)


class GrantRestoreSerializer(serializers.Serializer):
    expires_at = serializers.DateTimeField(required=False, allow_null=True)


class GrantMemberView(WorkAdminView):
    """``DELETE`` = manual revoke. Revocation never depends on membership state."""

    def delete(self, request, user_id):
        self.require_scope(user_id)
        grants.revoke_member_grant(
            organization_id=self.organization.id,
            user_id=user_id,
            actor=request.user,
            reason=WorkMemberGrant.RevokedReason.MANUAL,
            request_id=audit.request_id(request),
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class GrantRestoreView(WorkAdminView):
    def post(self, request, user_id):
        serializer = GrantRestoreSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.require_scope(user_id)
        grants.restore_member_grant(
            organization_id=self.organization.id,
            user_id=user_id,
            actor=request.user,
            expires_at=serializer.validated_data.get("expires_at"),
            request_id=audit.request_id(request),
        )
        row = _grant_row(_load_grant(self.organization, user_id), timezone.now())
        return Response(row)


class GrantSummaryView(WorkAdminView):
    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    def get(self, request):
        usage = grants.seat_usage(self.organization.id)
        limit = usage["limit"]
        return Response(
            {
                "active": usage["active"],
                "limit": limit,
                "over_limit": limit is not None and usage["active"] > limit,
            }
        )


class EntitlementView(WorkAdminView):
    """Read-only view of the platform-owned entitlement. No write endpoints."""

    def get(self, request):
        entitlement = WorkOrganizationEntitlement.objects.filter(
            organization=self.organization
        ).first()
        return Response(
            {
                "enabled": bool(entitlement and entitlement.enabled),
                "features": entitlement.features if entitlement else {},
                "daily_token_budget": (
                    entitlement.daily_token_budget if entitlement else None
                ),
                "member_limit": entitlement.member_limit if entitlement else None,
            }
        )


class AuditView(WorkAdminView):
    read_permission = "org.audit.read"
    write_permission = "org.audit.read"


class AuditPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = "page_size"
    max_page_size = 100


def _parse_bound(value, *, end):
    moment = parse_datetime(value)
    if moment is None:
        day = parse_date(value)
        if day is None:
            return None
        moment = datetime.combine(day, time.max if end else time.min)
    if timezone.is_naive(moment):
        return timezone.make_aware(moment, timezone.get_current_timezone())
    return moment


def _audit_queryset(request, organization):
    """Return ``(queryset, filters, error_response)``.

    Every filter is applied server-side and echoed in the export audit row, so
    the trail explains exactly which slice left the building.
    """
    queryset = WorkAccessAudit.objects.filter(organization=organization).select_related(
        "actor"
    )
    filters = {"from": None, "to": None, "action": None}

    raw_from = request.query_params.get("from")
    if raw_from:
        start = _parse_bound(raw_from, end=False)
        if start is None:
            return (
                None,
                None,
                Response(
                    {"code": "invalid_datetime"}, status=status.HTTP_400_BAD_REQUEST
                ),
            )
        queryset = queryset.filter(created_at__gte=start)
        filters["from"] = start.isoformat()

    raw_to = request.query_params.get("to")
    if raw_to:
        end = _parse_bound(raw_to, end=True)
        if end is None:
            return (
                None,
                None,
                Response(
                    {"code": "invalid_datetime"}, status=status.HTTP_400_BAD_REQUEST
                ),
            )
        queryset = queryset.filter(created_at__lte=end)
        filters["to"] = end.isoformat()

    action = (request.query_params.get("action") or "").strip()
    if action:
        valid = {choice.value for choice in WorkAccessAudit.Action}
        if action not in valid:
            return (
                None,
                None,
                Response(
                    {"code": "invalid_action"}, status=status.HTTP_400_BAD_REQUEST
                ),
            )
        queryset = queryset.filter(action=action)
        filters["action"] = action

    return queryset, filters, None


def _changed(row):
    """Whitelisted before/after diff. Unknown keys are dropped, not passed on.

    Audit payloads are JSON written by future action types; exporting them
    wholesale would eventually leak whatever someone puts there.
    """
    before = row.before or {}
    after = row.after or {}
    changed = {}
    for key in CHANGED_KEYS:
        if key not in before and key not in after:
            continue
        if before.get(key) != after.get(key):
            changed[key] = {
                "before": before.get(key),
                "after": after.get(key),
            }
    if "features" in before or "features" in after:
        old = len(before.get("features") or {})
        new = len(after.get("features") or {})
        if old != new:
            changed["features_count"] = {"before": old, "after": new}
    return changed


def _actor_label(row):
    actor = row.actor
    if actor is None:
        return ""
    # Never ``str(actor)`` — ``User.__str__`` is the email address.
    return actor.full_name or actor.short_name or str(actor.id)


def _audit_row(row):
    return {
        "created_at": row.created_at,
        "action": row.action,
        "actor_label": _actor_label(row),
        "target_type": row.target_type,
        "target_id": row.target_id,
        "request_id": row.request_id,
        "changed": _changed(row),
    }


def _csv_cell(value):
    text = "" if value is None else str(value)
    if text.startswith(("=", "+", "-", "@")):
        return "'" + text
    return text


class _Echo:
    """csv.writer sink that returns the line instead of buffering it."""

    def write(self, value):
        return value


class AccessAuditListView(AuditView):
    def get(self, request):
        queryset, _filters, error = _audit_queryset(request, self.organization)
        if error is not None:
            return error
        paginator = AuditPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        return paginator.get_paginated_response([_audit_row(row) for row in page])


class AccessAuditExportView(AuditView):
    def get(self, request):
        organization = self.organization
        queryset, filters, error = _audit_queryset(request, organization)
        if error is not None:
            return error

        limit = settings.WORK_ACCESS_AUDIT_EXPORT_MAX_ROWS
        # The export's own audit row is written below, before the (lazy) stream
        # is consumed. Bound the snapshot now so the file cannot list itself.
        as_of = timezone.now()
        queryset = queryset.filter(created_at__lte=as_of)
        total = queryset.count()
        if total > limit:
            return Response(
                {"code": "export_too_large", "meta": {"limit": limit}},
                status=status.HTTP_409_CONFLICT,
            )

        # After counting, before streaming: once the response body is open a
        # disconnected client leaves a truncated file, so a "write afterwards"
        # would lose the only evidence that an export happened.
        audit.record_access_event(
            action=WorkAccessAudit.Action.ACCESS_AUDIT_EXPORTED,
            organization=organization,
            actor=request.user,
            target_type="export",
            request_id=audit.request_id(request),
            after={
                "rows": total,
                **{key: value for key, value in filters.items() if value is not None},
            },
        )

        writer = csv.writer(_Echo())

        def rows():
            yield "\ufeff"
            yield writer.writerow(AUDIT_COLUMNS)
            for row in queryset.iterator(chunk_size=500):
                changed = json.dumps(
                    _changed(row),
                    ensure_ascii=False,
                    sort_keys=True,
                    default=str,
                )
                values = (
                    row.created_at.isoformat(),
                    row.action,
                    _actor_label(row),
                    row.target_type,
                    row.target_id,
                    row.request_id,
                    changed,
                )
                yield writer.writerow([_csv_cell(value) for value in values])

        response = StreamingHttpResponse(rows(), content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = (
            "attachment; filename="
            f'"work-access-audit-{str(organization.id)[:8]}-'
            f'{timezone.localdate().isoformat()}.csv"'
        )
        return response
