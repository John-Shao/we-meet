"""User account deregistration service.

Handles soft-deletion and anonymization of user accounts,
including cleanup of related data and Keycloak user removal.
"""

import logging

import requests
from django.conf import settings
from django.db import transaction

from core.api.mobile_auth import _admin_realm_url, _get_service_account_token
from core.models import RecordingAccess, ResourceAccess

logger = logging.getLogger(__name__)


class UserDeregistrationService:
    """Soft-delete and anonymize a user account."""

    def deregister(self, user):
        """Deregister a user: anonymize data, remove accesses, delete from Keycloak."""
        keycloak_sub = user.sub

        with transaction.atomic():
            # Remove all room/resource access records
            ResourceAccess.objects.filter(user=user).delete()

            # Remove all recording access records
            RecordingAccess.objects.filter(user=user).delete()

            # Anonymize and deactivate
            user.email = None
            user.full_name = None
            user.short_name = None
            user.sub = None
            user.is_active = False
            user.save()

        # Best-effort Keycloak deletion (outside transaction)
        if keycloak_sub:
            self._delete_keycloak_user(keycloak_sub)

    def _delete_keycloak_user(self, sub):
        """Delete user from Keycloak by sub (user UUID). Logs errors but does not raise."""
        sa_token = _get_service_account_token()
        if not sa_token:
            logger.error(
                "Cannot delete Keycloak user %s: failed to get service account token",
                sub,
            )
            return

        admin_url = _admin_realm_url()
        try:
            resp = requests.delete(
                f"{admin_url}/users/{sub}",
                headers={"Authorization": f"Bearer {sa_token}"},
                timeout=10,
                verify=settings.OIDC_VERIFY_SSL,
            )
            if resp.status_code == 204:
                logger.info("Keycloak user %s deleted successfully", sub)
            else:
                logger.error(
                    "Keycloak user %s deletion failed: HTTP %s %s",
                    sub,
                    resp.status_code,
                    resp.text,
                )
        except Exception:
            logger.exception("Failed to delete Keycloak user %s", sub)
