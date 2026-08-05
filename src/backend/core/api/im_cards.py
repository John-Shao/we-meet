"""卡片按钮的点击与叠加层(二期 A2)。

## 为什么是叠加层

jusi 改不了已发消息的 body(全仓唯一的 ``UPDATE messages`` 是撤回的
``SET recalled_at``),而且**就算能改也不该改**:body 是机器人说的话,结果是
我们记的账。把原话改写成「已同意」等于让审计链条撒谎,jusi 的全文索引里会
存在一条谁都没发过的 body。reactions / 已读回执走的就是这个套路,是熟路。

## 三条不信客户端

1. **不信 cid。** 请求里根本没有 cid —— 服务端按 ``mid`` 查
   :class:`ImCardMessage` 拿权威 cid,再拿它去 jusi 验成员资格。
2. **不信 value。** 请求里也没有 value。发送方的私有载荷只住在服务端。
3. **不信 mid 属于哪个会话。** 同一条:cid 只从我们自己的记录里来。

第 1 条顺带解决转发副本:转发产生新 mid、没有 ``ImCardMessage`` 行 → 404。
客户端本地剥 actions 只是不让用户看到死按钮,这里才是真正的兜底。

## A2 的边界

**本地闭环,不出站。** 点击被记账、结果广播回群里,但**不会调用外部服务**
—— 那是 A3。这样投票/接龙/值班确认/通知已读这几类已经可用,而且把 ws、
叠加层、并发唯一约束这三块最易错的管道**在引入第三方依赖之前**先跑通。
"""

import json
import logging
from datetime import timedelta

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response

from core import models
from core.api.im import ImViewSet
from core.services import im_bots, im_cards
from core.services.jusi_im import JusiImServiceError

logger = logging.getLogger(__name__)

#: 一张卡的按钮活多久。一张六个月前的「同意上线」按钮是负债,不是功能。
CARD_TTL = timedelta(days=30)

#: 客户端幂等键的长度上限 —— 够放一个 uuid,又不至于被人塞进一整个 body。
MAX_CLICK_ID = 64

#: 一次最多拉多少张卡的叠加层。聊天记录翻很快,但一屏放不下这么多张卡。
MAX_STATE_MIDS = 100


def _display_name(user) -> str:
    return (getattr(user, "full_name", "") or getattr(user, "email", "") or "").strip()


class ImCardViewSet(viewsets.ViewSet):
    """``/api/v1.0/im/cards/`` —— 点击与叠加层。"""

    permission_classes = [permissions.IsAuthenticated]

    # ---- helpers ----

    def _card_or_404(self, mid: str) -> models.ImCardMessage:
        try:
            key = int(mid)
        except (TypeError, ValueError) as exc:
            raise NotFound("card not found") from exc
        card = (
            models.ImCardMessage.objects.select_related("installation__bot")
            .filter(mid=key)
            .first()
        )
        if card is None:
            # 转发副本走的就是这条:新 mid、没有记录。措辞刻意与「卡片不存在」
            # 一致,不告诉调用方「这条消息存在但不是原件」。
            raise NotFound("card not found")
        return card

    def _require_membership(self, cid: str):
        """jusi 是花名册的唯一真相 —— 与一期机器人管理走同一条校验。"""
        client = ImViewSet()._make_client()  # pylint: disable=protected-access
        me = ImViewSet._issue(  # pylint: disable=protected-access
            client, ImViewSet._external_id(self.request.user)  # noqa: SLF001
        )
        ImViewSet._require_role(  # pylint: disable=protected-access
            ImViewSet(), client, cid, me, owner_only=False
        )
        return client

    @staticmethod
    def _state_of(card: models.ImCardMessage) -> dict:
        """一张卡当前的叠加层。

        只回 ``once`` 块的定局结果 —— ``each`` 块本来就没有「状态」,谁点过
        不该展示给全群(那是行为数据,不是内容)。
        """
        resolved = {}
        for act in card.actions.filter(resolves=True):
            resolved[act.block] = {
                "button_id": act.button_id,
                "text": act.result_text,
                "at": act.created_at.isoformat(),
            }
        return {
            "mid": card.mid,
            "expired": card.expires_at <= timezone.now(),
            "resolved": resolved,
        }

    # ---- endpoints ----

    @action(detail=False, methods=["post"], url_path="states")
    def states(self, request):
        """批量拉叠加层 —— 客户端渲染一屏卡片时一次问清。

        不校验成员资格:能拿到 mid 说明消息已经在你的会话里了(jusi 才是发
        消息给你的那一方),而且这里只回结果文案,不回 value。为一屏卡片发 N
        次 jusi 成员查询,代价远大于收益。
        """
        raw = request.data.get("mids")
        if not isinstance(raw, list):
            raise ValidationError({"mids": "must be a list"})
        mids: list[int] = []
        for item in raw[:MAX_STATE_MIDS]:
            try:
                mids.append(int(item))
            except (TypeError, ValueError):
                continue
        cards = models.ImCardMessage.objects.filter(mid__in=mids).prefetch_related(
            "actions"
        )
        return Response({"states": [self._state_of(card) for card in cards]})

    @action(detail=True, methods=["post"], url_path="click")
    def click(self, request, pk=None):
        """点一个按钮。``pk`` 是 jusi 的 ``mid``。

        请求体只有 ``button_id`` 和可选的 ``click_id``。**没有 cid,没有
        value** —— 见模块头。
        """
        card = self._card_or_404(pk)
        button_id = str(request.data.get("button_id") or "").strip()
        click_id = str(request.data.get("click_id") or "").strip()[:MAX_CLICK_ID]

        definition = (card.buttons or {}).get(button_id)
        if not isinstance(definition, dict):
            raise NotFound("button not found")
        if definition.get("action") != "callback":
            # url 按钮是客户端自己开链接的,走到这里说明客户端在乱发。
            raise ValidationError({"button_id": "this button has no server action"})

        if card.expires_at <= timezone.now():
            raise ValidationError({"detail": "card expired"})

        self._require_membership(card.cid)

        # 幂等重放:同一个人带同一个 click_id 再来,返回上次的结果而不是再记
        # 一笔。与入站 webhook 的 X-Request-Id 是同一个幂等思路。
        if click_id:
            prior = card.actions.filter(user=request.user, click_id=click_id).first()
            if prior is not None:
                return Response(
                    {"replayed": True, "state": self._state_of(card)},
                    status=status.HTTP_200_OK,
                )

        resolves = definition.get("resolve") != im_cards.CARD_RESOLVE_EACH
        block = str(definition.get("block") or "a0")
        result_text = self._result_text(request.user, definition)

        try:
            with transaction.atomic():
                models.ImCardAction.objects.create(
                    card=card,
                    block=block,
                    button_id=button_id,
                    user=request.user,
                    resolves=resolves,
                    click_id=click_id,
                    result_text=result_text if resolves else "",
                )
        except (IntegrityError, DjangoValidationError):
            # 第二个人点到了同一个 once 块。**两种异常都要接**:
            #
            # * ``DjangoValidationError`` —— 常规路径。BaseModel.save() 会
            #   full_clean(),而 Django 4.1 起 full_clean 也校验 constraint,
            #   于是违反在到数据库之前就以 ValidationError 抛出来了。
            # * ``IntegrityError`` —— **真并发**。full_clean 那道是「先查再
            #   写」,两个 worker 之间必然漏;兜住的是数据库上那条部分唯一约束。
            #
            # 少接任何一种都会漏:只接 IntegrityError 常规冲突会变成 400,
            # 只接 ValidationError 真并发会变成 500。
            return Response(
                {"detail": "already resolved", "state": self._state_of(card)},
                status=status.HTTP_409_CONFLICT,
            )

        if resolves:
            self._broadcast(card, block=block, button_id=button_id, text=result_text)

        return Response({"replayed": False, "state": self._state_of(card)})

    # ---- internals ----

    @staticmethod
    def _result_text(user, definition: dict) -> str:
        """A2 的结果文案:**谁 做了什么**。

        A3 起上游可以用自己的话覆盖它(``{"text": …}``),但那条路要把上游
        响应当不可信输入处理,所以本地这条永远是兜底。
        """
        who = _display_name(user)
        label = str(definition.get("text") or "").strip()
        return f"{who} {label}".strip()[:200]

    @staticmethod
    def _broadcast(card: models.ImCardMessage, *, block: str, button_id: str, text: str):
        """把结果作为非冒泡控制消息广播回群里。

        **只有 once 块走到这里** —— 「重跑」那类被点一百次不该在 jusi 里留
        一百条控制消息。

        失败只记日志不回滚:点击已经记账了,广播是通知不是事实来源。客户端
        下次拉叠加层照样拿得到,少的只是一次实时刷新。
        """
        install = card.installation
        if install is None or install.bot is None:
            return
        body = json.dumps(
            im_cards.build_card_state(
                target_mid=card.mid, block=block, button_id=button_id, text=text
            ),
            ensure_ascii=False,
        )
        try:
            client = im_bots.make_admin_client()
            if client is None:
                return
            # 用**发这张卡的那个机器人**的身份广播,不用 SYSTEM —— 结果条要
            # 挂在卡片上,发送者不一致会让客户端的归属判断多一条特例。
            im_bots.post_as(
                client, install.bot, card.cid, body, content_type=im_cards.CARD_STATE
            )
        except JusiImServiceError:
            logger.warning(
                "card-state broadcast failed mid=%s cid=%s", card.mid, card.cid,
                exc_info=True,
            )
