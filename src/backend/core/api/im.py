"""IM bridge: exposes ``POST /api/v1.0/im/token`` to authenticated we-meet users.

Forwards the request to jusi-light-im's admin API over HMAC and returns the
client-bound IM token + the WebSocket URL the SDK should connect to.

Why a separate module: keeps OIDC + HMAC plumbing out of viewsets.py and matches
the established pattern for narrowly-scoped feature endpoints (see ai_agent_*).
"""

from __future__ import annotations

import logging
import uuid

from django.conf import settings

from rest_framework import (
    permissions,
    status,
    viewsets,
)
from rest_framework.decorators import action
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.response import Response

from core import models
from core.api.directory import get_caller_organization
from core.services.jusi_im import (
    JusiImAdminClient,
    JusiImBadResponseError,
    JusiImUnreachableError,
)

logger = logging.getLogger(__name__)


class JusiImUnreachableHTTPError(APIException):
    """502 — jusi-light-im is unreachable or returned 5xx."""

    status_code = status.HTTP_502_BAD_GATEWAY
    default_detail = "jusi-light-im is unreachable"
    default_code = "jusi_im_unreachable"


class JusiImInvalidResponseHTTPError(APIException):
    """503 — jusi-light-im responded with an unexpected 4xx or malformed body."""

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = "jusi-light-im returned an unexpected response"
    default_code = "jusi_im_bad_response"


class ImViewSet(viewsets.ViewSet):
    """IM endpoints for the authenticated we-meet user.

    P3 surface:

        POST /api/v1.0/im/token      → sign + return an IM JWT + ws_url for the SDK

    Post-P5 联调入口:

        POST /api/v1.0/im/conversations/direct  → create-or-get 1-on-1 conv with peer_uid
    """

    permission_classes = [permissions.IsAuthenticated]

    @action(detail=False, methods=["post"], url_path="token")
    def token(self, request):
        """Issue a fresh IM token for the authenticated user.

        Body is empty. Caller must already hold a valid OIDC bearer token.
        """
        cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
        if not cfg:
            logger.error("JUSI_IM_CONFIGURATION not configured")
            raise JusiImUnreachableHTTPError(detail="JUSI_IM not configured")

        external_id = self._external_id(request.user)
        ttl_seconds = int(cfg.get("default_ttl_seconds") or 86400)

        client = JusiImAdminClient(
            api_url=str(cfg["api_url"]),
            admin_hmac_secret=str(cfg["admin_hmac_secret"]),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
        )

        try:
            result = client.issue_token(
                external_id=external_id, ttl_seconds=ttl_seconds
            )
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            raise JusiImInvalidResponseHTTPError(detail=str(exc)) from exc

        self._cache_im_uid(request.user, result.uid)

        return Response(
            {
                "uid": result.uid,
                "token": result.token,
                "ws_url": cfg["ws_url"],
                "expires_at": result.expires_at,
            },
            status=status.HTTP_200_OK,
        )

    @action(detail=False, methods=["post"], url_path="users/resolve")
    def resolve_users(self, request):
        """Resolve IM uids → display names for conversation-list rendering.

        Body: ``{"im_uids": ["<uid>", ...]}``. Returns ``{uid: {id, full_name,
        short_name}}`` for the subset that maps to a we-meet user **in the caller's
        organization** (no cross-org name leakage). uids that don't resolve are
        simply absent from the response.

        Powers the contact-less display path: the IM conversation summary carries
        member uids; the client posts them here to label direct peers / group
        members without ever handling raw identities client-side.
        """
        data = request.data or {}
        raw = data.get("im_uids")
        if not isinstance(raw, list):
            raise ValidationError({"im_uids": "list of im_uids required"})
        # De-dup + cap to keep the IN-query bounded.
        seen: set = set()
        uids = []
        for u in raw:
            if isinstance(u, str) and u and u not in seen:
                seen.add(u)
                uids.append(u)
            if len(uids) >= 200:
                break

        out: dict = {}
        if not uids:
            return Response(out, status=status.HTTP_200_OK)

        organization = get_caller_organization(request.user)
        qs = models.User.objects.filter(im_uid__in=uids, is_device=False)
        if organization is not None:
            qs = qs.filter(
                memberships__organization=organization,
                memberships__status=models.MembershipStatusChoices.ACTIVE,
            ).distinct()
        else:
            # No org → only resolve self, never other users.
            qs = qs.filter(pk=request.user.pk)

        for u in qs:
            out[u.im_uid] = {
                "id": str(u.id),
                "full_name": u.full_name or u.short_name or u.email or "",
                "short_name": u.short_name or "",
            }
        return Response(out, status=status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="conversations/direct")
    def conversations_direct(self, request):
        """Create-or-get a 1-on-1 conversation with a peer.

        Body accepts EITHER:
          - `{"peer_user_id": "<we-meet user uuid>"}` — the contact-picker path:
            the peer's IM uid is resolved server-side (org-scoped), so the client
            never handles raw IM uids; or
          - `{"peer_uid": "<jusi-light-im uid (uuid)>"}` — the raw path (kept for
            backward compatibility / debugging).

        The caller's own uid is derived from the OIDC subject via a same-process
        resolve (jusi-light-im lazily registers the user on first touch).

        cid is computed as `uuid5(NAMESPACE_OID, "direct:<lo>:<hi>")` over the
        sorted (self_uid, peer_uid) pair so A→B and B→A converge on the same row.
        """
        data = request.data or {}
        peer_uid = data.get("peer_uid")
        peer_user_id = data.get("peer_user_id")

        cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
        if not cfg:
            logger.error("JUSI_IM_CONFIGURATION not configured")
            raise JusiImUnreachableHTTPError(detail="JUSI_IM not configured")

        client = JusiImAdminClient(
            api_url=str(cfg["api_url"]),
            admin_hmac_secret=str(cfg["admin_hmac_secret"]),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
        )

        # Resolve the peer's IM uid. Contact-picker path resolves it from a
        # we-meet user id; raw path takes the uid verbatim.
        if peer_user_id:
            peer_uid = self._resolve_peer_uid(request.user, peer_user_id, client)
        elif isinstance(peer_uid, str) and peer_uid.strip():
            peer_uid = peer_uid.strip()
        else:
            raise ValidationError(
                {"peer_user_id": "peer_user_id or peer_uid is required"}
            )

        # Resolve self_uid via issue_token (lazy-registers on first touch; the
        # short-lived token we get back is discarded — we only need uid).
        external_id = self._external_id(request.user)
        try:
            self_resolve = client.issue_token(external_id=external_id, ttl_seconds=60)
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            raise JusiImInvalidResponseHTTPError(detail=str(exc)) from exc
        self_uid = self_resolve.uid

        if self_uid == peer_uid:
            raise ValidationError({"peer_uid": "cannot equal self_uid"})

        lo, hi = sorted([self_uid, peer_uid])
        cid = str(uuid.uuid5(uuid.NAMESPACE_OID, f"direct:{lo}:{hi}"))

        try:
            result = client.create_direct(cid=cid, owner_uid=self_uid, peer_uid=peer_uid)
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            raise JusiImInvalidResponseHTTPError(detail=str(exc)) from exc

        return Response(
            {
                "cid": result.cid,
                "type": result.type,
                "members": result.members,
                "self_uid": self_uid,
            },
            status=status.HTTP_200_OK,
        )

    @action(detail=False, methods=["post"], url_path="conversations/group")
    def conversations_group(self, request):
        """Create a group conversation with the chosen members.

        Body:
          - `member_user_ids`: list[<we-meet user uuid>] — resolved server-side to
            IM uids (org-scoped, same trust model as the direct contact-picker path).
            The caller is added as owner automatically and must not be listed.
          - `name` (optional): display name, stored in the group's meta.

        Unlike direct, a group cid is a fresh random uuid — groups are never
        deduplicated, so each call creates a distinct conversation.
        """
        data = request.data or {}
        raw_ids = data.get("member_user_ids")
        name = (data.get("name") or "").strip()

        if not isinstance(raw_ids, list) or not raw_ids:
            raise ValidationError(
                {"member_user_ids": "at least one member is required"}
            )
        # De-dupe preserving order so the resolve loop stays cheap and stable.
        seen_ids = set()
        member_user_ids = []
        for mid in raw_ids:
            if mid not in seen_ids:
                seen_ids.add(mid)
                member_user_ids.append(mid)

        cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
        if not cfg:
            logger.error("JUSI_IM_CONFIGURATION not configured")
            raise JusiImUnreachableHTTPError(detail="JUSI_IM not configured")

        client = JusiImAdminClient(
            api_url=str(cfg["api_url"]),
            admin_hmac_secret=str(cfg["admin_hmac_secret"]),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
        )

        # Resolve self_uid (lazy-registers on first touch; token discarded).
        external_id = self._external_id(request.user)
        try:
            self_resolve = client.issue_token(external_id=external_id, ttl_seconds=60)
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            raise JusiImInvalidResponseHTTPError(detail=str(exc)) from exc
        self_uid = self_resolve.uid

        # Resolve each member (org-scoped); drop the owner / duplicates.
        member_uids: list[str] = []
        for mid in member_user_ids:
            resolved = self._resolve_peer_uid(request.user, mid, client)
            if resolved != self_uid and resolved not in member_uids:
                member_uids.append(resolved)
        if not member_uids:
            raise ValidationError(
                {"member_user_ids": "no valid members to add"}
            )

        cid = str(uuid.uuid4())
        meta = {"name": name} if name else None
        try:
            result = client.create_group(
                cid=cid,
                owner_uid=self_uid,
                members=member_uids,
                meta=meta,
            )
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            raise JusiImInvalidResponseHTTPError(detail=str(exc)) from exc

        return Response(
            {
                "cid": result.cid,
                "type": result.type,
                "owner_uid": result.owner_uid,
                "members": result.members,
                "self_uid": self_uid,
            },
            status=status.HTTP_200_OK,
        )

    @staticmethod
    def _resolve_peer_uid(caller, peer_user_id, client) -> str:
        """Resolve a we-meet user id (from the directory/picker) to their IM uid.

        Restricted to users sharing the caller's organization so a direct
        conversation can't be forced with an arbitrary cross-org user. Resolving
        lazily registers the peer in jusi-light-im — acceptable here since the
        caller explicitly chose to message them.
        """
        try:
            uuid.UUID(str(peer_user_id))
        except (ValueError, AttributeError, TypeError) as exc:
            raise ValidationError({"peer_user_id": "invalid id"}) from exc

        organization = get_caller_organization(caller)
        if organization is None:
            raise ValidationError({"peer_user_id": "caller has no organization"})

        peer = (
            models.User.objects.filter(
                id=peer_user_id,
                is_device=False,
                memberships__organization=organization,
                memberships__status=models.MembershipStatusChoices.ACTIVE,
            )
            .distinct()
            .first()
        )
        if peer is None:
            raise ValidationError(
                {"peer_user_id": "not found in your organization"}
            )

        try:
            resolved = client.issue_token(
                external_id=ImViewSet._external_id(peer), ttl_seconds=60
            )
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            raise JusiImInvalidResponseHTTPError(detail=str(exc)) from exc
        ImViewSet._cache_im_uid(peer, resolved.uid)
        return resolved.uid

    @staticmethod
    def _external_id(user) -> str:
        """Stable, opaque identifier for the authenticated user.

        we-meet's User.sub holds the Keycloak OIDC subject — already globally unique.
        """
        sub = getattr(user, "sub", None)
        if sub:
            return str(sub)
        # Fallback for users without sub (legacy / test fixtures).
        return str(user.pk)

    @staticmethod
    def _cache_im_uid(user, uid: str) -> None:
        """Backfill User.im_uid so the bridge can later resolve uid → display name.

        Best-effort: a cache-write failure must never break token issue / conv
        creation, so we swallow + log. Only writes when the value actually changed.
        """
        if not uid or getattr(user, "im_uid", None) == uid:
            return
        try:
            user.im_uid = uid
            user.save(update_fields=["im_uid"])
        except Exception:  # noqa: BLE001 — cache write is non-critical
            logger.warning("im: failed to cache im_uid for user %s", user.pk, exc_info=True)
