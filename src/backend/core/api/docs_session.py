"""内嵌云文档的登录态引导:给客户端一条"直接带着登录态进 Docs"的 URL。

**为什么需要它。** meet 的云文档是把 Docs 内嵌进来(web iframe / App WebView)。
原先靠 Docs 的 ``/api/v1.0/authenticate/`` 进站 —— 那是一条 OIDC 链路,拿浏览器里
的 **Keycloak 会话 cookie** 静默换 Docs 会话。但 meet 双端的登录态是 Bearer token
(手机号 OTP 直连授权),浏览器 / WebView 里未必存在 KC 会话 cookie:

* 关掉浏览器再打开,KC 的会话 cookie(非 remember-me 时不落盘)就没了,而 meet 自己
  的登录态还在 —— 于是"其它模块都登着,唯独云文档是登出的";
* 一旦没有,authenticate 就会把内嵌页甩到 Keycloak 登录页,而 KC 自带
  ``Content-Security-Policy: frame-ancestors 'self'`` —— iframe 里直接被浏览器
  拦掉(web 白屏 + CSP 报错),App 里则变成"云文档要求再登一次"。

**这里做什么。** 用已经认证过的调用者身份(session 或 Bearer 都行,谁能调这个端点
谁就是本人),去 Docs 换一张一次性票据,拼成客户端可直接导航的 URL。客户端把
iframe / WebView 指过去,Docs 校验票据、建会话、302 到目标页 —— 全程不碰 Keycloak,
云文档的登录态从此跟随 meet 自己的登录态。

Docs 侧实现见 we-meet-docs ``src/backend/core/api/session_bootstrap.py``。
"""

from __future__ import annotations

import logging
from urllib.parse import urlencode

from django.conf import settings

from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.views import APIView

from core.api import throttling

logger = logging.getLogger(__name__)

SESSION_FROM_TICKET_PATH = "/api/v1.0/session-from-ticket/"


def _safe_next(raw: object) -> str:
    """把客户端给的落地路径收敛成站内相对路径。

    只放行 ``/…`` 形式(带 query 可以),挡掉 ``//host``、``/\\host`` 和任何带
    scheme 的写法 —— 这个值会成为 Docs 那边 302 的目标,不做约束就是开放重定向。
    Docs 侧还会再校验一次(纵深防御),两边都不信对方的输入。
    """
    candidate = str(raw or "").strip()
    if (
        not candidate.startswith("/")
        or candidate.startswith("//")
        or candidate.startswith("/\\")
    ):
        return "/"
    return candidate


class DocsSessionView(APIView):
    """``POST /api/v1.0/docs/session/`` —— 换一条带登录态的云文档进站 URL。

    入参 ``{"next": "/docs/<id>/?embed=1&…"}``(可选,默认 ``/``)。返回
    ``{"url": "https://docs…/api/v1.0/session-from-ticket/?ticket=…&next=…"}``。

    Docs 未配置 / 不可达 / 调用者没有 ``sub`` 时返回 ``{"url": null}`` 而不是 5xx:
    客户端据此退回原来的 ``authenticate`` 进站方式(有 KC 会话的浏览器照样能进),
    与搜索、我的文档那两个代理端点"从源挂掉就降级、不报错"是同一套口径。
    """

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [throttling.DocsSessionRateThrottle]

    def post(self, request):
        """签发票据并拼出进站 URL。"""
        next_path = _safe_next(request.data.get("next"))

        cfg = getattr(settings, "DOCS_CONFIGURATION", None) or {}
        api_url = cfg.get("api_url") or ""
        token = cfg.get("server_to_server_token") or ""
        sub = str(getattr(request.user, "sub", "") or "")
        if not api_url or not token or not sub:
            return Response({"url": None})

        from core.services.docs_client import DocsClient, DocsServiceError

        client = DocsClient(
            api_url=str(api_url),
            server_to_server_token=str(token),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 3),
        )
        try:
            ticket = client.create_session_ticket(
                sub=sub,
                email=str(getattr(request.user, "email", "") or ""),
                full_name=str(getattr(request.user, "full_name", "") or ""),
                language=str(getattr(request.user, "language", "") or ""),
            )
        except DocsServiceError as exc:
            logger.warning("docs session bootstrap degraded: %s", exc)
            return Response({"url": None})

        base = str(api_url).rstrip("/")
        query = urlencode({"ticket": ticket, "next": next_path})
        return Response({"url": f"{base}{SESSION_FROM_TICKET_PATH}?{query}"})
