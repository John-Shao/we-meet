"""Rich IM card protocols — the one place all three are defined (P10 M1-g).

Before this module, only ``event-card`` had a server-side definition (inside
``calendar_im_notify``); ``meeting-card`` and ``doc-card`` existed solely as two
independent client implementations (Web ``features/im/components/*.ts`` and
Android ``MessageContent.kt``) with nothing keeping them in agreement.

The builders here are the **specification**. The clients still construct their
own cards where they send them — what stops the three from drifting is not this
module but the golden fixtures it generates: ``tests/fixtures/im_cards/*.json``
are committed, asserted byte-for-byte here, and parsed by the Web and Android
test suites. Changing a protocol therefore means updating a fixture, which is
visible in review, instead of silently breaking one client.

Cards are deliberately *snapshots*, not live views. A doc-card keeps the title
the document had when it was shared; a meeting-card keeps the status it had.
Only ``event-card`` is multi-kind, because the calendar pushes follow-ups when
an event moves or is cancelled.
"""

from typing import Any

# content_type values. kebab-case across all three clients.
EVENT_CARD = "event-card"
DOC_CARD = "doc-card"
MEETING_CARD = "meeting-card"

CARD_CONTENT_TYPES = (EVENT_CARD, DOC_CARD, MEETING_CARD)

#: Multi-paragraph rich text — today only group bots produce it, from 飞书's
#: ``msg_type=post``. Named for what it *is* rather than who sends it, so a
#: non-bot sender later needs no second protocol.
#:
#: Not in ``CARD_CONTENT_TYPES``: the clients render this **inside** the normal
#: bubble (inheriting reactions, read receipts, the context menu, quoting)
#: rather than as a standalone card row.
RICH_TEXT = "rich-text"

# rich-text tags. Anything else is dropped by the sender, so a client only ever
# has to know these three.
RICH_TAG_TEXT = "text"
RICH_TAG_LINK = "a"
RICH_TAG_AT = "at"

#: 块级卡片(飞书 ``msg_type=interactive`` 的规范化形态)。与 [RICH_TEXT] 一样
#: 按「它*是什么*」命名而不是按谁发的 —— 将来内置助手要发同样形状的卡片时,
#: 不需要第二套协议。
#:
#: 与 [CARD_CONTENT_TYPES] 里那三个的区别:那三个是 we-meet 自己的业务卡片
#: (日程/文档/会议),形状由业务决定;rich-card 是**通用块级布局**,形状由
#: 外部服务决定,我们只保证降级后的子集。
RICH_CARD = "rich-card"

#: 卡片按钮的点击结果(P12 非冒泡控制消息)。jusi 改不了已发消息的 body,
#: 所以按钮状态走**叠加层**:结果单独广播,客户端渲染时叠在卡片上。
#:
#: ⚠️ 这个值必须同时出现在 jusi 的 ``IM_NONBUMPING_CONTENT_TYPES`` 里
#: (已于 jusi ``e3897a5`` 落地)。漏配最贵的一处不是列表乱跳,是**每次有人
#: 点按钮,全群离线成员各收一条推送**。
CARD_STATE = "card-state"

#: rich-card 的块类型。
CARD_BLOCK_TEXT = "text"
CARD_BLOCK_FIELDS = "fields"
CARD_BLOCK_DIVIDER = "divider"
CARD_BLOCK_ACTIONS = "actions"

#: header 主题 —— **语义档,不是颜色**。协议里写 "red" 就逼三端各自拥有一个红;
#: 写 "danger" 让每端取自己主题里**已经保证过深浅对比度**的那个 token。
CARD_THEMES = ("info", "success", "warning", "danger", "neutral")

#: 一个 actions 块的解析语义:``once`` = 同意/驳回这类互斥选择,第一个人点完
#: 就定局;``each`` = 重跑这类,谁都能点、不 resolve、也不广播。
CARD_RESOLVE_ONCE = "once"
CARD_RESOLVE_EACH = "each"

# event-card kinds. Unknown values render as "created" on both clients, so
# adding one is backward compatible.
EVENT_KIND_CREATED = "created"
EVENT_KIND_TIME_CHANGED = "time_changed"
EVENT_KIND_ATTENDEES_CHANGED = "attendees_changed"
EVENT_KIND_CANCELLED = "cancelled"

EVENT_KINDS = (
    EVENT_KIND_CREATED,
    EVENT_KIND_TIME_CHANGED,
    EVENT_KIND_ATTENDEES_CHANGED,
    EVENT_KIND_CANCELLED,
)


def build_event_card(
    *,
    event_id: str,
    title: str,
    start: str,
    end: str,
    kind: str = EVENT_KIND_CREATED,
    all_day: bool = False,
    attendee_count: int = 0,
    organizer_name: str = "",
    old_start: str | None = None,
    old_end: str | None = None,
    added_count: int = 0,
    removed_count: int = 0,
) -> dict[str, Any]:
    """Calendar event card (protocol v1).

    ``title`` is the one required field on the client side — both parsers treat
    its absence as a broken card and fall back to the "unsupported" bubble.
    """
    card: dict[str, Any] = {
        "v": 1,
        "kind": kind,
        "event_id": event_id,
        "title": title,
        "start": start,
        "end": end,
        "all_day": bool(all_day),
        "attendee_count": attendee_count,
        "organizer_name": organizer_name,
    }
    # Optional keys are omitted rather than nulled: the clients branch on
    # presence, and a null would read as "changed to nothing".
    if kind == EVENT_KIND_TIME_CHANGED and old_start is not None and old_end is not None:
        card["old_start"] = old_start
        card["old_end"] = old_end
    if kind == EVENT_KIND_ATTENDEES_CHANGED and added_count:
        card["added_count"] = added_count
    if kind == EVENT_KIND_ATTENDEES_CHANGED and removed_count:
        card["removed_count"] = removed_count
    return card


def build_doc_card(
    *, doc_id: str, title: str, url: str, shared_by: str = ""
) -> dict[str, Any]:
    """Shared collaborative document card (protocol v1).

    A static snapshot: renaming or deleting the document afterwards does not
    change cards already sent.
    """
    card: dict[str, Any] = {
        "v": 1,
        "doc_id": doc_id,
        "title": title,
        "url": url,
    }
    if shared_by:
        card["shared_by"] = shared_by
    return card


def build_meeting_card(
    *,
    slug: str,
    title: str,
    status: str = "ongoing",
    room_id: str = "",
    scheduled_at: str | None = None,
) -> dict[str, Any]:
    """Shared meeting card (protocol v1).

    ``slug`` is what joining navigates by; ``room_id`` is carried by the Web
    sender only (the App shares by slug), so it may be absent.
    """
    card: dict[str, Any] = {
        "v": 1,
        "room_id": room_id,
        "slug": slug,
        "title": title,
        "status": "scheduled" if status == "scheduled" else "ongoing",
    }
    if scheduled_at:
        card["scheduled_at"] = scheduled_at
    return card


def build_rich_text(
    *,
    content: list[list[dict[str, Any]]],
    title: str = "",
    plain: str = "",
) -> dict[str, Any]:
    """Multi-paragraph rich text (protocol v1).

    ``content`` is a list of paragraphs, each a list of inline tags:

        {"tag": "text", "text": "构建失败 "}
        {"tag": "a",    "text": "查看日志", "href": "https://…"}
        {"tag": "at",   "uid": "all" | "<im uid>", "name": "所有人"}

    Deliberately **single-language**, unlike 飞书's ``post`` which carries a
    ``{zh_cn: …, en_us: …}`` envelope. One IM message should not change shape
    per reader, and honouring the envelope would mean three clients each
    reimplementing locale selection. The webhook flattens on the way in.

    ``plain`` is a derived projection that clients must never render. It exists
    so that (a) the conversation-list preview, which shows the raw body when
    nothing parses it, reads as prose rather than JSON; (b) jusi's full-text
    search — which indexes the body verbatim — finds words instead of JSON keys;
    and (c) the "@我" detection on both clients, which is a substring test
    against the body, keeps working with no client change at all.
    """
    card: dict[str, Any] = {"v": 1, "title": title, "content": content}
    if plain:
        card["plain"] = plain
    return card


def build_rich_card(
    *,
    blocks: list[dict[str, Any]],
    header: dict[str, Any] | None = None,
    plain: str = "",
) -> dict[str, Any]:
    """块级卡片(协议 v1)—— 飞书 ``msg_type=interactive`` 规范化后的形态。

    ``header`` 形如 ``{"title": "生产构建失败", "theme": "danger"}``,``theme``
    取 [CARD_THEMES] 之一(见常量处:语义档而非颜色)。缺省或认不出一律 neutral。

    ``blocks`` 是有序块列表::

        {"type": "text",    "spans": [ …内联 span,与 rich-text 同词汇… ]}
        {"type": "fields",  "items": [{"label": "环境", "value": "生产"}, …]}
        {"type": "divider"}
        {"type": "actions", "resolve": "once", "buttons": [
            {"id": "b0", "text": "同意上线", "style": "primary", "action": "callback"},
            {"id": "b1", "text": "查看日志", "style": "default",
             "action": "url", "url": "https://…"}]}

    span 词汇**复用 rich-text 那三个 tag**,只多两个可选布尔 ``b``/``i``
    (缺省省略键)——于是双端的内联渲染循环直接复用,rich-card 只新增块级布局。

    ``fields`` 渲染成两列是**客户端**的事(奇数项最后一项跨列);协议只保证顺序。

    ⚠️ **按钮的 ``value`` 永不进 body。** body 是全群可读的,外部服务塞在 value
    里的 pipeline token 不能跟着走。客户端只拿 ``id``,服务端按 id 取 value。
    这是整个回调设计里最重要的一条不变量,任何时候都不信客户端回传的 value。

    ``plain`` 与 rich-text 同义:派生投影,客户端不得渲染,撑着会话预览、
    jusi 全文搜索和 @我 检测三处。
    """
    card: dict[str, Any] = {"v": 1, "blocks": blocks}
    if header:
        card["header"] = header
    if plain:
        card["plain"] = plain
    return card
