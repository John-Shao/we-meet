"""POST /api/v1.0/im/cards/<mid>/click/ 与 states —— 卡片按钮的点击与叠加层(A2)。

这一刀最易错的三块在这里各有断言:**不信客户端**(cid/value/转发副本)、
**并发唯一约束**(once 块只能定局一次)、**幂等重放**(click_id)。
"""

# pylint: disable=redefined-outer-name,unused-argument

import json
from datetime import timedelta
from unittest import mock

import pytest
from django.core.cache import cache
from django.db import IntegrityError
from django.utils import timezone
from rest_framework.test import APIClient

from core.api import throttling

from core import models
from core.factories import UserFactory
from core.services.jusi_im import JusiImMessageResponse

pytestmark = pytest.mark.django_db

CID = "11111111-1111-4111-8111-111111111111"
MID = 717

BUTTONS = {
    "b0": {"text": "同意上线", "style": "primary", "action": "callback",
           "block": "a0", "resolve": "once"},
    "b1": {"text": "驳回", "style": "danger", "action": "callback",
           "block": "a0", "resolve": "once"},
    "b2": {"text": "重跑", "style": "default", "action": "callback",
           "block": "a1", "resolve": "each"},
    "b3": {"text": "查看日志", "style": "default", "action": "url",
           "block": "a2", "resolve": "once"},
}


@pytest.fixture
def bot():
    return models.ImBot.objects.create(
        kind=models.ImBotKindChoices.CUSTOM,
        name="构建通知",
        im_uid="01900000-0000-7000-8000-0000000000b0",
    )


@pytest.fixture
def install(bot):
    return models.ImBotInstallation.objects.create(
        bot=bot, cid=CID, webhook_token="tok-a2", signing_secret="s" * 10
    )


@pytest.fixture
def card(install):
    return models.ImCardMessage.objects.create(
        mid=MID,
        cid=CID,
        installation=install,
        buttons=BUTTONS,
        values={"b0": {"token": "SECRET-PIPELINE-TOKEN"}},
        expires_at=timezone.now() + timedelta(days=30),
    )


@pytest.fixture
def member():
    return UserFactory()


@pytest.fixture(autouse=True)
def _im(request):
    """把成员校验和 jusi 投递都打桩 —— 这组测试验的是我们自己的状态机。"""
    if "no_im_stub" in request.keywords:
        yield None
        return
    # 广播住在 services/card_state 而不是 viewset 上 —— 因为**有两个触发点**:
    # 点击那一刻,以及出站回调带回上游文案之后(见 tasks/bot_callback)。
    with mock.patch(
        "core.api.im_cards.ImCardViewSet._require_membership"
    ) as membership, mock.patch(
        "core.services.card_state.im_bots.make_admin_client"
    ) as factory, mock.patch(
        "core.services.card_state.im_bots.post_as"
    ) as post_as:
        membership.return_value = mock.Mock()
        factory.return_value = mock.Mock()
        post_as.return_value = JusiImMessageResponse(
            mid=999, cid=CID, sender_uid="bot", seq=8, ts=1781700000
        )
        yield post_as


def click(user, mid=MID, **body):
    api = APIClient()
    api.force_login(user)
    return api.post(f"/api/v1.0/im/cards/{mid}/click/", body, format="json")


# ---- 不信客户端 ---------------------------------------------------------------


def test_a_forwarded_copy_has_no_card_row_so_clicking_it_404s(card, member):
    """转发产生新 mid、没有 ImCardMessage 行。**这才是真正的兜底** ——
    客户端本地剥 actions 只是不让用户看到死按钮。"""
    assert click(member, mid=MID + 1, button_id="b0").status_code == 404


def test_the_request_carries_no_cid_at_all(card, member, _im):
    """cid 只从服务端自己的记录里来。这条测试的形式就是它的内容:请求体里
    压根没有 cid 可传。"""
    response = click(member, button_id="b0")
    assert response.status_code == 200
    # 成员校验用的是我们查出来的 cid,不是客户端说的。
    from core.api.im_cards import ImCardViewSet  # noqa: PLC0415

    assert isinstance(ImCardViewSet._require_membership, mock.Mock)


def test_the_senders_private_value_is_never_echoed_back(card, member):
    response = click(member, button_id="b0")
    assert "SECRET-PIPELINE-TOKEN" not in json.dumps(response.json())


def test_an_unknown_button_id_404s(card, member):
    assert click(member, button_id="nope").status_code == 404


def test_a_url_button_has_no_server_action(card, member):
    """url 按钮是客户端自己开链接的;打到这里说明客户端在乱发。"""
    assert click(member, button_id="b3").status_code == 400


# ---- once:互斥 ---------------------------------------------------------------


def test_the_first_click_resolves_the_block_and_broadcasts(card, member, _im):
    response = click(member, button_id="b0")
    assert response.status_code == 200
    state = response.json()["state"]
    assert state["resolved"]["a0"]["button_id"] == "b0"
    assert member.full_name in state["resolved"]["a0"]["text"]

    # 广播的是非冒泡控制消息,挂在原卡的 mid 上。
    _, kwargs = _im.call_args
    assert kwargs["content_type"] == "card-state"
    body = json.loads(_im.call_args[0][3])
    assert body["target_mid"] == MID
    assert body["block"] == "a0"


def test_a_second_person_hitting_the_same_once_block_gets_409(card, member):
    other = UserFactory()
    assert click(member, button_id="b0").status_code == 200
    response = click(other, button_id="b1")
    assert response.status_code == 409
    # 409 也带上当前状态 —— 客户端不用再拉一次就能把按钮换成结果条。
    assert response.json()["state"]["resolved"]["a0"]["button_id"] == "b0"


def test_the_mutual_exclusion_is_a_database_constraint_not_a_read_then_write(card, member):
    """「先查再写」在两个 worker 之间必然漏,所以互斥必须落在**数据库**上。

    用 bulk_create 绕开 BaseModel.save() 的 full_clean —— 否则测到的是
    Django 那道应用层检查(它也会拦,但它就是「先查再写」),证明不了真并发
    时有东西兜底。IntegrityError 只可能来自数据库。
    """
    models.ImCardAction.objects.create(
        card=card, block="a0", button_id="b0", user=member, resolves=True
    )
    with pytest.raises(IntegrityError):
        models.ImCardAction.objects.bulk_create([
            models.ImCardAction(
                card=card, block="a0", button_id="b1", user=UserFactory(), resolves=True
            )
        ])


def test_blocks_resolve_independently(card, member, _im):
    """一张卡可以既有「同意/驳回」又有「重跑」,各管各的。"""
    assert click(member, button_id="b0").status_code == 200
    # a1 是 each 块,不受 a0 已定局的影响。
    assert click(member, button_id="b2").status_code == 200


# ---- each:不 resolve、不广播 --------------------------------------------------


def test_an_each_block_never_resolves_and_never_broadcasts(card, member, _im):
    """一张卡被点一百次不该在 jusi 里留一百条控制消息。"""
    for _ in range(3):
        assert click(UserFactory(), button_id="b2").status_code == 200
    assert models.ImCardAction.objects.filter(button_id="b2").count() == 3
    assert models.ImCardAction.objects.filter(button_id="b2", resolves=True).count() == 0
    _im.assert_not_called()


def test_each_clicks_do_not_show_up_in_the_overlay(card, member):
    """谁点过「重跑」是行为数据,不是内容 —— 不展示给全群。"""
    click(member, button_id="b2")
    api = APIClient()
    api.force_login(member)
    states = api.post("/api/v1.0/im/cards/states/", {"mids": [MID]}, format="json")
    assert states.json()["states"][0]["resolved"] == {}


# ---- 幂等 ---------------------------------------------------------------------


def test_the_same_click_id_replays_instead_of_recording_twice(card, member, _im):
    first = click(member, button_id="b2", click_id="abc")
    second = click(member, button_id="b2", click_id="abc")
    assert first.json()["replayed"] is False
    assert second.json()["replayed"] is True
    assert models.ImCardAction.objects.filter(click_id="abc").count() == 1


def test_no_click_id_means_no_dedupe(card, member):
    """each 块本来就允许重复点。不传 click_id 就是明说「这是新的一次」。"""
    click(member, button_id="b2")
    click(member, button_id="b2")
    assert models.ImCardAction.objects.filter(button_id="b2").count() == 2


# ---- 过期 ---------------------------------------------------------------------


def test_an_expired_card_cannot_be_clicked(card, member):
    """一张六个月前的「同意上线」按钮是负债,不是功能。"""
    card.expires_at = timezone.now() - timedelta(seconds=1)
    card.save()
    assert click(member, button_id="b0").status_code == 400


def test_the_overlay_reports_expiry_so_clients_can_grey_the_buttons(card, member):
    card.expires_at = timezone.now() - timedelta(seconds=1)
    card.save()
    api = APIClient()
    api.force_login(member)
    states = api.post("/api/v1.0/im/cards/states/", {"mids": [MID]}, format="json")
    assert states.json()["states"][0]["expired"] is True


# ---- 广播失败不回滚 -----------------------------------------------------------


def test_a_failed_broadcast_does_not_lose_the_click(card, member, _im):
    """点击已经记账了;广播是通知不是事实来源。客户端下次拉叠加层照样拿得到。"""
    from core.services.jusi_im import JusiImUnreachableError  # noqa: PLC0415

    _im.side_effect = JusiImUnreachableError("down")
    response = click(member, button_id="b0")
    assert response.status_code == 200
    assert models.ImCardAction.objects.filter(resolves=True).count() == 1


# ---- states ------------------------------------------------------------------


def test_states_ignores_unknown_mids_rather_than_erroring(card, member):
    api = APIClient()
    api.force_login(member)
    response = api.post(
        "/api/v1.0/im/cards/states/", {"mids": [MID, 999999, "x"]}, format="json"
    )
    assert [s["mid"] for s in response.json()["states"]] == [MID]


def test_states_requires_a_list(card, member):
    api = APIClient()
    api.force_login(member)
    assert api.post("/api/v1.0/im/cards/states/", {"mids": MID}, format="json").status_code == 400


def test_anonymous_callers_are_rejected(card):
    assert APIClient().post(f"/api/v1.0/im/cards/{MID}/click/", {"button_id": "b0"}).status_code in (401, 403)


# ---- 限流:限的是我们打给第三方的量 ---------------------------------------------


def test_the_bucket_is_who_we_are_calling_not_who_is_calling(card, member):
    """**三层里最要紧的那层。**

    按点击人分桶保护不了这个场景:200 人的群里每人点一次「重跑」,每个人都在
    自己的额度内,而对方的服务器一口气吃 200 个请求 —— 我们等于替他们发起了
    一次 DoS。所以必须有一层的分桶键是「打给谁」。

    用 ``b2``(``each`` 块)是因为它**不定局** —— 换成 ``once`` 的话第二个人
    会先撞 409,根本走不到限流。而 ``each`` 恰恰也是最容易被连点的那种。
    """
    cache.clear()
    with mock.patch.object(
        throttling.CardClickInstallationThrottle, "get_rate", return_value="1/minute"
    ):
        assert click(member, button_id="b2").status_code == 200
        # 换一个人、同一张卡 —— 桶是同一个。
        assert click(UserFactory(), button_id="b2").status_code == 429


def test_one_persons_hammering_does_not_punish_the_next_person(card, member):
    """按点击人那层反过来也要成立:额度是各人各的。"""
    cache.clear()
    with mock.patch.object(
        throttling.CardClickUserThrottle, "get_rate", return_value="1/minute"
    ):
        assert click(member, button_id="b2").status_code == 200
        assert click(member, button_id="b2").status_code == 429
        assert click(UserFactory(), button_id="b2").status_code == 200


def test_an_unknown_mid_gets_no_bucket_at_all(card):
    """拿随机 mid 猛试不该能把别人的桶占满 —— 查不到就不建桶。

    那种请求马上会被 viewset 404 掉,为它记账只会变成一个攻击面。
    """
    throttle = throttling.CardClickInstallationThrottle()

    for pk in (str(MID + 999), "not-a-number", None):
        view = mock.Mock(kwargs={"pk": pk})
        assert throttle.get_cache_key(mock.Mock(), view) is None, pk

    # 真卡片有桶,而且桶键里是 **installation**,不是 mid —— 同一个机器人的
    # 两张卡必须共用一个桶,否则每发一张新卡就等于给对方开一次新额度。
    key = throttle.get_cache_key(mock.Mock(), mock.Mock(kwargs={"pk": str(MID)}))
    assert key and str(card.installation_id) in key
    assert str(MID) not in key


def test_only_click_is_throttled_states_is_not():
    """``states`` 是只读批量拉取,不产生任何出站流量 —— 限它只会拖慢翻聊天记录。"""
    from core.api.im_cards import ImCardViewSet  # noqa: PLC0415

    assert set(ImCardViewSet.click.kwargs["throttle_classes"]) == {
        throttling.CardClickUserThrottle,
        throttling.CardClickInstallationThrottle,
        throttling.CardClickInstallationBurstThrottle,
    }
    assert "throttle_classes" not in ImCardViewSet.states.kwargs
