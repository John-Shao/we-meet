"""飞书 webhook payload → we-meet message mapping (pure functions, no DB)."""

import json
import time

import pytest

from core.services import bot_webhook as mapping
from core.services import im_cards


# ---- msg_type=text -----------------------------------------------------------


def test_text_passes_through():
    msg = mapping.build_message(
        {"msg_type": "text", "content": {"text": "生产环境部署完成"}}
    )
    assert msg.content_type == "text"
    assert msg.body == "生产环境部署完成"


def test_at_all_becomes_the_literal_both_clients_match():
    """The unread-mention check is a substring test for ``@所有人``."""
    msg = mapping.build_message(
        {
            "msg_type": "text",
            "content": {"text": '服务告警 <at user_id="all">所有人</at> 请处理'},
        }
    )
    assert msg.body == "服务告警 @所有人 请处理"


def test_at_person_uses_the_label_the_sender_wrote():
    """No directory lookup — a leaked URL must not become a name oracle."""
    msg = mapping.build_message(
        {
            "msg_type": "text",
            "content": {"text": '<at user_id="ou_abc123">张三</at> 看一下'},
        }
    )
    assert msg.body == "@张三 看一下"


def test_at_without_a_label_falls_back_to_the_id():
    msg = mapping.build_message(
        {"msg_type": "text", "content": {"text": '<at user_id="ou_abc"></at> hi'}}
    )
    assert msg.body == "@ou_abc hi"


def test_self_closing_at_tag_is_handled():
    msg = mapping.build_message(
        {"msg_type": "text", "content": {"text": '<at user_id="all"/> 上线了'}}
    )
    assert msg.body == "@所有人 上线了"


def test_blank_text_is_rejected_rather_than_posted():
    with pytest.raises(mapping.BotPayloadError) as exc:
        mapping.build_message({"msg_type": "text", "content": {"text": "   "}})
    assert exc.value.code == mapping.CODE_EMPTY_CONTENT


def test_overlong_text_is_rejected():
    with pytest.raises(mapping.BotPayloadError) as exc:
        mapping.build_message(
            {"msg_type": "text", "content": {"text": "x" * (mapping.MAX_TEXT_RUNES + 1)}}
        )
    assert exc.value.code == mapping.CODE_BODY_TOO_LARGE


# ---- msg_type=post -----------------------------------------------------------


def _post(block, lang="zh_cn"):
    return {"msg_type": "post", "content": {"post": {lang: block}}}


def test_post_maps_every_tag():
    msg = mapping.build_message(
        _post(
            {
                "title": "构建失败",
                "content": [
                    [
                        {"tag": "text", "text": "分支 main 构建失败 "},
                        {
                            "tag": "a",
                            "text": "查看日志",
                            "href": "https://ci.example.com/runs/1",
                        },
                    ],
                    [
                        {"tag": "at", "user_id": "all", "user_name": "所有人"},
                        {"tag": "text", "text": " 请处理"},
                    ],
                ],
            }
        )
    )
    assert msg.content_type == im_cards.RICH_TEXT
    body = json.loads(msg.body)
    assert body["v"] == 1
    assert body["title"] == "构建失败"
    assert body["content"][0][1] == {
        "tag": "a",
        "text": "查看日志",
        "href": "https://ci.example.com/runs/1",
    }
    assert body["content"][1][0] == {"tag": "at", "uid": "all", "name": "所有人"}


def test_post_plain_carries_at_everyone_so_mention_detection_still_works():
    msg = mapping.build_message(
        _post(
            {
                "title": "告警",
                "content": [[{"tag": "at", "user_id": "all", "user_name": "所有人"}]],
            }
        )
    )
    body = json.loads(msg.body)
    assert mapping.AT_EVERYONE in body["plain"]
    assert body["plain"] == msg.plain


def test_post_flattens_the_locale_envelope_preferring_chinese():
    msg = mapping.build_message(
        {
            "msg_type": "post",
            "content": {
                "post": {
                    "en_us": {"title": "Build failed", "content": [[{"tag": "text", "text": "en"}]]},
                    "zh_cn": {"title": "构建失败", "content": [[{"tag": "text", "text": "zh"}]]},
                }
            },
        }
    )
    body = json.loads(msg.body)
    assert body["title"] == "构建失败"
    assert "i18n" not in body, "one message, one language — see build_rich_text"


def test_post_falls_back_to_whatever_language_exists():
    msg = mapping.build_message(
        {
            "msg_type": "post",
            "content": {"post": {"ja_jp": {"title": "T", "content": [[{"tag": "text", "text": "x"}]]}}},
        }
    )
    assert json.loads(msg.body)["title"] == "T"


def test_image_degrades_visibly_rather_than_vanishing():
    """Bots have no upload channel, so an image_key would never resolve."""
    msg = mapping.build_message(
        _post({"title": "", "content": [[{"tag": "img", "image_key": "img_v2_abc"}]]})
    )
    body = json.loads(msg.body)
    assert body["content"][0][0] == {"tag": "text", "text": mapping.IMAGE_PLACEHOLDER}


def test_javascript_href_keeps_the_words_and_loses_the_link():
    """The webhook body is attacker-controllable; a javascript: href is XSS."""
    msg = mapping.build_message(
        _post(
            {
                "title": "",
                "content": [[{"tag": "a", "text": "点我", "href": "javascript:alert(1)"}]],
            }
        )
    )
    tag = json.loads(msg.body)["content"][0][0]
    assert tag["tag"] == "text"
    assert "点我" in tag["text"]
    assert "href" not in tag


def test_unknown_tags_are_dropped_and_empty_paragraphs_collapse():
    msg = mapping.build_message(
        _post(
            {
                "title": "标题",
                "content": [
                    [{"tag": "emotion", "emoji_type": "SMILE"}],
                    [{"tag": "text", "text": "正文"}],
                ],
            }
        )
    )
    body = json.loads(msg.body)
    assert body["content"] == [[{"tag": "text", "text": "正文"}]]


def test_post_with_nothing_renderable_is_rejected_not_posted_empty():
    with pytest.raises(mapping.BotPayloadError) as exc:
        mapping.build_message(
            _post({"title": "", "content": [[{"tag": "emotion", "emoji_type": "X"}]]})
        )
    assert exc.value.code == mapping.CODE_EMPTY_CONTENT


# ---- msg_type dispatch -------------------------------------------------------


@pytest.mark.parametrize("msg_type", ["interactive", "image", "share_chat", "nonsense"])
def test_unsupported_msg_types_say_so_instead_of_failing_silently(msg_type):
    with pytest.raises(mapping.BotPayloadError) as exc:
        mapping.build_message({"msg_type": msg_type, "content": {}})
    assert exc.value.code == mapping.CODE_BAD_MSG_TYPE
    assert "text" in exc.value.message and "post" in exc.value.message


def test_missing_msg_type_is_rejected():
    with pytest.raises(mapping.BotPayloadError) as exc:
        mapping.build_message({"content": {"text": "hi"}})
    assert exc.value.code == mapping.CODE_BAD_MSG_TYPE


# ---- signature ---------------------------------------------------------------


def test_signature_matches_feishus_algorithm():
    """key = f"{ts}\\n{secret}", data = b"" — NOT a digest over the body."""
    import base64
    import hashlib
    import hmac

    ts, secret = "1599360473", "s3cret"
    expected = base64.b64encode(
        hmac.new(f"{ts}\n{secret}".encode("utf-8"), b"", hashlib.sha256).digest()
    ).decode()
    assert mapping.feishu_sign(ts, secret) == expected


def test_valid_signature_passes():
    ts = str(int(time.time()))
    payload = {"timestamp": ts, "sign": mapping.feishu_sign(ts, "s3cret")}
    assert mapping.check_signature(payload, "s3cret") is True


def test_wrong_signature_fails():
    ts = str(int(time.time()))
    assert mapping.check_signature({"timestamp": ts, "sign": "nope"}, "s3cret") is False


def test_signature_outside_the_one_hour_window_fails():
    old = str(int(time.time()) - mapping.SIGN_WINDOW_SECONDS - 60)
    payload = {"timestamp": old, "sign": mapping.feishu_sign(old, "s3cret")}
    assert mapping.check_signature(payload, "s3cret") is False


def test_signature_without_a_secret_fails_closed():
    ts = str(int(time.time()))
    assert mapping.check_signature({"timestamp": ts, "sign": "x"}, "") is False


# ---- ip allowlist ------------------------------------------------------------


def test_empty_allowlist_is_no_gate():
    assert mapping.check_ip_allowed("203.0.113.9", []) is True


def test_allowlist_matches_plain_ip_and_cidr():
    assert mapping.check_ip_allowed("10.1.2.3", ["10.0.0.0/8"]) is True
    assert mapping.check_ip_allowed("203.0.113.9", ["203.0.113.9"]) is True
    assert mapping.check_ip_allowed("198.51.100.1", ["10.0.0.0/8"]) is False


def test_unparseable_client_ip_fails_closed_when_a_list_is_set():
    """An allowlist that quietly stops applying is worse than one that rejects."""
    assert mapping.check_ip_allowed("", ["10.0.0.0/8"]) is False
    assert mapping.check_ip_allowed("not-an-ip", ["10.0.0.0/8"]) is False


def test_a_malformed_entry_does_not_disable_the_rest_of_the_list():
    assert mapping.check_ip_allowed("10.1.2.3", ["garbage", "10.0.0.0/8"]) is True


# ---- keywords ----------------------------------------------------------------


def test_empty_keywords_is_no_gate():
    assert mapping.check_keywords("anything", []) is True


def test_any_keyword_matching_is_enough():
    assert mapping.check_keywords("构建失败了", ["部署", "构建"]) is True
    assert mapping.check_keywords("一切正常", ["部署", "构建"]) is False
