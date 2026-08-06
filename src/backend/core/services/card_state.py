"""把一次按钮解析的结果广播回群里(二期 A2/A3)。

单独一个模块是因为**有两个触发点**,而它们分属不同的层:

1. 点击那一刻(``api/im_cards``)—— 本地文案「W009 同意上线」,必须立刻发出去,
   群成员的 UI 不该等一个第三方服务;
2. 出站回调带回上游文案之后(``tasks/bot_callback``)—— 上游用 ``{"text": …}``
   把结果条改写成自己的话。

第 2 处曾经漏掉:``_succeed`` 只把新文案写进库,没有再播一次。于是 DB 里确实
是「已由 CI 接管」,群里所有人看到的却还是「W009 同意上线」,**直到下次重新拉
叠加层**。一个要刷新才生效的「实时覆盖」等于没有。

放在 services 而不是留在 viewset 上:Celery 任务不该去 import 一个 viewset 的
私有静态方法。
"""

import json
import logging

from core.services import im_bots, im_cards
from core.services.jusi_im import JusiImServiceError

logger = logging.getLogger(__name__)


def broadcast(card, *, block: str, button_id: str, text: str) -> None:
    """把结果作为非冒泡控制消息广播回群里。

    **只有 once 块走到这里** —— 「重跑」那类被点一百次不该在 jusi 里留一百条
    控制消息。

    失败只记日志不抛:点击已经记账了,广播是通知不是事实来源。客户端下次拉
    叠加层照样拿得到,少的只是一次实时刷新。
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
        # 用**发这张卡的那个机器人**的身份广播,不用 SYSTEM —— 结果条要挂在
        # 卡片上,发送者不一致会让客户端的归属判断多一条特例。
        im_bots.post_as(
            client, install.bot, card.cid, body, content_type=im_cards.CARD_STATE
        )
    except JusiImServiceError:
        logger.warning(
            "card-state broadcast failed mid=%s cid=%s", card.mid, card.cid,
            exc_info=True,
        )
