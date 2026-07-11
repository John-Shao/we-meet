"""Sync a user's phone number from Keycloak into the local User row (P3).

Keycloak holds the authoritative `phoneNumber` attribute; we mirror it onto
`User.phone` on each login so the app can offer 拨打电话 without an N-per-list
Keycloak round-trip. Idempotent and best-effort — a Keycloak hiccup must never
block sign-in, so every failure is swallowed and logged.

Imports of the Keycloak admin helpers are deferred into the function body to
avoid an import cycle (core.api.mobile_auth pulls in models/serializers, and
this module is reached from the auth backend early in the request).
"""

from __future__ import annotations

import logging

import requests
from django.conf import settings

logger = logging.getLogger(__name__)


def sync_user_phone(user) -> None:
    """Best-effort: pull phoneNumber from Keycloak → User.phone. No-op on any
    failure, missing sub, device accounts, or when the value is unchanged."""
    if getattr(user, "is_device", False) or not getattr(user, "sub", None):
        return
    try:
        from core.api.mobile_auth import (  # noqa: PLC0415 — lazy, cycle-avoidance
            _admin_realm_url,
            _get_service_account_token,
        )

        sa_token = _get_service_account_token()
        if not sa_token:
            return
        resp = requests.get(
            f"{_admin_realm_url()}/users/{user.sub}",
            headers={"Authorization": f"Bearer {sa_token}"},
            timeout=5,
            verify=settings.OIDC_VERIFY_SSL,
        )
        resp.raise_for_status()
        attrs = (resp.json() or {}).get("attributes") or {}
        phone = ((attrs.get("phoneNumber") or [""])[0] or "").strip()
        if phone and phone != user.phone:
            user.phone = phone[:32]
            user.save(update_fields=["phone"])
    except Exception:  # noqa: BLE001 — phone is a courtesy field, never block login
        logger.warning("phone sync from Keycloak failed for user %s", user.pk, exc_info=True)
