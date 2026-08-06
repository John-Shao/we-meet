"""出站回调的签名、载荷与重试口径(二期 A3)。

传输层的 SSRF 防护在 ``test_outbound_http``;这里只验**说什么**和**怎么签**。
"""

import json
from unittest import mock

import pytest

from core.services import bot_callback


class _Install:
    callback_secret = "callback-secret-value"
    callback_include_identity = False


class _Card:
    cid = "11111111-1111-4111-8111-111111111111"
    mid = 717
    values = {"b0": {"token": "SECRET-PIPELINE-TOKEN", "run": 42}}


class _Action:
    button_id = "b0"
    user_id = "00000000-0000-4000-8000-000000000001"


BUTTON = {"text": "同意上线", "style": "primary", "action": "callback"}


def _payload(**overrides):
    install = _Install()
    for key, value in overrides.items():
        setattr(install, key, value)
    return bot_callback.build_payload(
        install=install,
        card=_Card(),
        action=_Action(),
        button_def=BUTTON,
        display_name="张三",
    )


# ---- 签名 ---------------------------------------------------------------------


def test_the_outbound_signature_is_not_the_inbound_one():
    """入站是飞书的 ``key=f"{ts}\\n{secret}"`` + 空 data;出站是我们自己的
    ``key=secret`` + ``data=v1:{ts}:{body}``。共用一把密钥或一套算法的话,任何
    能看到入站密钥的人都能伪造我们的出站调用。"""
    from core.services.bot_webhook import feishu_sign  # noqa: PLC0415

    ts, secret, body = "1781700000", "s3cret", '{"a":1}'
    assert bot_callback.sign(secret, ts, body) != feishu_sign(ts, secret)
    # 出站是 hex 不是 base64 —— 长度就能看出来。
    assert len(bot_callback.sign(secret, ts, body)) == 64


def test_the_signature_covers_the_exact_bytes_that_get_sent():
    """签的是 raw body。调用方必须原样发出去,不能重新序列化一遍。"""
    install = _Install()
    payload = _payload()
    raw, headers = bot_callback.build_request(install, payload)
    expected = bot_callback.sign(
        install.callback_secret, headers[bot_callback.TIMESTAMP_HEADER], raw
    )
    assert headers[bot_callback.SIGNATURE_HEADER] == expected
    assert json.loads(raw) == payload


def test_we_say_who_we_are_rather_than_which_http_library_we_use():
    """接收方拿 UA 做识别、过滤和日志分组。

    默认的 ``python-requests/x.y.z`` 既认不出是谁,还会在升级依赖时无声地变 ——
    对方按 UA 配的规则那天就失效了,而两边都不会有任何报错。
    """
    _, headers = bot_callback.build_request(_Install(), _payload())
    assert headers["User-Agent"] == "WeMeet-Bot-Callback/1"
    assert "requests" not in headers["User-Agent"]


def test_the_headers_are_outside_the_signature_so_ua_changes_break_nothing():
    """签名只覆盖 body。加一个头不该让对方的验签失败 —— 这条守着「以后还能往
    headers 里加东西」这件事。"""
    install = _Install()
    raw, headers = bot_callback.build_request(install, _payload())
    assert headers[bot_callback.SIGNATURE_HEADER] == bot_callback.sign(
        install.callback_secret, headers[bot_callback.TIMESTAMP_HEADER], raw
    )
    assert "User-Agent" not in raw


def test_changing_one_byte_changes_the_signature():
    install = _Install()
    raw, headers = bot_callback.build_request(install, _payload())
    tampered = raw.replace("717", "718")
    assert bot_callback.sign(
        install.callback_secret, headers[bot_callback.TIMESTAMP_HEADER], tampered
    ) != headers[bot_callback.SIGNATURE_HEADER]


# ---- 点击人身份 ---------------------------------------------------------------


def test_the_actor_id_is_a_per_installation_pseudonym_not_our_pk():
    payload = _payload()
    assert payload["actor"]["id"] != _Action.user_id
    assert _Action.user_id not in json.dumps(payload)
    assert len(payload["actor"]["id"]) == 32


def test_two_installations_cannot_correlate_the_same_person():
    """假名按 callback_secret 派生,所以跨安装不可关联。"""
    a = bot_callback.actor_pseudonym("secret-a", "user-1")
    b = bot_callback.actor_pseudonym("secret-b", "user-1")
    assert a != b


def test_rotating_the_secret_changes_the_pseudonym_and_that_is_the_point():
    """轮换 = 断掉外部积累的行为画像。这是特性不是 bug。"""
    before = bot_callback.actor_pseudonym("old", "user-1")
    after = bot_callback.actor_pseudonym("new", "user-1")
    assert before != after


def test_the_same_person_is_stable_within_one_installation():
    """外部服务仍要能做幂等和限流。"""
    assert bot_callback.actor_pseudonym("s", "u") == bot_callback.actor_pseudonym("s", "u")


def test_the_clickers_name_is_off_by_default():
    """webhook 是群主配的,但点按钮的是每个成员 —— 默认外发他们的姓名,是群主
    替别人做的决定。"""
    assert "display_name" not in _payload()["actor"]


def test_the_owner_can_turn_the_name_on():
    payload = _payload(callback_include_identity=True)
    assert payload["actor"]["display_name"] == "张三"


# ---- 载荷边界 -----------------------------------------------------------------


def test_the_senders_own_value_comes_back_to_them():
    """这正是 value 存在的意义 —— 只是它从来没经过群里。"""
    assert _payload()["button"]["value"]["token"] == "SECRET-PIPELINE-TOKEN"


def test_the_payload_carries_no_message_body_and_no_roster():
    serialized = json.dumps(_payload(), ensure_ascii=False)
    for forbidden in ("blocks", "spans", "members", "plain"):
        assert forbidden not in serialized


# ---- 上游响应当不可信输入 -------------------------------------------------------


def test_upstream_text_is_squeezed_and_truncated():
    """这是唯一会把上游内容显示给群里所有人的地方。"""
    assert bot_callback.clean_upstream_text("  已  \n 同意 ") == "已 同意"
    assert len(bot_callback.clean_upstream_text("x" * 500)) == bot_callback.MAX_UPSTREAM_TEXT


@pytest.mark.parametrize("value", [None, 123, {"a": 1}, ["x"], True])
def test_a_non_string_upstream_text_is_ignored(value):
    assert bot_callback.clean_upstream_text(value) == ""


def test_upstream_markdown_is_not_interpreted_just_carried_as_text():
    """上游想在群里放一个可点的链接,得走别的路。"""
    out = bot_callback.clean_upstream_text("[点我](https://evil.test)")
    assert out == "[点我](https://evil.test)"


# ---- 重试口径 -----------------------------------------------------------------


@pytest.mark.parametrize("category", ["timeout", "unreachable"])
def test_transient_failures_retry(category):
    assert bot_callback.should_retry(category=category) is True


@pytest.mark.parametrize("category", ["address", "redirect", "scheme", "port", "too_large"])
def test_address_failures_never_retry(category):
    """地址不会因为多试一次就变合法。"""
    assert bot_callback.should_retry(category=category) is False


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_upstream_5xx_and_429_retry(status):
    assert bot_callback.should_retry(status=status) is True


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 422])
def test_4xx_never_retries_because_the_refusal_is_the_answer(status):
    assert bot_callback.should_retry(status=status) is False
