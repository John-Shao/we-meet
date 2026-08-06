"""出站回调任务 —— 决定「写库 / 广播 / 停用」的那一层(二期 A3)。

``tests/services/test_bot_callback.py`` 测的是纯函数(签名、假名、重试判定);
这份测的是**编排**:成功之后库里变成什么样、群里有没有收到东西、失败到阈值会
不会自愈。

这一层原先一条测试都没有,于是「上游覆盖了文案却没人看得见」可以一路上线 ——
``_succeed`` 把新文案写进了库,但结果条是**点击那一刻**广播出去的,写库改不动
它。库里对、群里错,只有重新拉一次叠加层才现形。
"""

# pylint: disable=redefined-outer-name

from datetime import timedelta
from unittest import mock

import pytest
from django.utils import timezone

from core import models
from core.factories import UserFactory
from core.services import bot_callback as signing
from core.services.outbound_http import OutboundBlocked, OutboundResponse
from core.tasks.bot_callback import deliver_card_callback

pytestmark = pytest.mark.django_db

CID = "22222222-2222-4222-8222-222222222222"
MID = 749
LOCAL_TEXT = "W009 同意上线"

BUTTONS = {
    "b0": {"text": "同意上线", "style": "primary", "action": "callback",
           "block": "a0", "resolve": "once"},
}


@pytest.fixture
def install():
    bot = models.ImBot.objects.create(
        kind=models.ImBotKindChoices.CUSTOM,
        name="构建通知",
        im_uid="01900000-0000-7000-8000-0000000000c0",
    )
    return models.ImBotInstallation.objects.create(
        bot=bot,
        cid=CID,
        webhook_token="tok-a3",
        signing_secret="s" * 10,
        callback_url="https://ci.example.com/hook",
        callback_secret="k" * 20,
    )


@pytest.fixture
def action(install):
    card = models.ImCardMessage.objects.create(
        mid=MID,
        cid=CID,
        installation=install,
        buttons=BUTTONS,
        values={"b0": {"token": "SECRET-PIPELINE-TOKEN"}},
        expires_at=timezone.now() + timedelta(days=30),
    )
    return models.ImCardAction.objects.create(
        card=card,
        block="a0",
        button_id="b0",
        user=UserFactory(),
        resolves=True,
        click_id="click-1",
        result_text=LOCAL_TEXT,
    )


def _delivered(body: dict):
    return mock.patch(
        "core.tasks.bot_callback.post_json",
        return_value=OutboundResponse(status=200, body=body),
    )


# ---- 上游覆盖结果条 -----------------------------------------------------------


def test_an_upstream_override_reaches_the_group_not_just_the_database(action):
    """**这条是这份文件存在的理由。**

    上游用 ``{"text": …}`` 改写结果条时,光写库是不够的 —— 群里那条是点击那
    一刻播出去的。不补一次广播,所有人看到的还是「W009 同意上线」,直到下次
    重新拉叠加层。一个要刷新才生效的「实时覆盖」等于没有。
    """
    with _delivered({"text": "已由 CI 接管", "state": "done"}), mock.patch(
        "core.services.card_state.broadcast"
    ) as broadcast:
        deliver_card_callback(str(action.pk))

    action.refresh_from_db()
    assert action.callback_state == "done"
    assert action.result_text == "已由 CI 接管"

    assert broadcast.call_count == 1
    assert broadcast.call_args.kwargs["text"] == "已由 CI 接管"
    # 播回**同一块**,否则结果显示在别的按钮组上。
    assert broadcast.call_args.kwargs["block"] == "a0"
    assert broadcast.call_args.kwargs["button_id"] == "b0"


@pytest.mark.parametrize(
    ("body", "why"),
    [
        ({}, "上游什么都没说"),
        ({"state": "done"}, "上游只回了状态"),
        ({"text": LOCAL_TEXT}, "上游原样回了同一句"),
        ({"text": "   "}, "压完空白就没了"),
        ({"text": 123}, "不是字符串"),
    ],
)
def test_nothing_new_means_no_second_control_message(action, body, why):
    """没改文案就别多播 —— 每一条 card-state 都是 jusi 里一条真实消息。"""
    with _delivered(body), mock.patch("core.services.card_state.broadcast") as broadcast:
        deliver_card_callback(str(action.pk))

    action.refresh_from_db()
    assert action.callback_state == "done"
    assert action.result_text == LOCAL_TEXT, why
    assert broadcast.call_count == 0, why


def test_an_each_block_never_takes_the_upstream_text(install):
    """``each`` 块(「重跑」那类)不定局,也就没有结果条可覆盖。"""
    card = models.ImCardMessage.objects.create(
        mid=MID + 1, cid=CID, installation=install, buttons=BUTTONS,
        expires_at=timezone.now() + timedelta(days=30),
    )
    action = models.ImCardAction.objects.create(
        card=card, block="a1", button_id="b2", user=UserFactory(),
        resolves=False, click_id="click-each", result_text="",
    )
    with _delivered({"text": "跑完了"}), mock.patch(
        "core.services.card_state.broadcast"
    ) as broadcast:
        deliver_card_callback(str(action.pk))

    action.refresh_from_db()
    assert action.result_text == ""
    assert broadcast.call_count == 0


# ---- 失败与自愈 ---------------------------------------------------------------


def test_a_blocked_address_is_recorded_as_a_category_and_never_retried(action, install):
    """失败只留**分类**,绝不留上游响应原文 —— 那是 SSRF 的信息回传通道。"""
    with mock.patch(
        "core.tasks.bot_callback.post_json",
        side_effect=OutboundBlocked("address", "10.0.0.5 是内网"),
    ), mock.patch("core.services.card_state.broadcast") as broadcast:
        deliver_card_callback(str(action.pk))

    action.refresh_from_db()
    install.refresh_from_db()
    assert action.callback_state == "failed"
    assert action.callback_error == "address"
    assert "10.0.0.5" not in action.callback_error
    assert install.callback_failure_count == 1
    # 回调失败**不影响群里已经发生的事**:点击已定局、结果条早就播过了。
    assert broadcast.call_count == 0


def test_the_last_straw_disables_the_callback_so_we_stop_hammering(action, install):
    """连续失败到阈值自动停用 —— 自愈,不需要 cron。"""
    models.ImBotInstallation.objects.filter(pk=install.pk).update(
        callback_failure_count=signing.MAX_CONSECUTIVE_FAILURES - 1
    )
    with mock.patch(
        "core.tasks.bot_callback.post_json", side_effect=OutboundBlocked("address")
    ):
        deliver_card_callback(str(action.pk))

    install.refresh_from_db()
    assert install.callback_failure_count == signing.MAX_CONSECUTIVE_FAILURES
    assert install.callback_enabled is False


def test_one_success_clears_the_failure_streak(action, install):
    """「连续」失败才停用。中间成功过一次,计数要归零,否则迟早误停。"""
    models.ImBotInstallation.objects.filter(pk=install.pk).update(
        callback_failure_count=signing.MAX_CONSECUTIVE_FAILURES - 1
    )
    with _delivered({}):
        deliver_card_callback(str(action.pk))

    install.refresh_from_db()
    assert install.callback_failure_count == 0
    assert install.callback_enabled is True


def test_a_disabled_callback_is_not_delivered_at_all(action, install):
    """停用之后就别再敲对方了 —— 这也是那条 local-only warning 说真话的时候。"""
    models.ImBotInstallation.objects.filter(pk=install.pk).update(callback_enabled=False)
    with mock.patch("core.tasks.bot_callback.post_json") as post:
        deliver_card_callback(str(action.pk))
    assert post.call_count == 0
