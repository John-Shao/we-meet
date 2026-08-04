"""HTTP client for La Suite Docs' server-to-server document API (P3).

Talks to ``POST /api/v1.0/documents/create-for-owner/`` — Docs' purpose-built
server-to-server endpoint (auth class ``ServerToServerAuthentication``, gated by a
shared token in Docs' ``SERVER_TO_SERVER_API_TOKENS``). Lets we-meet create a
document owned by a given user — identified by Keycloak ``sub`` with ``email`` as a
fallback so Docs can lazily provision a user who hasn't logged into Docs yet — with
initial **markdown** content (Docs converts it to its internal yjs format via a Node
microservice). Used to land a meeting summary as a collaborative Doc (妙记).

Design + spike findings: docs/phases/p3-collab-docs.md. Mirrors the shape of
core/services/jusi_im.py (typed result + Unreachable/BadResponse error split).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import requests

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DocsCreateResponse:
    """Result of POST /api/v1.0/documents/create-for-owner/."""

    id: str


@dataclass(frozen=True)
class DocsSearchHit:
    """One row of GET /api/v1.0/documents/search-for-user/(P1-4 M1)。"""

    id: str
    title: str
    updated_at: str


@dataclass(frozen=True)
class DocsSearchPage:
    """一页搜索结果。

    ``has_more`` 让调用方不必再问一次总数就能决定要不要给「加载更多」——
    Docs 侧是多取一条判出来的,不走 COUNT。
    """

    hits: list[DocsSearchHit]
    has_more: bool


class DocsServiceError(Exception):
    """Base for failures talking to La Suite Docs."""


class DocsUnreachableError(DocsServiceError):
    """Network-level failure: DNS, connect refused, timeout, 5xx."""


class DocsBadResponseError(DocsServiceError):
    """HTTP returned but the response was 4xx / malformed."""


class DocsClient:
    """Thin client over the Docs server-to-server document endpoint."""

    CREATE_FOR_OWNER_PATH = "/api/v1.0/documents/create-for-owner/"

    def __init__(
        self,
        api_url: str,
        server_to_server_token: str,
        *,
        timeout_seconds: float = 5.0,
    ) -> None:
        if not api_url:
            raise ValueError("api_url is required")
        if not server_to_server_token:
            raise ValueError("server_to_server_token is required")
        self._api_url = str(api_url).rstrip("/")
        self._token = str(server_to_server_token)
        self._timeout = timeout_seconds

    def create_for_owner(
        self,
        *,
        sub: str,
        email: str,
        title: str,
        content: str,
        message: str | None = None,
        subject: str | None = None,
    ) -> DocsCreateResponse:
        """Create a Docs document owned by (sub/email) with markdown ``content``.

        ``content`` is markdown — Docs converts it server-side to its internal
        format. Returns the created document id.
        """
        if not sub and not email:
            raise ValueError("sub or email is required to identify the owner")
        if not title:
            raise ValueError("title is required")

        payload: dict[str, Any] = {
            "sub": str(sub or ""),
            "email": str(email or ""),
            "title": title,
            "content": content or "",
        }
        if message:
            payload["message"] = message
        if subject:
            payload["subject"] = subject

        url = self._api_url + self.CREATE_FOR_OWNER_PATH
        try:
            response = requests.post(
                url,
                json=payload,
                # Docs' ServerToServerAuthentication bears a token listed in its
                # SERVER_TO_SERVER_API_TOKENS. Exact header format to confirm at
                # deploy (read Docs core/api/authentication.py); Bearer is the default.
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            logger.exception("docs server unreachable: %s", url)
            raise DocsUnreachableError(str(exc)) from exc

        if response.status_code >= 500:
            raise DocsUnreachableError(
                f"docs returned {response.status_code} from {self.CREATE_FOR_OWNER_PATH}"
            )
        if response.status_code >= 400:
            raise DocsBadResponseError(
                f"docs returned {response.status_code} from "
                f"{self.CREATE_FOR_OWNER_PATH}: {response.text[:200]}"
            )
        try:
            data: dict[str, Any] = response.json()
        except ValueError as exc:
            raise DocsBadResponseError("response was not JSON") from exc
        try:
            return DocsCreateResponse(id=str(data["id"]))
        except (KeyError, TypeError) as exc:
            raise DocsBadResponseError(f"unexpected response shape: {data}") from exc

    SEARCH_FOR_USER_PATH = "/api/v1.0/documents/search-for-user/"

    def search_for_user(
        self,
        *,
        sub: str,
        query: str,
        limit: int | None = None,
        offset: int | None = None,
    ) -> DocsSearchPage:
        """按用户可见范围搜文档标题(P1-4 搜索入口统一 M1)。

        代理 Docs 的 s2s ``search-for-user`` 端点——可见性过滤在 Docs 侧
        (DocumentAccess ∪ 非受限 LinkTrace,与用户登录态完全同口径)。
        ``sub`` 必须来自调用者身份,绝不接受请求参数。

        ``limit``/``offset`` 不传时用 Docs 侧默认(8 条),与加分页前完全一致。
        """
        if not sub:
            raise ValueError("sub is required")
        if not query or len(query.strip()) < 2:
            return DocsSearchPage(hits=[], has_more=False)

        params: dict[str, Any] = {"sub": sub, "q": query.strip()}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        url = self._api_url + self.SEARCH_FOR_USER_PATH
        try:
            response = requests.get(
                url,
                params=params,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            logger.exception("docs server unreachable: %s", url)
            raise DocsUnreachableError(str(exc)) from exc

        if response.status_code >= 500:
            raise DocsUnreachableError(
                f"docs returned {response.status_code} from {self.SEARCH_FOR_USER_PATH}"
            )
        if response.status_code >= 400:
            raise DocsBadResponseError(
                f"docs returned {response.status_code} from "
                f"{self.SEARCH_FOR_USER_PATH}: {response.text[:200]}"
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise DocsBadResponseError("response was not JSON") from exc
        results = data.get("results") if isinstance(data, dict) else None
        if not isinstance(results, list):
            raise DocsBadResponseError(f"unexpected response shape: {data}")
        hits: list[DocsSearchHit] = []
        for row in results:
            if not isinstance(row, dict):
                continue
            hits.append(
                DocsSearchHit(
                    id=str(row.get("id") or ""),
                    title=str(row.get("title") or ""),
                    updated_at=str(row.get("updated_at") or ""),
                )
            )
        # ``has_more`` 是加分页时新增的字段。老 Docs 镜像不返回它 → 按"没有下一页"
        # 处理,前端不显示「加载更多」,与加分页前的表现一致。
        return DocsSearchPage(hits=hits, has_more=bool(data.get("has_more")))

    def user_can_access_document(self, *, sub: str, doc_id: str) -> bool:
        """Return whether Docs currently exposes ``doc_id`` to ``sub``.

        Docs is authoritative for ownership and reader access.  This check is
        required before a server-to-server grant can add other readers.
        """
        if not sub or not doc_id:
            return False
        return any(hit.id == doc_id for hit in self.list_for_user(sub=sub))

    GRANT_ACCESS_PATH = "/api/v1.0/documents/grant-access-for-users/"

    def grant_access_for_users(
        self, *, doc_id: str, users: list[dict[str, str]]
    ) -> int:
        """精准授权:给一批用户(会话成员)对文档授只读(分享云文档到聊天)。

        ``users`` = ``[{"sub", "email"}]``——Docs 侧按 sub 命中授
        DocumentAccess(reader),未命中按 email 建 Invitation(reader)。返回实际
        新增授权数(已有更高角色的幂等跳过)。best-effort:调用方(分享流程)
        捕获 DocsServiceError 降级,不阻断发卡片本身。
        """
        if not doc_id:
            raise ValueError("doc_id is required")
        if not users:
            return 0

        url = self._api_url + self.GRANT_ACCESS_PATH
        try:
            response = requests.post(
                url,
                json={"doc_id": doc_id, "users": users},
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            logger.exception("docs server unreachable: %s", url)
            raise DocsUnreachableError(str(exc)) from exc

        if response.status_code >= 500:
            raise DocsUnreachableError(
                f"docs returned {response.status_code} from {self.GRANT_ACCESS_PATH}"
            )
        if response.status_code >= 400:
            raise DocsBadResponseError(
                f"docs returned {response.status_code} from "
                f"{self.GRANT_ACCESS_PATH}: {response.text[:200]}"
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise DocsBadResponseError("response was not JSON") from exc
        granted = data.get("granted") if isinstance(data, dict) else None
        return int(granted) if isinstance(granted, int) else 0

    SESSION_TICKET_PATH = "/api/v1.0/users/session-ticket/"

    def create_session_ticket(
        self,
        *,
        sub: str,
        email: str = "",
        full_name: str = "",
        language: str = "",
    ) -> str:
        """换一张 Docs 一次性会话票据(内嵌云文档的登录态引导)。

        Docs 侧签发,60 秒 / 单次使用;客户端拿它导航到
        ``/api/v1.0/session-from-ticket/?ticket=…`` 即可换到 Docs 会话,全程不经
        Keycloak 浏览器会话 —— 这正是内嵌场景的痛点:meet 双端的登录态是 Bearer
        token,浏览器/WebView 里未必有 KC 会话 cookie,而 KC 登录页的
        ``frame-ancestors 'self'`` 会把 iframe 挡死。见 Docs 侧
        ``core/api/session_bootstrap.py``。

        ``sub`` 必须来自调用者身份,绝不接受请求参数 —— 它就是"以谁的身份登录"。
        """
        if not sub:
            raise ValueError("sub is required")

        url = self._api_url + self.SESSION_TICKET_PATH
        payload = {"sub": str(sub)}
        if email:
            payload["email"] = str(email)
        if full_name:
            payload["full_name"] = str(full_name)
        if language:
            payload["language"] = str(language)
        try:
            response = requests.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            logger.exception("docs server unreachable: %s", url)
            raise DocsUnreachableError(str(exc)) from exc

        if response.status_code >= 500:
            raise DocsUnreachableError(
                f"docs returned {response.status_code} from {self.SESSION_TICKET_PATH}"
            )
        if response.status_code >= 400:
            raise DocsBadResponseError(
                f"docs returned {response.status_code} from "
                f"{self.SESSION_TICKET_PATH}: {response.text[:200]}"
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise DocsBadResponseError("response was not JSON") from exc
        ticket = data.get("ticket") if isinstance(data, dict) else None
        if not ticket or not isinstance(ticket, str):
            raise DocsBadResponseError(f"unexpected response shape: {data}")
        return ticket

    LIST_FOR_USER_PATH = "/api/v1.0/documents/list-for-user/"

    def list_for_user(self, *, sub: str, query: str = "") -> list[DocsSearchHit]:
        """列出用户可见的文档(分享云文档到聊天入口,选择器"我的文档"列表)。

        代理 Docs 的 s2s ``list-for-user`` 端点,与 :meth:`search_for_user`
        同一可见性口径,但不要求 ``query`` 达到最短长度——用于选择器的初始
        "最近文档"列表;传了 ``query`` 则按标题过滤。
        """
        if not sub:
            raise ValueError("sub is required")

        url = self._api_url + self.LIST_FOR_USER_PATH
        params: dict[str, str] = {"sub": sub}
        if query and query.strip():
            params["q"] = query.strip()
        try:
            response = requests.get(
                url,
                params=params,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            logger.exception("docs server unreachable: %s", url)
            raise DocsUnreachableError(str(exc)) from exc

        if response.status_code >= 500:
            raise DocsUnreachableError(
                f"docs returned {response.status_code} from {self.LIST_FOR_USER_PATH}"
            )
        if response.status_code >= 400:
            raise DocsBadResponseError(
                f"docs returned {response.status_code} from "
                f"{self.LIST_FOR_USER_PATH}: {response.text[:200]}"
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise DocsBadResponseError("response was not JSON") from exc
        results = data.get("results") if isinstance(data, dict) else None
        if not isinstance(results, list):
            raise DocsBadResponseError(f"unexpected response shape: {data}")
        hits: list[DocsSearchHit] = []
        for row in results:
            if not isinstance(row, dict):
                continue
            hits.append(
                DocsSearchHit(
                    id=str(row.get("id") or ""),
                    title=str(row.get("title") or ""),
                    updated_at=str(row.get("updated_at") or ""),
                )
            )
        return hits
