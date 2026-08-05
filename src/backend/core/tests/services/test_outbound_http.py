"""受控出站 HTTP 的地址闸门与 IP 钉住(二期 A3)。

**这份测试是这个模块存在的理由的一半。** 另一半在模块头:生产实测过那台机器
的 `169.254.169.254` 是通的,而且回的是一个能路由到 `cluster.internal` 的转发
网关 —— 被绕过的代价不止元数据泄露。

最要紧的一条是 TOCTOU:``test_the_ip_is_pinned_so_a_dns_flip_between_check_and_
connect_cannot_help`` —— 「解析一次然后 requests.post(url)」看起来做了校验,
实际一点用没有,因为 requests 会自己再解析一次。
"""

import socket
from unittest import mock

import pytest
from django.test import override_settings

from core.services import outbound_http
from core.services.outbound_http import OutboundBlocked


# ---- 地址闸门 ---------------------------------------------------------------


@pytest.mark.parametrize(
    "address",
    [
        # 阿里云元数据 + 内网 DNS。**is_private 对这三个返回 False** ——
        # 它们在 RFC 6598 的 100.64.0.0/10 里,这正是要用 not is_global 的原因。
        "100.100.100.200",
        "100.100.2.136",
        "100.64.0.1",
        # 本部署实测可达的那个转发网关。
        "169.254.169.254",
        "169.254.0.23",
        # k3s 的 Service / Pod CIDR 与节点内网。
        "10.43.0.10",
        "10.42.0.5",
        "172.16.0.4",
        "192.168.1.1",
        "127.0.0.1",
        "0.0.0.0",
        # 多播:is_global 对它返回 True,所以必须单独拦。
        "224.0.0.1",
        "239.255.255.250",
        "240.0.0.1",
        "255.255.255.255",
        # 换个写法的同一个地址。
        "::ffff:169.254.169.254",
        "::ffff:100.100.100.200",
        "::1",
        "fd00::1",
        "fe80::1",
        "ff02::1",
        # 认不出的一律拦 —— fail closed。
        "not-an-ip",
        "",
    ],
)
def test_these_addresses_are_blocked(address):
    assert outbound_http.is_blocked_address(address) is True


@pytest.mark.parametrize(
    "address",
    ["8.8.8.8", "1.1.1.1", "47.100.1.1", "140.82.121.4", "2400:3200::1", "2606:4700::1111"],
)
def test_real_public_addresses_are_allowed(address):
    assert outbound_http.is_blocked_address(address) is False


@override_settings(BOT_CONFIGURATION={"callback_deny_cidrs": "203.0.113.0/24, 8.8.8.0/24"})
def test_the_settings_denylist_is_an_escape_hatch_for_odd_deployments():
    """本部署不需要它(Service CIDR 是 10.43.0.0/16,已在 RFC1918 里),但某个
    部署的自有网络用了全球可路由段时,这是唯一的口子。"""
    assert outbound_http.is_blocked_address("8.8.8.8") is True
    assert outbound_http.is_blocked_address("1.1.1.1") is False


# ---- URL 校验 ---------------------------------------------------------------


def test_only_https_is_allowed():
    with pytest.raises(OutboundBlocked) as exc:
        outbound_http.validate_url("http://example.test/hook")
    assert exc.value.category == "scheme"


@pytest.mark.parametrize("url", ["ftp://x.test/a", "file:///etc/passwd", "gopher://x", "javascript:x"])
def test_non_http_schemes_are_rejected(url):
    with pytest.raises(OutboundBlocked):
        outbound_http.validate_url(url)


@pytest.mark.parametrize("port", [22, 6379, 5432, 11211, 9200])
def test_only_443_is_allowed_so_lateral_ports_are_closed(port):
    with pytest.raises(OutboundBlocked) as exc:
        outbound_http.validate_url(f"https://example.test:{port}/hook")
    assert exc.value.category == "port"


def test_a_literal_internal_ip_in_the_url_is_rejected_without_dns():
    """https://10.0.0.1/ 不经过 DNS,所以闸门必须也长在 URL 校验里。"""
    with pytest.raises(OutboundBlocked) as exc:
        outbound_http.validate_url("https://169.254.169.254/latest/meta-data/")
    assert exc.value.category == "address"


def test_a_public_https_url_passes():
    assert outbound_http.validate_url("https://ci.example.com/hook") == (
        "https",
        "ci.example.com",
        443,
    )


# ---- DNS 与 IP 钉住 ----------------------------------------------------------


def _addrinfo(*addresses):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, 443)) for a in addresses]


def test_every_resolved_address_must_pass_not_just_the_first():
    """一个域名可以同时解析出公网和内网地址。只看第一个 = 让对方自己挑。"""
    with mock.patch("socket.getaddrinfo", return_value=_addrinfo("93.184.216.34", "10.0.0.5")):
        with pytest.raises(OutboundBlocked) as exc:
            outbound_http.resolve_and_pin("evil.test", 443)
    assert exc.value.category == "address"


def test_a_clean_resolution_returns_a_verified_address():
    with mock.patch("socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")):
        assert outbound_http.resolve_and_pin("ci.example.com", 443) == "93.184.216.34"


def test_a_dns_failure_is_a_category_not_a_crash():
    with mock.patch("socket.getaddrinfo", side_effect=OSError("nope")):
        with pytest.raises(OutboundBlocked) as exc:
            outbound_http.resolve_and_pin("nx.test", 443)
    assert exc.value.category == "dns"


def test_the_ip_is_pinned_so_a_dns_flip_between_check_and_connect_cannot_help():
    """**这条是整个模块最重要的断言。**

    模拟 DNS rebinding:第一次解析回公网地址(过闸门),第二次回 169.254。如果
    实现是「校验完再 requests.post(url)」,requests 那次解析就会拿到第二个地址,
    校验形同虚设。正确实现连的是**已验证的那个 IP**,所以第二次解析根本不会
    发生 —— 断言的方式就是「requests 拿到的 URL 里是 IP 不是域名」。
    """
    flips = iter([_addrinfo("93.184.216.34"), _addrinfo("169.254.169.254")])
    sent = {}

    class _Resp:
        status_code = 200
        headers = {"Content-Type": "application/json"}
        raw = mock.Mock(read=mock.Mock(return_value=b"{}"))

        def close(self):
            pass

    def _post(url, **kwargs):
        sent["url"] = url
        sent["host"] = kwargs["headers"].get("Host")
        sent["redirects"] = kwargs.get("allow_redirects")
        return _Resp()

    with mock.patch("socket.getaddrinfo", side_effect=lambda *a, **k: next(flips)), mock.patch(
        "requests.Session.post", side_effect=_post
    ):
        outbound_http.post_json("https://evil.test/hook", {"a": 1}, {})

    assert "93.184.216.34" in sent["url"], "连的必须是已验证的 IP,不是域名"
    assert "evil.test" not in sent["url"]
    # Host 头保留域名 —— 钉的是路由不是身份,证书仍按域名校验。
    assert sent["host"] == "evil.test"


# ---- 发送时的其余闸门 ---------------------------------------------------------


def test_redirects_are_never_followed():
    """一个 302 到 http://169.254.169.254/ 能绕过上面每一条检查。"""
    class _Resp:
        status_code = 302
        headers = {"Location": "http://169.254.169.254/"}
        raw = mock.Mock(read=mock.Mock(return_value=b""))

        def close(self):
            pass

    with mock.patch("socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")), mock.patch(
        "requests.Session.post", return_value=_Resp()
    ) as post:
        with pytest.raises(OutboundBlocked) as exc:
            outbound_http.post_json("https://ci.example.com/hook", {}, {})
    assert exc.value.category == "redirect"
    assert post.call_args[1]["allow_redirects"] is False


def test_the_session_ignores_proxy_environment_variables():
    """pod 里一个 HTTP_PROXY 就能让 IP 钉住全部作废。这条最容易漏。"""
    captured = {}

    class _Resp:
        status_code = 200
        headers = {"Content-Type": "application/json"}
        raw = mock.Mock(read=mock.Mock(return_value=b"{}"))

        def close(self):
            pass

    def _post(self, url, **kwargs):  # noqa: ARG001
        captured["trust_env"] = self.trust_env
        return _Resp()

    with mock.patch("socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")), mock.patch(
        "requests.Session.post", autospec=True, side_effect=_post
    ):
        outbound_http.post_json("https://ci.example.com/hook", {}, {})
    assert captured["trust_env"] is False


def test_an_oversized_response_is_rejected_rather_than_buffered():
    class _Resp:
        status_code = 200
        headers = {"Content-Type": "application/json"}
        raw = mock.Mock(read=mock.Mock(return_value=b"x" * (outbound_http.MAX_RESPONSE_BYTES + 1)))

        def close(self):
            pass

    with mock.patch("socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")), mock.patch(
        "requests.Session.post", return_value=_Resp()
    ):
        with pytest.raises(OutboundBlocked) as exc:
            outbound_http.post_json("https://ci.example.com/hook", {}, {})
    assert exc.value.category == "too_large"


def test_a_non_json_response_is_read_as_empty_not_parsed():
    """只认 application/json。对方回一页 HTML 不该被我们当结构化数据读。"""
    class _Resp:
        status_code = 200
        headers = {"Content-Type": "text/html"}
        raw = mock.Mock(read=mock.Mock(return_value=b"<html>whatever</html>"))

        def close(self):
            pass

    with mock.patch("socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")), mock.patch(
        "requests.Session.post", return_value=_Resp()
    ):
        result = outbound_http.post_json("https://ci.example.com/hook", {}, {})
    assert result.body == {}
    assert result.status == 200


def test_a_timeout_is_a_category_not_a_traceback():
    import requests as requests_lib  # noqa: PLC0415

    with mock.patch("socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")), mock.patch(
        "requests.Session.post", side_effect=requests_lib.Timeout()
    ):
        with pytest.raises(OutboundBlocked) as exc:
            outbound_http.post_json("https://ci.example.com/hook", {}, {})
    assert exc.value.category == "timeout"


def test_the_denylist_setting_is_actually_wired_to_an_env_var():
    """上面那条 override_settings 测试**证明不了这个** —— 它直接塞了一个
    settings 字典,而生产里没有任何东西会去塞它。

    这条护栏是有来由的:``callback_deny_cidrs`` 一度只活在 outbound_http 的
    ``cfg.get()`` 里,settings.py 根本没有这个键,于是那个逃生口在生产上**永远
    是空的**,而测试全绿。
    """
    from django.conf import settings  # noqa: PLC0415

    assert "callback_deny_cidrs" in settings.BOT_CONFIGURATION
