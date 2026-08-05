"""受控的出站 HTTP —— **只给群机器人的按钮回调用**(二期 A3)。

=============================================================================
这个模块存在的唯一理由是 SSRF。

「让用户填一个 URL,我们去请求它」是把服务器变成对方的代理:请求从**我们的
网络位置**发出,带着我们能到达而对方到不了的一切 —— 集群内部服务、云元数据、
数据库端口。生产实测过一次:那台机器的 `169.254.169.254` **是通的**,而且回的
不是普通 IMDS 而是一个转发网关(`{"code":-1,"message":"cluster.internal",…}`
里包着一个 Go 的 404)。也就是说一旦被绕过,能够到的不止元数据。

所以下面八条一条都不能省,而且**真正承重的是第 2/3/5 条**,不是 IP 名单。
=============================================================================

八条:

1. 只允许 https(DEBUG 下才放 http)
2. **禁止重定向** —— 一个 302 到内网能绕过任何预检
3. **先解析再钉住 IP**:自己 ``getaddrinfo``,**所有**返回地址过闸门,然后连
   **已验证的那个 IP**,Host 头和 SNI 保留域名
4. 端口白名单 443(dev 加 80),挡掉 22/6379/5432/11211 横向
5. **``trust_env=False``** —— 否则 pod 里的 ``HTTP_PROXY`` 会静默改道,
   IP 钉住全部作废。这条最容易漏
6. 写入时校验(群主当场看到报错)+ **发送时再校一次**(DNS 会变)
7. ``timeout=(3,5)``、``stream=True`` 最多读 8 KiB、只认 ``application/json``
8. 额外 denylist 走 settings —— 本部署实测 Service CIDR 是 ``10.43.0.0/16``
   (RFC1918,闸门已覆盖),所以默认空;它是「将来某个部署的自有网络用了全球
   可路由段」时的逃生舱

⚠️ **「解析一次然后 ``requests.post(url)``」等于没做。** requests 会自己再解析
一次,两次之间 DNS 可以变(DNS rebinding)。第 3 条的写法是这个模块的全部意义。
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests
from django.conf import settings

#: 允许的端口。443 之外的一切都不是「一个 webhook 地址」该有的样子。
_ALLOWED_PORTS = {443}
_DEV_EXTRA_PORTS = {80, 8000, 8080}

#: 连接 / 读取超时。对方慢不该拖住我们的 worker。
_TIMEOUT = (3, 5)

#: 上游响应最多读这么多 —— 我们只需要一个 ``{"text": …}``。
MAX_RESPONSE_BYTES = 8 * 1024


class OutboundBlocked(Exception):
    """地址不允许。``category`` 是**给用户看的分类**,不含任何上游细节。"""

    def __init__(self, category: str, detail: str = ""):
        super().__init__(detail or category)
        self.category = category
        self.detail = detail


@dataclass(frozen=True)
class OutboundResponse:
    status: int
    body: dict[str, Any]


# ---- 地址闸门 ---------------------------------------------------------------


def _extra_deny_networks() -> list[ipaddress._BaseNetwork]:
    cfg = getattr(settings, "BOT_CONFIGURATION", None) or {}
    raw = cfg.get("callback_deny_cidrs") or ""
    entries = [e.strip() for e in str(raw).split(",") if e.strip()]
    networks = []
    for entry in entries:
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            continue
    return networks


def is_blocked_address(raw: str) -> bool:
    """这个 IP 该不该被拦。

    用 ``not is_global`` **而不是 ``is_private``** —— 后者不覆盖 RFC 6598 的
    ``100.64.0.0/10``,而阿里云的元数据服务(``100.100.100.200``,吐 RAM 角色
    STS 凭证)和内网 DNS 就住在那里。``is_global`` 的实现是「不在
    ``100.64.0.0/10`` 且不是 private」,正好补上那一格。

    多播要单独加:``224.0.0.1`` 的 ``is_global`` 返回 True。
    """
    try:
        addr = ipaddress.ip_address(raw)
    except ValueError:
        return True  # 认不出的地址一律拦 —— fail closed
    if addr.version == 6 and addr.ipv4_mapped:
        # ``::ffff:169.254.169.254`` 是同一个地址换了个写法。
        addr = addr.ipv4_mapped
    if (not addr.is_global) or addr.is_multicast or addr.is_reserved:
        return True
    return any(addr in net for net in _extra_deny_networks())


def _allowed_ports() -> set[int]:
    return _ALLOWED_PORTS | _DEV_EXTRA_PORTS if settings.DEBUG else _ALLOWED_PORTS


def validate_url(url: str) -> tuple[str, str, int]:
    """校验一个回调地址,返回 ``(scheme, host, port)``。不做 DNS 解析。

    写入时调用(群主当场看到报错),发送时还会再走一遍 —— DNS 会变,写入时
    合法不代表发送时合法。
    """
    if not isinstance(url, str) or not url.strip():
        raise OutboundBlocked("empty")
    parts = urlsplit(url.strip())
    scheme = (parts.scheme or "").lower()
    if scheme not in ("https", "http"):
        raise OutboundBlocked("scheme", "only https is allowed")
    if scheme == "http" and not settings.DEBUG:
        raise OutboundBlocked("scheme", "only https is allowed")
    host = parts.hostname or ""
    if not host:
        raise OutboundBlocked("host")
    port = parts.port or (443 if scheme == "https" else 80)
    if port not in _allowed_ports():
        raise OutboundBlocked("port", f"port {port} is not allowed")
    # 直接填 IP 的也要过闸门 —— 不然 https://10.0.0.1/ 就绕过去了。
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if is_blocked_address(host):
            raise OutboundBlocked("address")
    return scheme, host, port


def resolve_and_pin(host: str, port: int) -> str:
    """解析 ``host``,**所有**返回地址都过闸门,返回其中一个已验证的 IP。

    「所有」是关键:一个域名可以同时解析出一个公网 IP 和一个内网 IP,只看第一个
    等于让对方自己挑。全部通过才算通过。
    """
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        raise OutboundBlocked("dns", str(exc)) from exc
    if not infos:
        raise OutboundBlocked("dns")
    addresses = [info[4][0] for info in infos]
    for address in addresses:
        if is_blocked_address(address):
            raise OutboundBlocked("address")
    return addresses[0]


# ---- 发送 -------------------------------------------------------------------


def post_json(url: str, payload: dict[str, Any], headers: dict[str, str]) -> OutboundResponse:
    """往一个**已校验**的地址 POST 一段 JSON。

    第 3 条(IP 钉住)的实现就在这几行:连的是 ``https://<已验证的IP>:<port>``,
    而 ``Host`` 头和 TLS 的 SNI 仍然是域名。所以 requests 不会再解析一次 ——
    **没有第二次解析,就没有 DNS rebinding 的窗口**。
    """
    scheme, host, port = validate_url(url)
    address = resolve_and_pin(host, port)

    parts = urlsplit(url)
    literal = f"[{address}]" if ":" in address else address
    pinned = urlunsplit((scheme, f"{literal}:{port}", parts.path or "/", parts.query, ""))

    session = requests.Session()
    # 这一行没有的话,pod 里一个 HTTP_PROXY 就能让上面所有校验作废。
    session.trust_env = False
    try:
        response = session.post(
            pinned,
            data=payload if isinstance(payload, (bytes, str)) else None,
            json=None if isinstance(payload, (bytes, str)) else payload,
            headers={**headers, "Host": host},
            timeout=_TIMEOUT,
            # 一个 302 到内网能绕过上面每一条检查。
            allow_redirects=False,
            stream=True,
            # SNI 用域名 —— 钉的是路由,不是身份;证书仍按域名校验。
            verify=True,
        )
    except requests.Timeout as exc:
        raise OutboundBlocked("timeout") from exc
    except requests.RequestException as exc:
        raise OutboundBlocked("unreachable", str(exc)) from exc

    try:
        if response.status_code in (301, 302, 303, 307, 308):
            raise OutboundBlocked("redirect")
        content_type = (response.headers.get("Content-Type") or "").split(";")[0].strip()
        raw = response.raw.read(MAX_RESPONSE_BYTES + 1, decode_content=True) or b""
        if len(raw) > MAX_RESPONSE_BYTES:
            raise OutboundBlocked("too_large")
        body: dict[str, Any] = {}
        if content_type == "application/json" and raw:
            try:
                import json  # noqa: PLC0415

                parsed = json.loads(raw.decode("utf-8", "replace"))
                if isinstance(parsed, dict):
                    body = parsed
            except ValueError:
                body = {}
        return OutboundResponse(status=response.status_code, body=body)
    finally:
        response.close()
        session.close()
