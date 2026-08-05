"""飞书 ``msg_type=interactive`` → 我们的 ``rich-card``。

=============================================================================
⚠️  本模块最重要的一条不变量:**按钮的 ``value`` 永远不进 body。**

body 是全群可读的。外部服务往 value 里塞的东西(pipeline token、审批单号、
内部 ID)一旦进了 body,就等于广播给了整个群,而且永久冻在消息历史和 jusi
的全文索引里。客户端只拿 ``id``;value 由 [map_card] 单独返回,存服务端,
点击时按 id 取。

推论:**任何时候都不信客户端回传的 value。** 点击接口只收 ``mid`` +
``button_id``,其余一切从服务端自己的记录里查。
=============================================================================

## 一套管线吃两代 schema

飞书卡片 1.0 与 2.0 都收。2.0(``schema:"2.0"`` + ``body.elements`` +
按钮的 ``behaviors``)走 [_adapt_v2] reshape 成 1.0 形状,之后**共用同一套
映射**。不写第二套降级规则 —— 我们要的那个子集在 2.0 里是纯粹的结构位移,
不是语义差异,两套实现只会各自漂。

## 降级分三级,都不静默

* 单个块不支持 → 丢掉,并在 200 响应的 ``data.warnings`` 里列出(CI 日志
  看得到,消息照发)
* 所有块都被丢光 → ``11004``(空内容)
* 结构性坏 → ``11002``;卡片搭建工具模板 → ``11007``

``warnings`` **只出现在 HTTP 响应里,不进 body** —— 群成员不该看到「你的
机器人少发了一张图」。
"""

from __future__ import annotations

from typing import Any, NamedTuple

from core.services import im_cards, lark_md
from core.services.bot_webhook import (
    CODE_BAD_BODY,
    CODE_EMPTY_CONTENT,
    CODE_TEMPLATE_UNSUPPORTED,
    BotPayloadError,
)

# ---- 限额 -------------------------------------------------------------------

MAX_BLOCKS = 30
MAX_BUTTONS_PER_BLOCK = 5
MAX_FIELDS_PER_BLOCK = 20

# ---- warning 词汇(会出现在对方的 CI 日志里,别随手改字面量)-------------------

WARN_BLOCK_DROPPED = "block-dropped:{tag}"
WARN_BUTTON_CALLBACK_UNAVAILABLE = "button-dropped:callback-not-configured"
#: 按钮能点、结果会在群里显示,但**不会回调你的服务**。A2 阶段(还没有出站
#: 通道)恒发这条 —— 对方的 CI 日志里看得到,免得它一直等一个不会来的回调。
WARN_BUTTON_LOCAL_ONLY = "button-local-only:no-callback-url"
WARN_BUTTON_NO_ACTION = "button-dropped:no-url-or-value"
WARN_BUTTONS_TRUNCATED = "buttons-truncated"
WARN_BLOCKS_TRUNCATED = "blocks-truncated"
WARN_FIELDS_TRUNCATED = "fields-truncated"

# ---- 主题:12 档 template → 5 档语义 ------------------------------------------

_THEME_BY_TEMPLATE = {
    "blue": "info",
    "wathet": "info",
    "indigo": "info",
    "violet": "info",
    "purple": "info",
    "green": "success",
    "turquoise": "success",
    "yellow": "warning",
    "orange": "warning",
    "red": "danger",
    "carmine": "danger",
    "grey": "neutral",
    "default": "neutral",
}

_BUTTON_STYLES = {"default", "primary", "danger"}


class MappedCard(NamedTuple):
    """[map_card] 的产物。"""

    #: 下发给客户端的 body(已是 [im_cards.build_rich_card] 的形状)。
    body: dict[str, Any]
    #: 降级说明,进 HTTP 响应的 ``data.warnings``,**不进 body**。
    warnings: list[str]
    #: ``button_id`` → 发送方给的 value。**只存服务端**,见文件头。
    button_values: dict[str, Any]


# ---- 入口 -------------------------------------------------------------------


def map_card(
    payload: Any, *, allow_callback: bool, callback_configured: bool = False
) -> MappedCard:
    """``interactive`` 载荷 → rich-card。失败抛 :class:`BotPayloadError`。

    两个开关是**两件事**,别合并:

    * ``allow_callback`` —— 要不要渲染「点了要回调」的按钮。False 时它们被
      **丢弃并 warning**,而不是变成一个点了没反应的死按钮。
    * ``callback_configured`` —— 群主配没配出站地址。False 但仍 allow 时,
      按钮能点、结果会在群里显示,只是**不会回调对方的服务** —— 这也要
      warning,否则对方的流水线会一直等一个不会来的回调。
    """
    if not isinstance(payload, dict):
        raise BotPayloadError(CODE_BAD_BODY, "invalid request body")
    card = payload.get("card")
    if not isinstance(card, dict):
        raise BotPayloadError(CODE_BAD_BODY, "content.card must be an object")

    if str(card.get("type") or "").strip().lower() == "template":
        raise BotPayloadError(
            CODE_TEMPLATE_UNSUPPORTED,
            "card templates (template_id) are not supported — send the card body inline",
        )

    if str(card.get("schema") or "").strip().startswith("2."):
        card = _adapt_v2(card)

    warnings: list[str] = []
    values: dict[str, Any] = {}
    counter = _Counter()

    header = _map_header(card.get("header"))
    blocks: list[dict[str, Any]] = []
    elements = card.get("elements")
    if elements is not None and not isinstance(elements, list):
        raise BotPayloadError(CODE_BAD_BODY, "card.elements must be a list")

    for element in elements or []:
        if len(blocks) >= MAX_BLOCKS:
            if WARN_BLOCKS_TRUNCATED not in warnings:
                warnings.append(WARN_BLOCKS_TRUNCATED)
            break
        block = _map_element(
            element,
            warnings=warnings,
            values=values,
            counter=counter,
            allow_callback=allow_callback,
        )
        if block:
            blocks.append(block)

    if not blocks and not header:
        raise BotPayloadError(CODE_EMPTY_CONTENT, "empty content")

    if values and not callback_configured:
        _warn(warnings, WARN_BUTTON_LOCAL_ONLY)

    plain = card_plain(header, blocks)
    body = im_cards.build_rich_card(blocks=blocks, header=header, plain=plain)
    return MappedCard(body=body, warnings=warnings, button_values=values)


class _Counter:
    """卡片内的按钮序号 —— id 全卡唯一,跨 actions 块也不重复。"""

    def __init__(self) -> None:
        self.n = 0

    def next_id(self) -> str:
        self.n += 1
        return f"b{self.n - 1}"


# ---- 2.0 → 1.0 --------------------------------------------------------------


def _adapt_v2(card: dict[str, Any]) -> dict[str, Any]:
    """卡片 2.0 reshape 成 1.0 形状。**纯结构位移,不做语义决定。**

    2.0 把元素挪进了 ``body.elements``,按钮的动作从 ``url``/``value`` 两个
    平铺字段改成了 ``behaviors`` 数组。除此之外我们关心的那些块形状一致。
    """
    body = card.get("body")
    elements = body.get("elements") if isinstance(body, dict) else None
    adapted: dict[str, Any] = {
        "header": card.get("header"),
        "elements": elements if isinstance(elements, list) else [],
    }
    for element in adapted["elements"]:
        if not isinstance(element, dict):
            continue
        for button in _iter_buttons(element):
            _flatten_behaviors(button)
    return adapted


def _iter_buttons(element: dict[str, Any]):
    """一个 2.0 元素里所有 button —— 可能直接是 button,也可能包在 actions 里。"""
    if str(element.get("tag") or "").lower() == "button":
        yield element
        return
    for action in element.get("actions") or []:
        if isinstance(action, dict):
            yield action


def _flatten_behaviors(button: dict[str, Any]) -> None:
    for behavior in button.get("behaviors") or []:
        if not isinstance(behavior, dict):
            continue
        kind = str(behavior.get("type") or "").lower()
        if kind == "open_url":
            url = behavior.get("default_url") or behavior.get("url")
            if isinstance(url, str) and url:
                button.setdefault("url", url)
        elif kind == "callback":
            if "value" in behavior:
                button.setdefault("value", behavior.get("value"))


# ---- header -----------------------------------------------------------------


def _map_header(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    title = _plain_text_of(raw.get("title"))
    if not title:
        return None
    template = str(raw.get("template") or "").strip().lower()
    return {"title": title, "theme": _THEME_BY_TEMPLATE.get(template, "neutral")}


def _plain_text_of(node: Any) -> str:
    """飞书的 ``{"tag":"plain_text","content":"…"}`` 包装 → 裸字符串。"""
    if isinstance(node, str):
        return node.strip()
    if isinstance(node, dict):
        content = node.get("content")
        if isinstance(content, str):
            return content.strip()
    return ""


# ---- 元素 → 块 --------------------------------------------------------------


def _map_element(
    element: Any,
    *,
    warnings: list[str],
    values: dict[str, Any],
    counter: _Counter,
    allow_callback: bool,
) -> dict[str, Any] | None:
    if not isinstance(element, dict):
        return None
    tag = str(element.get("tag") or "").strip().lower()

    if tag == "hr":
        return {"type": im_cards.CARD_BLOCK_DIVIDER}

    if tag in ("div", "markdown"):
        # fields 优先:一个 div 同时带 text 和 fields 时,飞书渲染的是 fields。
        fields = element.get("fields")
        if isinstance(fields, list) and fields:
            return _map_fields(fields, warnings=warnings)
        spans = _spans_of(element, warnings)
        return {"type": im_cards.CARD_BLOCK_TEXT, "spans": spans} if spans else None

    if tag in ("column_set", "columns"):
        # 2.0 用 column_set 表达「标签/值」两列。当 fields 处理。
        return _map_columns(element, warnings=warnings)

    if tag == "action":
        return _map_actions(
            element,
            warnings=warnings,
            values=values,
            counter=counter,
            allow_callback=allow_callback,
        )

    # note / img / select_static / date_picker / form / … —— 丢掉但不静默。
    _warn(warnings, WARN_BLOCK_DROPPED.format(tag=tag or "unknown"))
    return None


def _spans_of(element: dict[str, Any], warnings: list[str]) -> list[dict[str, Any]]:
    """``div.text`` / ``markdown.content`` → span 数组。"""
    node = element.get("text")
    raw = ""
    if isinstance(node, dict):
        raw = str(node.get("content") or "")
    elif isinstance(node, str):
        raw = node
    if not raw:
        raw = str(element.get("content") or "")
    return lark_md.parse(raw, warnings=warnings) if raw else []


def _map_fields(fields: list[Any], *, warnings: list[str]) -> dict[str, Any] | None:
    items: list[dict[str, str]] = []
    for field in fields:
        if len(items) >= MAX_FIELDS_PER_BLOCK:
            _warn(warnings, WARN_FIELDS_TRUNCATED)
            break
        if not isinstance(field, dict):
            continue
        raw = field.get("text")
        text = raw.get("content") if isinstance(raw, dict) else raw
        if not isinstance(text, str) or not text.strip():
            continue
        item = _split_label_value(text, warnings)
        if item:
            items.append(item)
    return {"type": im_cards.CARD_BLOCK_FIELDS, "items": items} if items else None


def _split_label_value(text: str, warnings: list[str]) -> dict[str, str] | None:
    """飞书的 field 惯例是 ``**标签**\\n值``。

    拆成结构化的 label/value,而不是把两行原样丢给客户端 —— 否则三端各写一遍
    「第一行当标签」的规矩,迟早不一致。没有换行时整段当 value、label 留空。
    """
    plain = lark_md.spans_plain(lark_md.parse(text, warnings=warnings)).strip()
    if not plain:
        return None
    head, sep, tail = plain.partition("\n")
    if not sep:
        return {"label": "", "value": plain}
    return {"label": head.strip(), "value": tail.strip()}


def _map_columns(element: dict[str, Any], *, warnings: list[str]) -> dict[str, Any] | None:
    """2.0 的 ``column_set`` → fields。每一列取它的纯文本。"""
    items: list[dict[str, str]] = []
    for column in element.get("columns") or []:
        if not isinstance(column, dict):
            continue
        texts: list[str] = []
        for child in column.get("elements") or []:
            if isinstance(child, dict):
                spans = _spans_of(child, warnings)
                piece = lark_md.spans_plain(spans).strip()
                if piece:
                    texts.append(piece)
        if not texts:
            continue
        item = _split_label_value("\n".join(texts), warnings)
        if item:
            items.append(item)
    return {"type": im_cards.CARD_BLOCK_FIELDS, "items": items} if items else None


def _map_actions(
    element: dict[str, Any],
    *,
    warnings: list[str],
    values: dict[str, Any],
    counter: _Counter,
    allow_callback: bool,
) -> dict[str, Any] | None:
    buttons: list[dict[str, Any]] = []
    for action in element.get("actions") or []:
        if len(buttons) >= MAX_BUTTONS_PER_BLOCK:
            _warn(warnings, WARN_BUTTONS_TRUNCATED)
            break
        if not isinstance(action, dict):
            continue
        if str(action.get("tag") or "").strip().lower() != "button":
            # select_static / date_picker / overflow —— 交互组件我们不支持。
            _warn(warnings, WARN_BLOCK_DROPPED.format(tag=str(action.get("tag") or "unknown")))
            continue
        button = _map_button(
            action,
            values=values,
            counter=counter,
            allow_callback=allow_callback,
            warnings=warnings,
        )
        if button:
            buttons.append(button)

    if not buttons:
        return None
    return {
        "type": im_cards.CARD_BLOCK_ACTIONS,
        # 飞书没有这个概念,所以由我们定。A1 阶段没有 callback 按钮,这个字段
        # 是惰性的;写进协议是为了客户端一次到位,A2 起才真正生效。
        "resolve": im_cards.CARD_RESOLVE_ONCE,
        "buttons": buttons,
    }


def _map_button(
    action: dict[str, Any],
    *,
    values: dict[str, Any],
    counter: _Counter,
    allow_callback: bool,
    warnings: list[str],
) -> dict[str, Any] | None:
    text = _plain_text_of(action.get("text"))
    if not text:
        return None

    style = str(action.get("type") or "").strip().lower()
    if style not in _BUTTON_STYLES:
        style = "default"

    url = action.get("url")
    if not isinstance(url, str) or not url:
        multi = action.get("multi_url")
        url = multi.get("url") if isinstance(multi, dict) else None

    button_id = counter.next_id()

    if isinstance(url, str) and lark_md._is_web_url(url):
        return {"id": button_id, "text": text, "style": style, "action": "url", "url": url}

    if "value" in action:
        if not allow_callback:
            # 渲染一个点了没反应的按钮比不渲染更糟 —— 用户会一直点。
            _warn(warnings, WARN_BUTTON_CALLBACK_UNAVAILABLE)
            counter.n -= 1  # 这个 id 没用上,还给下一个按钮
            return None
        values[button_id] = action.get("value")
        return {"id": button_id, "text": text, "style": style, "action": "callback"}

    _warn(warnings, WARN_BUTTON_NO_ACTION)
    counter.n -= 1
    return None


def _warn(warnings: list[str], message: str) -> None:
    if message not in warnings:
        warnings.append(message)


# ---- plain 投影 -------------------------------------------------------------


def card_plain(header: dict[str, Any] | None, blocks: list[dict[str, Any]]) -> str:
    """卡片 → 纯文本。撑着会话预览、jusi 全文搜索、@我 检测,以及关键词闸门。

    **按钮标签不进 plain**:它们是可点的控件不是话,进了预览会读成
    「构建失败 同意上线 查看日志」,像是机器人在念按钮。
    """
    lines: list[str] = []
    if header and header.get("title"):
        lines.append(str(header["title"]))
    for block in blocks:
        kind = block.get("type")
        if kind == im_cards.CARD_BLOCK_TEXT:
            piece = lark_md.spans_plain(block.get("spans") or []).strip()
            if piece:
                lines.append(piece)
        elif kind == im_cards.CARD_BLOCK_FIELDS:
            for item in block.get("items") or []:
                piece = " ".join(x for x in (item.get("label"), item.get("value")) if x)
                if piece:
                    lines.append(piece)
    return " ".join(lines).strip()


# ---- 按钮定义的服务端投影 ----------------------------------------------------


def card_button_defs(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """从已规范化的 body 派生 ``button_id`` → 定义,存进 ``ImCardMessage``。

    从 body 派生而不是让 [map_card] 多返回一份:**一个来源**。body 是客户端
    看到的东西,按钮定义就该是它的投影,不该有第二条真相。

    ``block`` 是 actions 块的序号(``a0``/``a1``…),``once`` 的互斥范围是**块**
    不是整张卡 —— 一张卡可以既有「同意/驳回」又有「重跑」,各管各的。
    """
    defs: dict[str, dict[str, Any]] = {}
    block_index = 0
    for block in body.get("blocks") or []:
        if not isinstance(block, dict) or block.get("type") != im_cards.CARD_BLOCK_ACTIONS:
            continue
        key = f"a{block_index}"
        block_index += 1
        resolve = block.get("resolve") or im_cards.CARD_RESOLVE_ONCE
        for button in block.get("buttons") or []:
            if not isinstance(button, dict):
                continue
            button_id = button.get("id")
            if not button_id:
                continue
            defs[str(button_id)] = {
                "text": button.get("text") or "",
                "style": button.get("style") or "default",
                "action": button.get("action") or "",
                "block": key,
                "resolve": resolve,
            }
    return defs
