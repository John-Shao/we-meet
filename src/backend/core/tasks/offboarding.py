"""Sever (and restore) the identity-provider login for offboarded members.

**Disable, never delete.** ``core/services/deregistration.py`` has a deletion
path, but using it here would strip the ``sub`` that audit logs, meeting
summaries and document authorship resolve names through — the history would go
blank. ``enabled: false`` blocks the login immediately and is reversible with
one flag when the person is rehired.

Best-effort throughout: a Keycloak outage must not undo an offboarding that has
already committed. Failures land in the audit log, which is what surfaces the
"login not disabled" flag in the console.
"""

import logging

import requests
from django.conf import settings

from core import models
from core.services.audit import record_audit
from core.tasks._task import task

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 10


def _admin_api(sub: str) -> str | None:
    """Keycloak admin REST URL for one user, or None if OIDC is unconfigured."""
    # Reuse the realm-URL derivation the mobile OTP flow already relies on.
    from core.api.mobile_auth import (  # pylint: disable=import-outside-toplevel
        _admin_realm_url,
    )

    base = _admin_realm_url()
    if not base:
        return None
    return f"{base}/users/{sub}"


def _set_enabled(user, enabled: bool) -> bool:
    """PUT ``{"enabled": …}`` for the user's Keycloak account. Returns success."""
    from core.api.mobile_auth import (  # pylint: disable=import-outside-toplevel
        _get_service_account_token,
    )

    if not user.sub:
        return False
    url = _admin_api(user.sub)
    if not url:
        logger.warning("Keycloak admin URL unavailable; skipping enabled=%s", enabled)
        return False

    token = _get_service_account_token()
    if not token:
        logger.warning("No Keycloak service-account token; skipping enabled=%s", enabled)
        return False

    try:
        response = requests.put(
            url,
            json={"enabled": enabled},
            headers={"Authorization": f"Bearer {token}"},
            timeout=REQUEST_TIMEOUT,
            verify=settings.OIDC_VERIFY_SSL,
        )
        response.raise_for_status()
        return True
    except Exception:  # noqa: BLE001 — best effort by design
        logger.exception(
            "Failed to set Keycloak enabled=%s for user %s", enabled, user.id
        )
        return False


@task
def disable_keycloak_login(user_id: str, organization_id: str, actor_id: str | None):
    """Block an offboarded member from logging in again."""
    if not getattr(settings, "OFFBOARD_DISABLE_KEYCLOAK", True):
        # Some deployments federate to a read-only IdP they must not mutate.
        return

    user = models.User.objects.filter(id=user_id).first()
    organization = models.Organization.objects.filter(id=organization_id).first()
    if user is None or organization is None:
        return

    if _set_enabled(user, False):
        return

    # Only record the failure — success is already implied by the offboard entry,
    # and one row per offboarding is enough noise.
    record_audit(
        actor=models.User.objects.filter(id=actor_id).first() if actor_id else None,
        organization=organization,
        action=models.AuditActionChoices.MEMBER_OFFBOARD,
        target_type="membership",
        target_label=user.full_name or user.email or str(user.id),
        metadata={"keycloak_disable_failed": True, "user": str(user.id)},
    )


@task
def enable_keycloak_login(user_id: str):
    """Restore login for a rehired member."""
    if not getattr(settings, "OFFBOARD_DISABLE_KEYCLOAK", True):
        return
    user = models.User.objects.filter(id=user_id).first()
    if user is not None:
        _set_enabled(user, True)
