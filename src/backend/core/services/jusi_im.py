"""HMAC-authenticated client for the jusi-light-im admin API.

Talks to ``POST /admin/tokens/issue`` and surfaces a small typed result object.

The signing scheme matches jusi-light-im's `internal/api/admin/auth.go`:

    sig = HMAC_SHA256(secret, METHOD + "\\n" + PATH + "\\n" + UNIX_TS + "\\n" + RAW_BODY)

method + path are included to prevent a captured signature from being replayed against
a different endpoint.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from dataclasses import dataclass
from typing import Any

import requests

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class JusiImTokenResponse:
    """Result of POST /admin/tokens/issue."""

    uid: str
    token: str
    expires_at: int  # unix seconds


@dataclass(frozen=True)
class JusiImConversationResponse:
    """Result of POST /admin/conversations (P5)."""

    cid: str
    type: str  # "group" | "direct"
    owner_uid: str
    members: list[str]
    created_at: int  # unix ms


@dataclass(frozen=True)
class JusiImAddMembersResponse:
    """Result of POST /admin/conversations/{cid}/members (P5; P9 adds removed)."""

    cid: str
    added: int
    members: list[str]
    removed: int = 0


@dataclass(frozen=True)
class JusiImMessageResponse:
    """Result of POST /admin/messages (P5, system-injected message)."""

    mid: int
    cid: str
    sender_uid: str
    seq: int
    ts: int  # unix ms


class JusiImServiceError(Exception):
    """Base for failures talking to jusi-light-im."""


class JusiImUnreachableError(JusiImServiceError):
    """Network-level failure: DNS, connect refused, timeout, 5xx."""


class JusiImBadResponseError(JusiImServiceError):
    """HTTP returned but the response was malformed or 4xx."""


class JusiImAdminClient:
    """Thin HMAC-signing wrapper around the jusi-light-im admin endpoints we use."""

    def __init__(
        self,
        api_url: str,
        admin_hmac_secret: str,
        *,
        timeout_seconds: float = 5.0,
    ) -> None:
        if not api_url:
            raise ValueError("api_url is required")
        if not admin_hmac_secret or len(admin_hmac_secret) < 32:
            raise ValueError("admin_hmac_secret must be at least 32 characters")
        # Strip trailing slash so we can safely concatenate `/admin/...`.
        self._api_url = api_url.rstrip("/")
        self._secret = admin_hmac_secret.encode("utf-8")
        self._timeout = timeout_seconds

    def issue_token(self, external_id: str, ttl_seconds: int) -> JusiImTokenResponse:
        """Resolve external_id → uid in jusi-light-im and sign a fresh IM JWT."""
        if not external_id:
            raise ValueError("external_id is required")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")

        path = "/admin/tokens/issue"
        body = self._json_body({"external_id": external_id, "ttl_seconds": ttl_seconds})
        headers = self._signed_headers("POST", path, body)
        url = self._api_url + path

        try:
            response = requests.post(
                url,
                data=body,
                headers=headers,
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            logger.exception("jusi-im admin unreachable: %s", url)
            raise JusiImUnreachableError(str(exc)) from exc

        if response.status_code >= 500:
            raise JusiImUnreachableError(
                f"jusi-im returned {response.status_code} from {path}"
            )
        if response.status_code >= 400:
            raise JusiImBadResponseError(
                f"jusi-im returned {response.status_code} from {path}: "
                f"{response.text[:200]}"
            )
        try:
            data: dict[str, Any] = response.json()
        except ValueError as exc:
            raise JusiImBadResponseError("response was not JSON") from exc

        try:
            return JusiImTokenResponse(
                uid=data["uid"],
                token=data["token"],
                expires_at=int(data["expires_at"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise JusiImBadResponseError(f"unexpected response shape: {data}") from exc

    # ---- P5: meeting bridge admin endpoints ----

    def create_group(
        self,
        cid: str,
        owner_uid: str,
        members: list[str] | None = None,
        meta: dict[str, Any] | None = None,
    ) -> JusiImConversationResponse:
        """Create (or get) a group conversation idempotently.

        `cid` MUST be supplied — jusi admin enforces deterministic cid for the
        idempotent path. we-meet computes `uuid5(NAMESPACE_OID, "room:<room_id>")`
        upstream and passes it here.
        """
        if not cid:
            raise ValueError("cid is required")
        if not owner_uid:
            raise ValueError("owner_uid is required")
        payload: dict[str, Any] = {
            "cid": cid,
            "type": "group",
            "owner_uid": owner_uid,
        }
        if members:
            payload["members"] = list(members)
        if meta is not None:
            payload["meta"] = meta
        data = self._signed_request("POST", "/admin/conversations", payload)
        try:
            return JusiImConversationResponse(
                cid=data["cid"],
                type=data["type"],
                owner_uid=data.get("owner_uid", ""),
                members=list(data.get("members") or []),
                created_at=int(data.get("created_at") or 0),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise JusiImBadResponseError(
                f"create_group: unexpected response shape: {data}"
            ) from exc

    def create_direct(
        self,
        cid: str,
        owner_uid: str,
        peer_uid: str,
    ) -> JusiImConversationResponse:
        """Create (or get) a direct (1-on-1) conversation idempotently.

        Caller MUST compute a deterministic cid from the sorted (owner_uid, peer_uid)
        pair so A→B and B→A converge on the same row. jusi-light-im admin endpoint
        relies on cid uniqueness for the idempotent path.
        """
        if not cid:
            raise ValueError("cid is required")
        if not owner_uid:
            raise ValueError("owner_uid is required")
        if not peer_uid:
            raise ValueError("peer_uid is required")
        if owner_uid == peer_uid:
            raise ValueError("owner_uid and peer_uid must differ")
        payload: dict[str, Any] = {
            "cid": cid,
            "type": "direct",
            "owner_uid": owner_uid,
            "members": [peer_uid],
        }
        data = self._signed_request("POST", "/admin/conversations", payload)
        try:
            return JusiImConversationResponse(
                cid=data["cid"],
                type=data["type"],
                owner_uid=data.get("owner_uid", ""),
                members=list(data.get("members") or []),
                created_at=int(data.get("created_at") or 0),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise JusiImBadResponseError(
                f"create_direct: unexpected response shape: {data}"
            ) from exc

    def add_members(self, cid: str, uids: list[str]) -> JusiImAddMembersResponse:
        """Append uids to cid's member set. Idempotent — duplicates are silently
        no-ops (server returns `added=0` for a uid that was already present)."""
        if not cid:
            raise ValueError("cid is required")
        path = f"/admin/conversations/{cid}/members"
        payload = {"add": list(uids or [])}
        data = self._signed_request("POST", path, payload)
        return self._parse_members_response("add_members", data)

    def remove_members(self, cid: str, uids: list[str]) -> JusiImAddMembersResponse:
        """Remove uids from cid (P9 踢人). jusi rejects removing the owner (4xx →
        JusiImBadResponseError). Idempotent for non-members (removed=0)."""
        if not cid:
            raise ValueError("cid is required")
        path = f"/admin/conversations/{cid}/members"
        payload = {"remove": list(uids or [])}
        data = self._signed_request("POST", path, payload)
        return self._parse_members_response("remove_members", data)

    def update_meta(self, cid: str, meta: dict[str, Any]) -> None:
        """Replace cid's meta JSON wholesale (P9 群改名 lives in meta.name)."""
        if not cid:
            raise ValueError("cid is required")
        path = f"/admin/conversations/{cid}"
        self._signed_request("PATCH", path, {"meta": meta})

    def get_members(self, cid: str, user_token: str) -> list[dict[str, Any]]:
        """GET the roster as a member via jusi REST (Bearer, NOT admin HMAC).

        Returns ``[{uid, role, joined_at}]``. Used by the bridge to enforce
        owner-only actions (kick / rename): we issue the caller a short-lived
        token, then read their role here. A non-member gets 403 → BadResponse.
        """
        if not cid:
            raise ValueError("cid is required")
        url = f"{self._api_url}/v1/conversations/{cid}/members"
        try:
            response = requests.get(
                url,
                headers={"Authorization": f"Bearer {user_token}"},
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            logger.exception("jusi-im REST unreachable: %s", url)
            raise JusiImUnreachableError(str(exc)) from exc
        if response.status_code >= 500:
            raise JusiImUnreachableError(
                f"jusi-im returned {response.status_code} from {url}"
            )
        if response.status_code >= 400:
            raise JusiImBadResponseError(
                f"jusi-im returned {response.status_code} from members: "
                f"{response.text[:200]}"
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise JusiImBadResponseError("members response was not JSON") from exc
        if not isinstance(data, list):
            raise JusiImBadResponseError(f"members: unexpected shape: {data}")
        return data

    def _parse_members_response(
        self, op: str, data: dict[str, Any]
    ) -> JusiImAddMembersResponse:
        try:
            return JusiImAddMembersResponse(
                cid=data["cid"],
                added=int(data.get("added") or 0),
                removed=int(data.get("removed") or 0),
                members=list(data.get("members") or []),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise JusiImBadResponseError(
                f"{op}: unexpected response shape: {data}"
            ) from exc

    def post_message(
        self,
        cid: str,
        body: str,
        sender_uid: str | None = None,
        content_type: str = "text",
    ) -> JusiImMessageResponse:
        """Inject a server-side message into cid. Bypasses WS and client identity.

        Pass `sender_uid=None` to use the server's SYSTEM uid
        (00000000-0000-0000-0000-000000000000). Use a real uid for bot-style messages.
        """
        if not cid:
            raise ValueError("cid is required")
        if not body:
            raise ValueError("body is required")
        payload: dict[str, Any] = {"cid": cid, "body": body, "content_type": content_type}
        if sender_uid:
            payload["sender_uid"] = sender_uid
        data = self._signed_request("POST", "/admin/messages", payload)
        try:
            return JusiImMessageResponse(
                mid=int(data["mid"]),
                cid=data["cid"],
                sender_uid=data["sender_uid"],
                seq=int(data["seq"]),
                ts=int(data.get("ts") or 0),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise JusiImBadResponseError(
                f"post_message: unexpected response shape: {data}"
            ) from exc

    def delete_messages(self, cid: str, mids: list[str]) -> dict[str, Any]:
        """Batch-delete messages from cid. Deleted messages are hidden for all members.

        ``mids`` is a list of message id strings. The response shape::

            {"cid": "<cid>", "deleted": <int>}
        """
        if not cid:
            raise ValueError("cid is required")
        if not mids:
            raise ValueError("at least one mid is required")
        payload: dict[str, Any] = {"cid": cid, "mids": list(mids)}
        data = self._signed_request("POST", "/admin/messages/delete", payload)
        try:
            return {"cid": data["cid"], "deleted": int(data["deleted"])}
        except (KeyError, TypeError, ValueError) as exc:
            raise JusiImBadResponseError(
                f"delete_messages: unexpected response shape: {data}"
            ) from exc

    # ---- helpers ----

    def _signed_request(self, method: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Sign + POST + parse JSON. Shared by every admin call.

        Surfaces:
          - JusiImUnreachableError on connect/timeout/5xx
          - JusiImBadResponseError on 4xx / non-JSON / shape mismatch
        """
        body = self._json_body(payload)
        headers = self._signed_headers(method, path, body)
        url = self._api_url + path
        try:
            response = requests.request(
                method,
                url,
                data=body,
                headers=headers,
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            logger.exception("jusi-im admin unreachable: %s", url)
            raise JusiImUnreachableError(str(exc)) from exc

        if response.status_code >= 500:
            raise JusiImUnreachableError(
                f"jusi-im returned {response.status_code} from {path}"
            )
        if response.status_code >= 400:
            raise JusiImBadResponseError(
                f"jusi-im returned {response.status_code} from {path}: "
                f"{response.text[:200]}"
            )
        try:
            return response.json()
        except ValueError as exc:
            raise JusiImBadResponseError("response was not JSON") from exc

    def _signed_headers(self, method: str, path: str, body: bytes) -> dict[str, str]:
        ts = str(int(time.time()))
        mac = hmac.new(self._secret, digestmod=hashlib.sha256)
        mac.update(method.encode("ascii"))
        mac.update(b"\n")
        mac.update(path.encode("utf-8"))
        mac.update(b"\n")
        mac.update(ts.encode("ascii"))
        mac.update(b"\n")
        mac.update(body)
        return {
            "Content-Type": "application/json",
            "X-Timestamp": ts,
            "X-Signature": mac.hexdigest(),
        }

    @staticmethod
    def _json_body(payload: dict[str, Any]) -> bytes:
        # Compact form so the body bytes match exactly what we sign + send on the wire.
        import json

        return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode(
            "utf-8"
        )
