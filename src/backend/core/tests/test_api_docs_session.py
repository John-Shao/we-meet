"""内嵌云文档的登录态引导端点(``POST /api/v1.0/docs/session/``)。

见 core/api/docs_session.py:让云文档的登录态跟随 meet 自己的登录态,而不是跟随
浏览器里那份随时会没的 Keycloak 会话 cookie。
"""

from unittest import mock

import pytest
from rest_framework.test import APIClient

from core import factories

pytestmark = pytest.mark.django_db

URL = "/api/v1.0/docs/session/"


def test_docs_session_requires_auth():
    """匿名调用拿不到票据 —— 票据就是"以谁的身份登录"。"""
    assert APIClient().post(URL, {}, format="json").status_code == 401


def test_docs_session_degrades_when_docs_not_configured(settings):
    """Docs 没接上时返回 url=null,客户端退回 authenticate 进站,不是 5xx。"""
    settings.DOCS_CONFIGURATION = {}
    client = APIClient()
    client.force_login(factories.UserFactory(sub="sub-abc"))

    resp = client.post(URL, {}, format="json")

    assert resp.status_code == 200
    assert resp.json() == {"url": None}


def test_docs_session_returns_ticket_url_with_caller_identity(settings):
    """票据以调用者身份签发,落地路径原样带上(embed/lang/theme 因此不会丢)。"""
    settings.DOCS_CONFIGURATION = {
        "api_url": "https://docs.example.com",
        "server_to_server_token": "tok",
    }
    user = factories.UserFactory(sub="sub-abc", email="a@example.com")
    client = APIClient()
    client.force_login(user)

    with mock.patch(
        "core.services.docs_client.DocsClient.create_session_ticket",
        return_value="tick-123",
    ) as spy:
        resp = client.post(
            URL, {"next": "/docs/d1/?embed=1&theme=dark"}, format="json"
        )

    assert resp.status_code == 200
    assert resp.json()["url"] == (
        "https://docs.example.com/api/v1.0/session-from-ticket/"
        "?ticket=tick-123&next=%2Fdocs%2Fd1%2F%3Fembed%3D1%26theme%3Ddark"
    )
    # sub 服务端注入 = 调用者本人,绝不来自请求参数。
    assert spy.call_args.kwargs["sub"] == "sub-abc"
    assert spy.call_args.kwargs["email"] == "a@example.com"


@pytest.mark.parametrize(
    "hostile",
    ["https://evil.test/", "//evil.test/", "/\\evil.test/", "javascript:alert(1)", ""],
)
def test_docs_session_confines_next_to_this_site(settings, hostile):
    """next 只能是站内相对路径 —— 否则这个端点就成了开放重定向。"""
    settings.DOCS_CONFIGURATION = {
        "api_url": "https://docs.example.com",
        "server_to_server_token": "tok",
    }
    client = APIClient()
    client.force_login(factories.UserFactory(sub="sub-abc"))

    with mock.patch(
        "core.services.docs_client.DocsClient.create_session_ticket",
        return_value="tick-123",
    ):
        resp = client.post(URL, {"next": hostile}, format="json")

    assert resp.json()["url"].endswith("?ticket=tick-123&next=%2F")


def test_docs_session_degrades_when_docs_unreachable(settings):
    """Docs 挂了也只降级:客户端还能退回 authenticate 那条老路。"""
    settings.DOCS_CONFIGURATION = {
        "api_url": "https://docs.example.com",
        "server_to_server_token": "tok",
    }
    client = APIClient()
    client.force_login(factories.UserFactory(sub="sub-abc"))

    from core.services.docs_client import DocsUnreachableError

    with mock.patch(
        "core.services.docs_client.DocsClient.create_session_ticket",
        side_effect=DocsUnreachableError("down"),
    ):
        resp = client.post(URL, {}, format="json")

    assert resp.status_code == 200
    assert resp.json() == {"url": None}


def test_docs_client_create_session_ticket_posts_to_docs():
    """DocsClient 那一层:s2s 头 + 只传身份字段,响应形状不对就报错。"""
    from core.services.docs_client import DocsBadResponseError, DocsClient

    client = DocsClient(api_url="https://docs.example.com", server_to_server_token="tok")

    with mock.patch("core.services.docs_client.requests.post") as post:
        post.return_value = mock.Mock(status_code=200, json=lambda: {"ticket": "t1"})
        assert client.create_session_ticket(sub="s1", email="a@b.c") == "t1"

    assert post.call_args.args[0] == (
        "https://docs.example.com/api/v1.0/users/session-ticket/"
    )
    assert post.call_args.kwargs["headers"]["Authorization"] == "Bearer tok"
    assert post.call_args.kwargs["json"] == {"sub": "s1", "email": "a@b.c"}

    with mock.patch("core.services.docs_client.requests.post") as post:
        post.return_value = mock.Mock(status_code=200, json=lambda: {})
        with pytest.raises(DocsBadResponseError):
            client.create_session_ticket(sub="s1")
