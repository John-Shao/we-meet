"""Two-layer Work admission: provider entitlement and customer member grant."""

import logging
import uuid

from django.conf import settings
from django.db import DatabaseError

from rest_framework.exceptions import APIException

from core.models import Membership, MembershipStatusChoices

from .models import WorkMemberGrant, WorkOrganizationEntitlement

logger = logging.getLogger(__name__)


class OrganizationRequired(APIException):
    status_code = 409
    default_detail = {"code": "organization_required"}
    default_code = "organization_required"


class OrganizationInvalid(APIException):
    status_code = 400
    default_detail = {"code": "invalid_organization"}
    default_code = "invalid_organization"


class WorkAccessDenied(APIException):
    status_code = 403
    default_detail = {"code": "work_access_denied"}
    default_code = "work_access_denied"

    def __init__(self, code=None):
        code = code or self.default_code
        super().__init__(detail={"code": code}, code=code)


class WorkAccessUnavailable(APIException):
    status_code = 503
    default_detail = {"code": "access_unavailable"}
    default_code = "access_unavailable"


def enabled():
    return bool(getattr(settings, "WORK_TENANT_ACCESS_ENABLED", False))


def identity_ok(user):
    return bool(
        user
        and user.is_authenticated
        and user.is_active
        and getattr(user, "sub", "")
        and not user.is_device
    )


def _active_memberships(user):
    return Membership.objects.filter(
        user=user,
        status=MembershipStatusChoices.ACTIVE,
        organization__is_active=True,
    )


def member_of(user, organization):
    """Identity plus active membership in exactly this organization."""
    if not identity_ok(user) or organization is None:
        return False
    return _active_memberships(user).filter(organization_id=organization).exists()


def allows_scope(user, organization):
    """Data-plane check for rows that already carry an organization."""
    return scope_denial(user, organization) is None


def _requested_organization(request):
    value = request.headers.get("X-Organization-Id")
    if value is None:
        return None
    try:
        return uuid.UUID(value.strip())
    except (AttributeError, TypeError, ValueError):
        raise OrganizationInvalid() from None


def request_organization(request, user=None):
    """Resolve the request organization from the header or sole membership.

    The header is accepted only for an active membership; it never falls back
    to the primary organization when the caller supplied an explicit choice.
    """
    user = user or request.user
    requested = _requested_organization(request)
    if requested is not None:
        if not member_of(user, requested):
            raise WorkAccessDenied("member_disabled")
        return requested
    organization_ids = list(
        _active_memberships(user).values_list("organization_id", flat=True)[:2]
    )
    if len(organization_ids) == 1:
        return organization_ids[0]
    if not organization_ids:
        raise WorkAccessDenied("member_disabled")
    raise OrganizationRequired()


def request_organization_id(request):
    """Organization admitted by WorkUser for this request, if the gate is on."""
    return getattr(request, "work_organization_id", None)


def _blocked_organizations():
    values = getattr(settings, "WORK_DISABLED_ORGANIZATION_IDS", [])
    if not isinstance(values, (list, tuple)):
        return None
    try:
        return {uuid.UUID(str(value)) for value in values}
    except (TypeError, ValueError, AttributeError):
        return None


def _organization_key(organization):
    try:
        return uuid.UUID(str(organization))
    except (TypeError, ValueError, AttributeError):
        return None


def check(user, organization, feature=None):  # noqa: PLR0911 -- one denial per gate
    """Return None when allowed, else a stable denial code. Fail closed."""
    if not enabled():
        return None
    if not identity_ok(user):
        return "access_denied"
    if organization is None:
        return "organization_required"
    organization_key = _organization_key(organization)
    if organization_key is None:
        return "access_denied"
    blocked = _blocked_organizations()
    if blocked is None or organization_key in blocked:
        return "org_disabled"
    try:
        entitlement = WorkOrganizationEntitlement.objects.filter(
            organization_id=organization
        ).first()
        if entitlement is None or not entitlement.enabled:
            return "org_disabled"
        if feature and not entitlement.feature_enabled(feature):
            return "feature_disabled"
        if not member_of(user, organization):
            return "member_disabled"
        grant = WorkMemberGrant.objects.filter(
            organization_id=organization, user=user
        ).first()
        if grant is None or not grant.is_active():
            return "member_disabled"
        return None
    except DatabaseError:
        logger.warning("work tenant access lookup failed", exc_info=True)
        return "access_unavailable"


def allows(user, organization, feature=None):
    return check(user, organization, feature) is None


DENIAL_CODES = frozenset(
    {
        "access_denied",
        "access_revoked",
        "organization_required",
        "org_disabled",
        "feature_disabled",
        "member_disabled",
    }
)


def scope_denial(user, organization, feature=None):
    """Reauthorize an existing row, including identity when the gate is off."""
    if not identity_ok(user):
        return "access_revoked"
    if enabled():
        return check(user, organization, feature)
    if organization is None:
        # Legacy null-organization rows stay owner-only while the gate is off.
        return None
    return None if member_of(user, organization) else "access_revoked"


def require_scope(user, organization, feature=None):
    """Raise a stable denial when a row's stored scope is no longer authorized."""
    code = scope_denial(user, organization, feature)
    if code:
        raise denial(code)


def denial_status(code):
    if code == "access_unavailable":
        return 503
    if code == "organization_required":
        return 409
    return 403


def denial(code):
    if code == "organization_required":
        return OrganizationRequired()
    if code == "access_unavailable":
        return WorkAccessUnavailable()
    return WorkAccessDenied(code)
