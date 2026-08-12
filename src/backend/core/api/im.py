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
from django.db.models import Q

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

from core import models, utils
from core.api.directory import get_caller_organization
from core.services import im_conversations
from core.services.jusi_im import (
    JusiImAdminClient,
    JusiImBadResponseError,
    JusiImServiceError,
    JusiImUnreachableError,
)

logger = logging.getLogger(__name__)


# Who may be resolved to a name in chat history. Deliberately wider than the
# directory's ACTIVE-only rule: once someone leaves, every message they ever
# sent would otherwise render as a raw uid. "Was a member of this organization"
# is the right bar — cross-org resolution stays closed.
RESOLVABLE_MEMBERSHIP_STATUSES = (
    models.MembershipStatusChoices.ACTIVE,
    models.MembershipStatusChoices.LEFT,
    models.MembershipStatusChoices.SUSPENDED,
)


def _departed_user_ids(organization, user_ids) -> set:
    """Of these users, which have no active membership left in the organization.

    Drives the "(已离职)" suffix and greyed avatar in chat history. One query,
    not one per user.
    """
    if organization is None or not user_ids:
        return set()
    still_active = set(
        models.Membership.objects.filter(
            organization=organization,
            user_id__in=user_ids,
            status=models.MembershipStatusChoices.ACTIVE,
        ).values_list("user_id", flat=True)
    )
    return {uid for uid in user_ids if uid not in still_active}


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
                memberships__status__in=RESOLVABLE_MEMBERSHIP_STATUSES,
            ).distinct()
        else:
            # No org → only resolve self, never other users.
            qs = qs.filter(pk=request.user.pk)

        left_ids = _departed_user_ids(organization, [u.id for u in qs])
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
                "left": u.id in left_ids,
            }

        # Group bots (群机器人). Resolved here rather than through a second
        # endpoint because this is already the call every client makes for every
        # uid it sees in a conversation — a bot bubble gets its avatar, name and
        # description with no client-side change beyond reading two new keys.
        # Bots are not Users (they have no sub, no membership, no push tokens),
        # so they cannot come from the query above.
        missing = [u for u in uids if u not in out]
        if missing:
            bots = models.ImBot.objects.filter(im_uid__in=missing, is_active=True)
            if organization is not None:
                # Built-in assistants are global (organization is null); custom
                # bots stay scoped like people do.
                bots = bots.filter(
                    Q(organization=organization) | Q(organization__isnull=True)
                )
            else:
                bots = bots.filter(organization__isnull=True)
            for bot in bots:
                out[bot.im_uid] = {
                    "id": str(bot.id),
                    "full_name": bot.name,
                    "short_name": bot.name,
                    "avatar_url": utils.generate_profile_image_get_url(
                        "avatar", bot.avatar_key
                    ),
                    "left": False,
                    # Older clients ignore unknown keys; newer ones render the
                    # 「机器人」chip and the description subtitle from these.
                    "is_bot": True,
                    "description": bot.description,
                }
        return Response(out, status=status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="users/resolve-subs")
    def resolve_subs(self, request):
        """Resolve OIDC subs → display names/avatars (P4 通话多人宫格).

        Body: ``{"subs": ["<sub>", ...]}``. Same org-scoped contract as
        :meth:`resolve_users`, keyed by ``User.sub`` instead of the IM uid —
        LiveKit participant identity IS the sub (``utils.generate_token``), so
        the in-call grid resolves room occupants to directory profiles without
        trusting the token's self-chosen display name.
        """
        data = request.data or {}
        raw = data.get("subs")
        if not isinstance(raw, list):
            raise ValidationError({"subs": "list of subs required"})
        seen: set = set()
        subs = []
        for s in raw:
            if isinstance(s, str) and s and s not in seen:
                seen.add(s)
                subs.append(s)
            if len(subs) >= 200:
                break

        out: dict = {}
        if not subs:
            return Response(out, status=status.HTTP_200_OK)

        organization = get_caller_organization(request.user)
        qs = models.User.objects.filter(sub__in=subs, is_device=False)
        if organization is not None:
            qs = qs.filter(
                memberships__organization=organization,
                memberships__status__in=RESOLVABLE_MEMBERSHIP_STATUSES,
            ).distinct()
        else:
            qs = qs.filter(pk=request.user.pk)

        left_ids = _departed_user_ids(organization, [u.id for u in qs])
        for u in qs:
            out[str(u.sub)] = {
                "id": str(u.id),
                "full_name": u.full_name or u.short_name or u.email or "",
                "short_name": u.short_name or "",
                "avatar_url": utils.generate_profile_image_get_url(
                    "avatar", u.avatar_key
                ),
                "left": u.id in left_ids,
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
            raise ValidationError({"content_type": "must be one of jpeg/png/webp/gif"})
        if not isinstance(size, int) or size <= 0:
            raise ValidationError({"size": "positive integer byte size required"})
        if size > utils.MAX_CHAT_IMAGE_SIZE:
            raise ValidationError({"size": f"max {utils.MAX_CHAT_IMAGE_SIZE} bytes"})
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
            result = client.create_direct(
                cid=cid, owner_uid=self_uid, peer_uid=peer_uid
            )
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
            raise ValidationError({"member_user_ids": "no valid members to add"})

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

        # M 端治理页要显示群名,而 jusi 没有 admin 读接口 —— we-meet 是群名的
        # 唯一写入方,写路径顺手记一份天然是准的。best-effort,见服务模块。
        im_conversations.project(
            result.cid,
            name=name,
            organization=get_caller_organization(request.user),
            created_by=request.user,
        )
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
            raise ValidationError(
                {"member_user_ids": "at least one member is required"}
            )

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

        # 只在这次真的改了名字时才写投影 —— kind="description" 时 name 是
        # 调用方带过来的原值,不代表改名。
        if kind != "description":
            im_conversations.project(
                cid,
                name=name,
                organization=get_caller_organization(request.user),
            )
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

    @action(detail=False, methods=["post"], url_path="messages/delete")
    def messages_delete(self, request):
        """Legacy 「删除消息」 shim for already-shipped clients (P24 D2).

        Body: ``{cid, mids: [<mid string>, ...]}``. Membership is confirmed and
        the mids validated, but nothing is persisted — old APKs pair this call
        with a purely local hide, and that stays their behaviour.

        Current clients do NOT come here: they send the jusi ``delete`` ws frame
        and get server-side 仅对我删除 with multi-device sync (jusi P24). Keep
        this endpoint until those old builds are out of the wild; do not add
        behaviour to it.
        """
        data = request.data or {}
        cid = (data.get("cid") or "").strip()
        raw_mids = data.get("mids")
        if not cid:
            raise ValidationError({"cid": "cid is required"})
        if not isinstance(raw_mids, list) or not raw_mids:
            raise ValidationError({"mids": "at least one mid is required"})

        # De-dupe mids.
        mids: list[str] = []
        seen: set = set()
        for m in raw_mids:
            s = str(m).strip()
            if s and s not in seen:
                seen.add(s)
                mids.append(s)
        if not mids:
            raise ValidationError({"mids": "at least one valid mid is required"})

        # Confirm membership (also verifies IM connectivity).
        client = self._make_client()
        me = self._issue(client, self._external_id(request.user))
        self._require_role(client, cid, me, owner_only=False)

        return Response({"cid": cid, "deleted": len(mids)}, status=status.HTTP_200_OK)

    @action(detail=False, methods=["get"], url_path="search")
    def search(self, request):
        """Full-text message search across the caller's conversations (P1-M1).

        ``GET /api/v1.0/im/search/?q=&cid=&limit=&before_mid=`` — proxies jusi's
        ``POST /admin/search/messages`` as the caller's IM identity (sub→uid
        resolve happens here; membership is the permission model server-side).
        Response: ``{items: [...], next_before_mid}`` passed through verbatim.
        """
        q = (request.query_params.get("q") or "").strip()
        if len(q) < 2:
            raise ValidationError({"q": "q must be at least 2 characters"})
        cid = (request.query_params.get("cid") or "").strip() or None
        try:
            limit = min(max(int(request.query_params.get("limit") or 20), 1), 50)
        except ValueError as exc:
            raise ValidationError({"limit": "bad limit"}) from exc
        try:
            before_mid = int(request.query_params.get("before_mid") or 0)
        except ValueError as exc:
            raise ValidationError({"before_mid": "bad before_mid"}) from exc

        client = self._make_client()
        uid = self._resolve_uid(client, request.user)
        try:
            data = client.search_messages(
                uid=uid, q=q, cid=cid, limit=limit, before_mid=before_mid
            )
        except JusiImUnreachableError as exc:
            raise JusiImUnreachableHTTPError(detail=str(exc)) from exc
        except JusiImBadResponseError as exc:
            raise JusiImInvalidResponseHTTPError(detail=str(exc)) from exc
        return Response(data, status=status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="grant-doc-access")
    def grant_doc_access(self, request):
        """分享云文档到聊天:给会话成员精准授文档**只读**权限。

        Body ``{doc_id, cids: [...]}``。对每个会话以调用者身份拉 roster
        (jusi 只对成员返回 roster → 天然校验调用者确在会话内;非成员/不可达的
        cid 跳过,不连累其余),收集成员 uid → we-meet User →(sub, email)→
        调 Docs s2s 精准授权(在 Docs 建 reader access / 未登录过按 email 建
        invitation)。**best-effort**:Docs/jusi 未配置或失败一律 granted=0,绝不
        阻断分享本身(卡片由客户端经 IM SDK 独立发送,与本调用解耦)。跨组织成员
        照授(不做 org 过滤)——群可跨组织,与「能给会话发消息即可授其只读」一致。
        """
        doc_id = str(request.data.get("doc_id") or "").strip()
        cids = request.data.get("cids")
        if not doc_id or not isinstance(cids, list) or not cids:
            raise ValidationError({"detail": "doc_id and cids[] required"})

        docs_cfg = getattr(settings, "DOCS_CONFIGURATION", None) or {}
        api_url = docs_cfg.get("api_url") or ""
        token = docs_cfg.get("server_to_server_token") or ""
        if not api_url or not token:
            return Response({"granted": 0})

        from core.services.docs_client import DocsClient, DocsServiceError

        docs_client = DocsClient(
            api_url=str(api_url),
            server_to_server_token=str(token),
            timeout_seconds=float(docs_cfg.get("request_timeout_seconds") or 3),
        )
        # ``doc_id`` is client input, not proof that the caller may share it.
        # Ask Docs (the access-control authority) before resolving recipients.
        # A failed visibility check must fail closed rather than grant access.
        try:
            can_share = docs_client.user_can_access_document(
                sub=str(request.user.sub or ""), doc_id=doc_id
            )
        except DocsServiceError as exc:
            logger.warning("grant-doc-access visibility check failed: %s", exc)
            return Response({"granted": 0})
        if not can_share:
            raise PermissionDenied("You do not have access to this document.")

        client = self._make_client()
        me = self._issue(client, self._external_id(request.user))
        member_uids: set[str] = set()
        for raw_cid in cids:
            cid = str(raw_cid or "").strip()
            if not cid:
                continue
            try:
                roster = self._require_role(client, cid, me, owner_only=False)
            except (
                PermissionDenied,
                JusiImUnreachableHTTPError,
                JusiImInvalidResponseHTTPError,
            ):
                # 调用者不是该会话成员 / jusi 抖动 → 跳过此 cid。
                continue
            for member in roster:
                uid = str(member.get("uid") or "")
                if uid and uid != me.uid:
                    member_uids.add(uid)
        if not member_uids:
            return Response({"granted": 0})

        # 不做组织过滤:群可跨组织,授权面 = 会话全体成员本身。
        users = models.User.objects.filter(im_uid__in=member_uids, is_device=False)
        payload = [
            {"sub": str(u.sub or ""), "email": str(u.email or "")}
            for u in users
            if u.sub
        ]
        if not payload:
            return Response({"granted": 0})

        try:
            granted = docs_client.grant_access_for_users(doc_id=doc_id, users=payload)
        except DocsServiceError as exc:
            logger.warning("grant-doc-access degraded: %s", exc)
            return Response({"granted": 0})
        return Response({"granted": granted})

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
        users = models.User.objects.filter(
            id__in=valid,
            is_device=False,
            memberships__organization=organization,
            memberships__status=models.MembershipStatusChoices.ACTIVE,
        ).distinct()
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

        Restricted to users sharing the caller's organization or an accepted
        external-contact relationship, so an arbitrary cross-org id cannot be
        used to force a direct conversation.
        """
        try:
            uuid.UUID(str(peer_user_id))
        except (ValueError, AttributeError, TypeError) as exc:
            raise ValidationError({"peer_user_id": "invalid id"}) from exc

        organization = get_caller_organization(caller)
        if organization is None:
            raise ValidationError({"peer_user_id": "caller has no organization"})

        peer = models.User.objects.filter(
            id=peer_user_id, is_active=True, is_device=False
        ).first()
        same_org = bool(
            peer
            and models.Membership.objects.filter(
                user=peer,
                organization=organization,
                status=models.MembershipStatusChoices.ACTIVE,
            ).exists()
        )
        external_contact = bool(
            peer
            and models.ExternalContact.objects.filter(
                Q(user_a=caller, user_b=peer) | Q(user_a=peer, user_b=caller),
                status=models.ExternalContactStatusChoices.ACCEPTED,
            ).exists()
        )
        if peer is None or not (same_org or external_contact):
            raise ValidationError({"peer_user_id": "not found in your contacts"})

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
            logger.warning(
                "im: failed to cache im_uid for user %s", user.pk, exc_info=True
            )
