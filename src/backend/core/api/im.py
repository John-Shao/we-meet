"""IM bridge: exposes ``POST /api/v1.0/im/token`` to authenticated we-meet users.

Forwards the request to jusi-light-im's admin API over HMAC and returns the
client-bound IM token + the WebSocket URL the SDK should connect to.

Why a separate module: keeps OIDC + HMAC plumbing out of viewsets.py and matches
the established pattern for narrowly-scoped feature endpoints (see ai_agent_*).
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from django.conf import settings

from rest_framework import (
    permissions,
    status,
    viewsets,
)
from rest_framework.decorators import action
from rest_framework.exceptions import (
    APIException,
    PermissionDenied,
    ValidationError,
)
from rest_framework.response import Response

from core.services.jusi_im import JusiImServiceError

from core import models, utils
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
                # Presigned GET (org-scoped, like the directory); '' when unset
                # so the client falls back to the tinted initial avatar.
                "avatar_url": utils.generate_profile_image_get_url(
                    "avatar", u.avatar_key
                ),
            }
        return Response(out, status=status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="images/upload-url")
    def chat_image_upload_url(self, request):
        """Issue a presigned PUT URL for an IM image message (P7).

        Body: ``{"content_type": "image/jpeg", "size": <bytes>}``. Returns
        ``{upload_url, object_key, expires_in, headers}``; the client PUTs the
        bytes to ``upload_url`` then sends an IM message with
        ``content_type='image'`` and ``body=object_key``. The image itself lives
        in the private chat-image bucket — read back via :meth:`resolve_images`.
        """
        data = request.data or {}
        content_type = data.get("content_type")
        size = data.get("size")
        if content_type not in utils.ALLOWED_CHAT_IMAGE_MIME_TYPES:
            raise ValidationError(
                {"content_type": "must be one of jpeg/png/webp/gif"}
            )
        if not isinstance(size, int) or size <= 0:
            raise ValidationError({"size": "positive integer byte size required"})
        if size > utils.MAX_CHAT_IMAGE_SIZE:
            raise ValidationError(
                {"size": f"max {utils.MAX_CHAT_IMAGE_SIZE} bytes"}
            )
        payload = utils.generate_chat_image_upload_url(
            user=request.user, content_type=content_type, size=size
        )
        return Response(payload, status=status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="files/upload-url")
    def chat_file_upload_url(self, request):
        """Issue a presigned PUT URL for an IM file attachment (P7-b).

        Body: ``{"content_type": "...", "size": <bytes>, "filename": "..."}``.
        Any content type is allowed (up to 50 MiB). The client PUTs the bytes
        then sends an IM message with ``content_type='file'`` and a JSON body
        ``{key, name, size}``; the object is read back via :meth:`resolve_images`
        (the resolve endpoint is content-agnostic over the ``chat/`` prefix).
        """
        data = request.data or {}
        content_type = data.get("content_type") or "application/octet-stream"
        size = data.get("size")
        filename = data.get("filename") or ""
        if not isinstance(content_type, str) or not content_type:
            raise ValidationError({"content_type": "string required"})
        if not isinstance(size, int) or size <= 0:
            raise ValidationError({"size": "positive integer byte size required"})
        if size > utils.MAX_CHAT_FILE_SIZE:
            raise ValidationError({"size": f"max {utils.MAX_CHAT_FILE_SIZE} bytes"})
        if not isinstance(filename, str):
            raise ValidationError({"filename": "string required"})
        payload = utils.generate_chat_file_upload_url(
            user=request.user,
            content_type=content_type,
            size=size,
            filename=filename,
        )
        return Response(payload, status=status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="audio/upload-url")
    def chat_audio_upload_url(self, request):
        """Issue a presigned PUT URL for an IM voice clip (P7-i).

        Body: ``{"content_type": "audio/webm", "size": <bytes>, "filename": "..."}``.
        Any audio content type is allowed (up to 20 MiB). The client PUTs the bytes
        then sends an IM message with ``content_type='voice'`` and a JSON body
        ``{key, duration}``; the object (``audio/`` prefix) is read back via
        :meth:`resolve_images`. Stored in its own private voice bucket.
        """
        data = request.data or {}
        content_type = data.get("content_type") or "audio/webm"
        size = data.get("size")
        filename = data.get("filename") or ""
        if not isinstance(content_type, str) or not content_type:
            raise ValidationError({"content_type": "string required"})
        if not isinstance(size, int) or size <= 0:
            raise ValidationError({"size": "positive integer byte size required"})
        if size > utils.MAX_CHAT_AUDIO_SIZE:
            raise ValidationError({"size": f"max {utils.MAX_CHAT_AUDIO_SIZE} bytes"})
        if not isinstance(filename, str):
            raise ValidationError({"filename": "string required"})
        payload = utils.generate_chat_audio_upload_url(
            user=request.user,
            content_type=content_type,
            size=size,
            filename=filename,
        )
        return Response(payload, status=status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="images/resolve")
    def resolve_images(self, request):
        """Resolve chat object keys → short-lived presigned GET URLs (P7).

        Body: ``{"object_keys": ["chat/<uid>/<uuid>.jpg", "file/<uid>/...", ...]}``.
        Returns ``{key: url}`` for keys under the ``chat/`` (image), ``file/``
        (attachment) or ``audio/`` (voice) prefixes, each routed to its bucket;
        other keys are skipped
        (the endpoint refuses to sign arbitrary bucket keys). URLs expire (1h),
        so the client re-resolves on a short staleTime, like avatar GET URLs.
        """
        data = request.data or {}
        raw = data.get("object_keys")
        if not isinstance(raw, list):
            raise ValidationError({"object_keys": "list of object_keys required"})
        seen: set = set()
        keys = []
        for k in raw:
            if isinstance(k, str) and k and k not in seen:
                seen.add(k)
                keys.append(k)
            if len(keys) >= 200:
                break

        out = {}
        for key in keys:
            url = utils.generate_chat_object_get_url(key)
            if url:
                out[key] = url
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

    @action(detail=False, methods=["post"], url_path="conversations/add-members")
    def conversations_add_members(self, request):
        """Add members to an existing group (P9 拉人). Any current member may add.

        Body: ``{cid, member_user_ids: [<we-meet uuid>, ...]}``. Members are
        resolved org-scoped to IM uids; a system message announces the join.
        """
        data = request.data or {}
        cid = (data.get("cid") or "").strip()
        raw_ids = data.get("member_user_ids")
        if not cid:
            raise ValidationError({"cid": "cid is required"})
        if not isinstance(raw_ids, list) or not raw_ids:
            raise ValidationError({"member_user_ids": "at least one member is required"})

        client = self._make_client()
        me = self._issue(client, self._external_id(request.user))
        self._require_role(client, cid, me, owner_only=False)

        users = self._org_users_by_ids(request.user, raw_ids)
        member_uids: list[str] = []
        names: list[str] = []
        for mid in dict.fromkeys(str(x) for x in raw_ids):
            user = users.get(mid)
            if user is None:
                continue
            uid = self._resolve_uid(client, user)
            if uid != me.uid and uid not in member_uids:
                member_uids.append(uid)
                names.append(self._display_name(user))
        if not member_uids:
            raise ValidationError({"member_user_ids": "no valid members to add"})

        try:
            result = client.add_members(cid, member_uids)
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            raise JusiImInvalidResponseHTTPError(detail=str(exc)) from exc

        if result.added > 0:
            self._post_system_message(
                client,
                cid,
                f"{self._display_name(request.user)} 邀请 {'、'.join(names)} 加入群聊",
            )
        return Response(
            {"cid": result.cid, "added": result.added, "members": result.members},
            status=status.HTTP_200_OK,
        )

    @action(detail=False, methods=["post"], url_path="conversations/remove-member")
    def conversations_remove_member(self, request):
        """Remove a member from a group (P9 踢人). Owner-only.

        Body: ``{cid, member_user_id}``. Use the leave/delete flow to remove
        yourself — kicking the owner is rejected by jusi.
        """
        data = request.data or {}
        cid = (data.get("cid") or "").strip()
        member_user_id = data.get("member_user_id")
        if not cid:
            raise ValidationError({"cid": "cid is required"})
        if not member_user_id:
            raise ValidationError({"member_user_id": "member_user_id is required"})

        client = self._make_client()
        me = self._issue(client, self._external_id(request.user))
        self._require_role(client, cid, me, owner_only=True)

        users = self._org_users_by_ids(request.user, [member_user_id])
        target = users.get(str(member_user_id))
        if target is None:
            raise ValidationError({"member_user_id": "not found in your organization"})
        target_uid = self._resolve_uid(client, target)
        if target_uid == me.uid:
            raise ValidationError({"member_user_id": "use leave to remove yourself"})

        try:
            result = client.remove_members(cid, [target_uid])
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            # jusi rejects removing the owner with 4xx.
            raise ValidationError({"member_user_id": str(exc)}) from exc

        if result.removed > 0:
            self._post_system_message(
                client,
                cid,
                f"{self._display_name(request.user)} 将 {self._display_name(target)} 移出群聊",
            )
        return Response(
            {"cid": result.cid, "removed": result.removed, "members": result.members},
            status=status.HTTP_200_OK,
        )

    @action(detail=False, methods=["post"], url_path="conversations/update")
    def conversations_update(self, request):
        """Update a group's meta — name (改群名) + description (群描述). Owner-only.

        Body: ``{cid, name, description, kind}``. jusi stores ``meta`` wholesale,
        so the client always sends the *complete* desired meta (the unchanged
        sibling value is preserved by the caller); ``kind`` ∈ {"rename",
        "description"} only selects which system message is announced.
        """
        data = request.data or {}
        cid = (data.get("cid") or "").strip()
        name = (data.get("name") or "").strip()
        description = (data.get("description") or "").strip()
        kind = (data.get("kind") or "rename").strip()
        if not cid:
            raise ValidationError({"cid": "cid is required"})
        if kind == "rename" and not name:
            raise ValidationError({"name": "name is required"})
        if len(name) > 60:
            raise ValidationError({"name": "name too long (max 60)"})
        if len(description) > 200:
            raise ValidationError({"description": "description too long (max 200)"})

        client = self._make_client()
        me = self._issue(client, self._external_id(request.user))
        self._require_role(client, cid, me, owner_only=True)

        # Build the complete meta (omit empty keys so meta stays tidy).
        meta: dict[str, Any] = {}
        if name:
            meta["name"] = name
        if description:
            meta["description"] = description
        try:
            client.update_meta(cid, meta)
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            raise JusiImInvalidResponseHTTPError(detail=str(exc)) from exc

        actor = self._display_name(request.user)
        if kind == "description":
            self._post_system_message(client, cid, f"{actor} 修改了群描述")
        else:
            self._post_system_message(client, cid, f'{actor} 将群名改为 "{name}"')

        return Response(
            {"cid": cid, "name": name, "description": description},
            status=status.HTTP_200_OK,
        )

    @action(detail=False, methods=["post"], url_path="conversations/announce-leave")
    def conversations_announce_leave(self, request):
        """Post a "X 退出群聊" system message (P9.1).

        The actual leave still goes through the SDK → REST DELETE path (which
        handles owner auto-transfer / dissolve); this endpoint only injects the
        announcement, called by the client *just before* it leaves while the
        caller is still a member. Best-effort — failure must not block leaving.
        """
        data = request.data or {}
        cid = (data.get("cid") or "").strip()
        if not cid:
            raise ValidationError({"cid": "cid is required"})

        client = self._make_client()
        me = self._issue(client, self._external_id(request.user))
        # Confirm membership (also guards against announcing on a conv you're not in).
        self._require_role(client, cid, me, owner_only=False)

        self._post_system_message(
            client, cid, f"{self._display_name(request.user)} 退出群聊"
        )
        return Response({"cid": cid}, status=status.HTTP_200_OK)

    # ---- shared helpers (P9) ----

    def _make_client(self) -> JusiImAdminClient:
        """Build a JusiImAdminClient from settings or raise 502 if unconfigured."""
        cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
        if not cfg:
            logger.error("JUSI_IM_CONFIGURATION not configured")
            raise JusiImUnreachableHTTPError(detail="JUSI_IM not configured")
        return JusiImAdminClient(
            api_url=str(cfg["api_url"]),
            admin_hmac_secret=str(cfg["admin_hmac_secret"]),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
        )

    @staticmethod
    def _issue(client, external_id):
        """issue_token wrapped to map service errors to HTTP errors."""
        try:
            return client.issue_token(external_id=external_id, ttl_seconds=60)
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            raise JusiImInvalidResponseHTTPError(detail=str(exc)) from exc

    @staticmethod
    def _resolve_uid(client, user) -> str:
        """Resolve a User → IM uid (lazy-register) + backfill the cache."""
        resolved = ImViewSet._issue(client, ImViewSet._external_id(user))
        ImViewSet._cache_im_uid(user, resolved.uid)
        return resolved.uid

    @staticmethod
    def _org_users_by_ids(caller, ids) -> dict:
        """{id_str: User} for ids that are active members of the caller's org."""
        organization = get_caller_organization(caller)
        if organization is None:
            raise ValidationError({"member_user_ids": "caller has no organization"})
        valid = []
        for raw in ids:
            try:
                valid.append(uuid.UUID(str(raw)))
            except (ValueError, AttributeError, TypeError):
                continue
        users = (
            models.User.objects.filter(
                id__in=valid,
                is_device=False,
                memberships__organization=organization,
                memberships__status=models.MembershipStatusChoices.ACTIVE,
            )
            .distinct()
        )
        return {str(u.id): u for u in users}

    def _require_role(self, client, cid, me, *, owner_only: bool) -> list:
        """Fetch the roster as the caller; enforce membership / ownership.

        jusi only returns the roster to members, so a successful fetch already
        proves membership; owner_only additionally requires role==owner.
        """
        try:
            roster = client.get_members(cid, me.token)
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            # 403/404 from jusi → caller isn't a member (or cid gone).
            raise PermissionDenied("not a member of this conversation") from exc
        if owner_only:
            is_owner = any(
                m.get("uid") == me.uid and m.get("role") == "owner" for m in roster
            )
            if not is_owner:
                raise PermissionDenied("only the group owner may do this")
        return roster

    @staticmethod
    def _post_system_message(client, cid, body) -> None:
        """Best-effort system message (content_type=system); never fails the op."""
        try:
            client.post_message(cid=cid, body=body, content_type="system")
        except JusiImServiceError:
            logger.warning("im: system message post failed for %s", cid, exc_info=True)

    @staticmethod
    def _display_name(user) -> str:
        return (
            getattr(user, "full_name", None)
            or getattr(user, "short_name", None)
            or getattr(user, "email", None)
            or "成员"
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
