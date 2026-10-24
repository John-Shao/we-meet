"""Best-effort audit capture for provider-owned Work access changes."""

import logging

from .models import WorkAccessAudit, WorkMemberGrant, WorkOrganizationEntitlement

logger = logging.getLogger(__name__)


def entitlement_snapshot(instance):
    if instance is None:
        return {}
    return {
        "enabled": instance.enabled,
        "features": instance.features,
        "daily_token_budget": instance.daily_token_budget,
        "member_limit": instance.member_limit,
        "disabled_reason": instance.disabled_reason,
    }


def grant_snapshot(instance):
    if instance is None:
        return {}
    return {
        "enabled": instance.enabled,
        "source": instance.source,
        "expires_at": instance.expires_at.isoformat() if instance.expires_at else None,
        "user_id": str(instance.user_id),
    }


def snapshot(instance):
    if instance is None:
        return {}
    if isinstance(instance, WorkOrganizationEntitlement):
        return entitlement_snapshot(instance)
    if isinstance(instance, WorkMemberGrant):
        return grant_snapshot(instance)
    return {}


def request_id(request):
    return (request.headers.get("X-Request-Id") or "")[:64]


def record_access_change(  # noqa: PLR0913 -- full attribution is the record
    *,
    request,
    action,
    organization,
    target_type,
    target_id,
    before=None,
    after=None,
):
    """Append one row; an audit failure must never undo the admin mutation."""
    actor = getattr(request, "user", None)
    try:
        WorkAccessAudit.objects.create(
            organization=organization,
            actor=actor if getattr(actor, "is_authenticated", False) else None,
            action=action,
            target_type=target_type,
            target_id=str(target_id),
            request_id=request_id(request),
            before=before or {},
            after=after or {},
        )
    except Exception:  # audit must not break the mutation it records
        logger.exception("Failed to write Work access audit (action=%s)", action)
