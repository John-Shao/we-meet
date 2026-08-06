"""POST /api/bot/v1/hook/<token> — the public group-bot webhook."""

# pylint: disable=redefined-outer-name,unused-argument

import json
import time
from unittest import mock

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from core import models
from core.api.throttling import (
    BotWebhookBurstThrottle,
    BotWebhookIPThrottle,
    BotWebhookTokenThrottle,
)
from core.services import bot_webhook as mapping
from core.services.jusi_im import (
    JusiImBadResponseError,
    JusiImMessageResponse,
    JusiImUnreachableError,
)

pytestmark = pytest.mark.django_db

HOOK = "/api/bot/v1/hook/{token}"
TEXT_BODY = {"msg_type": "text", "content": {"text": "构建完成"}}


@pytest.fixture(autouse=True)
def _clear_cache():
    """Throttle counters and dedupe entries both live in the cache."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def bot():
    return models.ImBot.objects.create(
        kind=models.ImBotKindChoices.CUSTOM,
        name="构建通知",
        description="CI 构建结果推送",
        im_uid="01900000-0000-7000-8000-0000000000b0",
    )


@pytest.fixture
def install(bot):
    return models.ImBotInstallation.objects.create(
        bot=bot,
        cid="11111111-1111-4111-8111-111111111111",
        webhook_token="tok-happy-path",
        signing_secret="s3cret-value",
    )


@pytest.fixture
def poster():
    """Stub the whole delivery path; assert on what it was asked to send."""
    with mock.patch("core.api.bot_webhook.im_bots.make_admin_client") as factory, (
        mock.patch("core.api.bot_webhook.im_bots.post_as")
    ) as post_as:
        factory.return_value = mock.Mock()
        post_as.return_value = JusiImMessageResponse(
            mid=42,
            cid="11111111-1111-4111-8111-111111111111",
            sender_uid="01900000-0000-7000-8000-0000000000b0",
            seq=7,
            ts=1781700000,
        )
        yield post_as


def post(token, body, **extra):
    return APIClient().post(
        HOOK.format(token=token), json.dumps(body), content_type="application/json", **extra
    )


# ---- happy path --------------------------------------------------------------


def test_text_lands_in_the_conversation(install, poster):
    response = post("tok-happy-path", TEXT_BODY)
    assert response.status_code == 200
    assert response.json() == {
        "code": 0,
        "msg": "success",
        "data": {"mid": 42, "seq": 7},
    }
    _, kwargs = poster.call_args[0], poster.call_args[1]
    assert poster.call_args[0][2] == install.cid
    assert poster.call_args[0][3] == "构建完成"
    assert kwargs["content_type"] == "text"


def test_post_is_delivered_as_rich_text(install, poster):
    response = post(
        "tok-happy-path",
        {
            "msg_type": "post",
            "content": {
                "post": {
                    "zh_cn": {
                        "title": "构建失败",
                        "content": [[{"tag": "text", "text": "分支 main"}]],
                    }
                }
            },
        },
    )
    assert response.status_code == 200
    assert poster.call_args[1]["content_type"] == "rich-text"
    assert json.loads(poster.call_args[0][3])["title"] == "构建失败"


def test_usage_counters_are_recorded(install, poster):
    post("tok-happy-path", TEXT_BODY)
    install.refresh_from_db()
    assert install.message_count == 1
    assert install.last_used_at is not None


def test_trailing_slash_works_too(install, poster):
    """APPEND_SLASH would 301 a POST and drop its body, so both are registered."""
    response = APIClient().post(
        "/api/bot/v1/hook/tok-happy-path/",
        json.dumps(TEXT_BODY),
        content_type="application/json",
    )
    assert response.status_code == 200


# ---- token / state -----------------------------------------------------------


def test_unknown_token_is_rejected():
    response = post("no-such-token", TEXT_BODY)
    assert response.status_code == 400
    assert response.json()["code"] == mapping.CODE_BAD_TOKEN


def test_disabled_installation_is_rejected(install, poster):
    install.is_active = False
    install.save()
    response = post("tok-happy-path", TEXT_BODY)
    assert response.json()["code"] == mapping.CODE_BOT_DISABLED
    poster.assert_not_called()


def test_disabled_bot_identity_is_rejected(install, bot, poster):
    bot.is_active = False
    bot.save()
    assert post("tok-happy-path", TEXT_BODY).json()["code"] == mapping.CODE_BOT_DISABLED
    poster.assert_not_called()


# ---- body validation ---------------------------------------------------------


def test_non_json_body_is_rejected(install, poster):
    response = APIClient().post(
        HOOK.format(token="tok-happy-path"), "not json", content_type="application/json"
    )
    assert response.status_code == 400
    assert response.json()["code"] == mapping.CODE_BAD_BODY


def test_oversized_body_is_rejected_before_parsing(install, poster):
    response = post(
        "tok-happy-path",
        {"msg_type": "text", "content": {"text": "x" * (mapping.MAX_BODY_BYTES + 10)}},
    )
    assert response.status_code == 413
    assert response.json()["code"] == mapping.CODE_BODY_TOO_LARGE
    poster.assert_not_called()


def test_unsupported_msg_type_is_reported_not_swallowed(install, poster):
    # 用 image 而不是 interactive:后者二期 A1 起是支持的(见下面那组)。
    response = post("tok-happy-path", {"msg_type": "image", "content": {}})
    assert response.status_code == 400
    assert response.json()["code"] == mapping.CODE_BAD_MSG_TYPE
    poster.assert_not_called()


# ---- msg_type=interactive(二期 A1)--------------------------------------------


CARD_BODY = {
    "msg_type": "interactive",
    "card": {
        "header": {"title": {"content": "生产构建失败"}, "template": "red"},
        "elements": [
            {"tag": "div", "text": {"content": "分支 **main** 失败"}},
            {"tag": "img", "img_key": "img_x"},
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "text": {"content": "查看日志"},
                        "url": "https://ci.example.com/1",
                    },
                    {
                        "tag": "button",
                        "text": {"content": "同意上线"},
                        "value": {"token": "SECRET-PIPELINE-TOKEN"},
                    },
                ],
            },
        ],
    },
}


def test_interactive_card_is_delivered_as_rich_card(install, poster):
    response = post("tok-happy-path", CARD_BODY)
    assert response.status_code == 200
    assert response.json()["code"] == mapping.CODE_OK
    assert poster.call_args[1]["content_type"] == "rich-card"
    body = json.loads(poster.call_args[0][3])
    assert body["header"] == {"title": "生产构建失败", "theme": "danger"}


def test_degradations_are_reported_to_the_sender_but_not_to_the_group(install, poster):
    """warnings 进 HTTP 响应(对方的 CI 日志看得到),**不进 body**。

    群成员不该看到「你的机器人少发了一张图」——那是发送方要修的事。
    """
    response = post("tok-happy-path", CARD_BODY)
    warnings = response.json()["data"]["warnings"]
    assert "block-dropped:img" in warnings
    # 二期 A2 起 callback 按钮**能点了**(本地闭环:结果在群里显示),所以不再
    # 丢弃。但还没有出站通道,所以照样要告诉发送方 —— 否则它的流水线会一直
    # 等一个不会来的回调。
    assert "button-local-only:no-callback-url" in warnings
    assert "button-dropped:callback-not-configured" not in warnings

    assert "warning" not in poster.call_args[0][3]


def test_the_plain_projection_is_serialized_first(install, poster):
    """会话列表拿到的 ``last_message`` 是被 jusi 截断的。

    ``plain`` 排在最后时它整段落在截断点之外 —— 客户端既解析不出 JSON 又抠不到
    plain,预览只能退回「[卡片]」。真机上**每一张卡**都是这样。金标准卡片压缩后
    856 字节,而 ``"plain"`` 从第 768 位才开始。

    排到最前之后,截断的 body 仍然不是合法 JSON,所以双端还要在 parse **之前**
    抠 plain。两件事缺一不可 —— 这条只守后半件。
    """
    post("tok-happy-path", CARD_BODY)
    body = poster.call_args[0][3]
    assert body.startswith('{"plain":'), body[:60]
    # 截断点落在哪里都无所谓的前提:开头就已经是人话。
    assert "生产构建失败" in body[:80]


def test_a_configured_callback_stops_claiming_the_buttons_are_local_only(
    install, poster
):
    """配好地址之后这条 warning 必须消失。

    它只是一条 warning,但方向反了比没有更糟:对方的流水线读到
    ``button-local-only`` 会认定回调不会来,于是走「自己轮询」那条降级分支 ——
    而回调其实**发得好好的**。这条曾经恒真,因为 API 层压根没把配置传下来。
    """
    install.callback_url = "https://ci.example.com/hook"
    install.callback_enabled = True
    install.save()
    warnings = post("tok-happy-path", CARD_BODY).json()["data"]["warnings"]
    assert "button-local-only:no-callback-url" not in warnings
    # 图片那条与回调无关,不该被顺手改掉。
    assert "block-dropped:img" in warnings


def test_a_self_disabled_callback_is_local_only_again(install, poster):
    """连续失败自动停用后回调**确实**不会发,这时说 local-only 是真话。"""
    install.callback_url = "https://ci.example.com/hook"
    install.callback_enabled = False
    install.save()
    warnings = post("tok-happy-path", CARD_BODY).json()["data"]["warnings"]
    assert "button-local-only:no-callback-url" in warnings


def test_a_pipeline_token_in_a_button_never_reaches_the_group(install, poster):
    """最重要的一条不变量:body 是全群可读的,而且永久冻在 jusi 的全文索引里。"""
    post("tok-happy-path", CARD_BODY)
    assert "SECRET-PIPELINE-TOKEN" not in poster.call_args[0][3]


def test_a_card_with_nothing_left_is_rejected_rather_than_posted_blank(install, poster):
    response = post(
        "tok-happy-path",
        {"msg_type": "interactive", "card": {"elements": [{"tag": "img", "img_key": "k"}]}},
    )
    assert response.json()["code"] == mapping.CODE_EMPTY_CONTENT
    poster.assert_not_called()


def test_card_templates_are_rejected_with_their_own_code(install, poster):
    response = post(
        "tok-happy-path",
        {"msg_type": "interactive", "card": {"type": "template", "data": {"template_id": "ctp_x"}}},
    )
    assert response.json()["code"] == mapping.CODE_TEMPLATE_UNSUPPORTED
    poster.assert_not_called()


def test_a_clean_card_reports_no_warnings_key_at_all(install, poster):
    """没有降级时不要塞一个空数组 —— 对方的脚本会拿 `if warnings` 判断。"""
    response = post(
        "tok-happy-path",
        {
            "msg_type": "interactive",
            "card": {"elements": [{"tag": "div", "text": {"content": "一切正常"}}]},
        },
    )
    assert response.status_code == 200
    assert "warnings" not in response.json()["data"]


# ---- signature gate ----------------------------------------------------------


def test_signature_required_when_enabled(install, poster):
    install.sign_verify_enabled = True
    install.save()
    response = post("tok-happy-path", TEXT_BODY)
    assert response.json()["code"] == mapping.CODE_BAD_SIGN
    poster.assert_not_called()


def test_valid_signature_passes(install, poster):
    install.sign_verify_enabled = True
    install.save()
    ts = str(int(time.time()))
    body = dict(TEXT_BODY, timestamp=ts, sign=mapping.feishu_sign(ts, install.signing_secret))
    assert post("tok-happy-path", body).json()["code"] == 0


def test_stale_signature_is_rejected(install, poster):
    install.sign_verify_enabled = True
    install.save()
    ts = str(int(time.time()) - mapping.SIGN_WINDOW_SECONDS - 60)
    body = dict(TEXT_BODY, timestamp=ts, sign=mapping.feishu_sign(ts, install.signing_secret))
    assert post("tok-happy-path", body).json()["code"] == mapping.CODE_BAD_SIGN


def test_signature_gate_off_by_default(install, poster):
    assert post("tok-happy-path", TEXT_BODY).json()["code"] == 0


# ---- keyword gate ------------------------------------------------------------


def test_keyword_must_appear(install, poster):
    install.keywords = ["部署"]
    install.save()
    assert post("tok-happy-path", TEXT_BODY).json()["code"] == mapping.CODE_NO_KEYWORD
    poster.assert_not_called()


def test_matching_keyword_passes(install, poster):
    install.keywords = ["构建", "部署"]
    install.save()
    assert post("tok-happy-path", TEXT_BODY).json()["code"] == 0


def test_keywords_match_the_rendered_text_of_a_post(install, poster):
    """Not the JSON we generate — a keyword should match what a human sees."""
    install.keywords = ["构建失败"]
    install.save()
    response = post(
        "tok-happy-path",
        {
            "msg_type": "post",
            "content": {
                "post": {"zh_cn": {"title": "构建失败", "content": [[{"tag": "text", "text": "x"}]]}}
            },
        },
    )
    assert response.json()["code"] == 0


# ---- IP allowlist ------------------------------------------------------------


def test_ip_outside_the_allowlist_is_rejected(install, poster):
    install.ip_allowlist = ["10.0.0.0/8"]
    install.save()
    response = post("tok-happy-path", TEXT_BODY, HTTP_X_FORWARDED_FOR="203.0.113.9")
    assert response.json()["code"] == mapping.CODE_IP_NOT_ALLOWED
    poster.assert_not_called()


def test_ip_inside_the_allowlist_passes(install, poster):
    install.ip_allowlist = ["10.0.0.0/8"]
    install.save()
    response = post("tok-happy-path", TEXT_BODY, HTTP_X_FORWARDED_FOR="10.1.2.3")
    assert response.json()["code"] == 0


# ---- idempotency -------------------------------------------------------------


def test_explicit_request_id_is_replayed_not_reposted(install, poster):
    first = post("tok-happy-path", TEXT_BODY, HTTP_X_REQUEST_ID="req-1")
    second = post("tok-happy-path", TEXT_BODY, HTTP_X_REQUEST_ID="req-1")
    assert first.json() == second.json()
    assert poster.call_count == 1


def test_different_request_ids_post_twice(install, poster):
    post("tok-happy-path", TEXT_BODY, HTTP_X_REQUEST_ID="req-1")
    post("tok-happy-path", TEXT_BODY, HTTP_X_REQUEST_ID="req-2")
    assert poster.call_count == 2


def test_identical_body_within_the_window_is_deduped(install, poster):
    post("tok-happy-path", TEXT_BODY)
    post("tok-happy-path", TEXT_BODY)
    assert poster.call_count == 1


def test_identical_body_posts_again_once_the_window_lapses(install, poster, settings):
    """A monitor sending the same "OK" every minute is legitimate traffic —
    the body-hash window only exists to absorb HTTP retries."""
    settings.BOT_CONFIGURATION = {**settings.BOT_CONFIGURATION, "dedupe_seconds": 0}
    post("tok-happy-path", TEXT_BODY)
    post("tok-happy-path", TEXT_BODY)
    assert poster.call_count == 2


# ---- delivery failures -------------------------------------------------------


def test_missing_conversation_disables_the_installation(install):
    with mock.patch("core.api.bot_webhook.im_bots.make_admin_client") as factory, (
        mock.patch("core.api.bot_webhook.im_bots.post_as")
    ) as post_as:
        factory.return_value = mock.Mock()
        post_as.side_effect = JusiImBadResponseError("404 conversation not found")
        response = post("tok-happy-path", TEXT_BODY)
    assert response.status_code == 404
    assert response.json()["code"] == mapping.CODE_CONVERSATION_GONE
    install.refresh_from_db()
    assert install.is_active is False
    assert install.disabled_reason == "conversation_gone"


def test_unreachable_im_reports_502_and_keeps_the_installation(install):
    with mock.patch("core.api.bot_webhook.im_bots.make_admin_client") as factory, (
        mock.patch("core.api.bot_webhook.im_bots.post_as")
    ) as post_as:
        factory.return_value = mock.Mock()
        post_as.side_effect = JusiImUnreachableError("connection refused")
        response = post("tok-happy-path", TEXT_BODY)
    assert response.status_code == 502
    assert response.json()["code"] == mapping.CODE_IM_UNAVAILABLE
    install.refresh_from_db()
    assert install.is_active is True


def test_unconfigured_im_reports_502(install):
    with mock.patch("core.api.bot_webhook.im_bots.make_admin_client", return_value=None):
        response = post("tok-happy-path", TEXT_BODY)
    assert response.status_code == 502
    assert response.json()["code"] == mapping.CODE_IM_UNAVAILABLE


# ---- rate limiting -----------------------------------------------------------


def test_throttling_answers_in_the_feishu_envelope(install, poster, monkeypatch):
    """Handing a caller a different response shape exactly when it is being
    rate-limited is when it can least afford to re-parse.

    Rate patched on the class, not through ``REST_FRAMEWORK``: DRF binds
    ``SimpleRateThrottle.THROTTLE_RATES`` at import time (same reasoning as
    ``test_api_invite_links.test_resolution_is_throttled``).
    """
    monkeypatch.setattr(BotWebhookTokenThrottle, "rate", "1/minute", raising=False)
    assert post("tok-happy-path", {**TEXT_BODY, "content": {"text": "一"}}).status_code == 200
    limited = post("tok-happy-path", {**TEXT_BODY, "content": {"text": "二"}})
    assert limited.status_code == 429
    assert limited.json()["code"] == mapping.CODE_RATE_LIMITED


def test_each_bot_gets_its_own_bucket(install, bot, poster, monkeypatch):
    """One noisy webhook must not starve another group's bot."""
    monkeypatch.setattr(BotWebhookTokenThrottle, "rate", "1/minute", raising=False)
    other = models.ImBotInstallation.objects.create(
        bot=bot, cid="22222222-2222-4222-8222-222222222222", webhook_token="tok-other"
    )
    assert post("tok-happy-path", TEXT_BODY).status_code == 200
    assert post("tok-happy-path", TEXT_BODY).status_code == 429
    assert post(other.webhook_token, TEXT_BODY).status_code == 200


def test_the_throttles_have_their_own_scopes():
    """Sharing AnonRateThrottle's default bucket would couple bots to every
    other anonymous endpoint."""
    assert BotWebhookTokenThrottle.scope == "bot_webhook"
    assert BotWebhookBurstThrottle.scope == "bot_webhook_burst"
    assert BotWebhookIPThrottle.scope == "bot_webhook_ip"
