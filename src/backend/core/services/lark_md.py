"""飞书 ``lark_md`` → 我们的内联 span 数组。

**为什么在服务端解析成结构,而不是把 markdown 字符串下发给客户端**,按重要性:

1. webhook 正文是**外部可控**的。下发 markdown 会逼三端各写一个渲染器,而
   Web 那边迟早会出现 ``dangerouslySetInnerHTML`` —— 这跟 ``richText.ts`` 里
   ``isWebUrl`` 上面那条注释是同一个判断,不该原地推翻。
2. 三份 markdown 方言实现必然漂。fixture 能逐字节比 span 数组,比不了
   「Android 的斜体正则跟 Web 是否一致」。
3. ``plain`` 投影要有唯一口径。

span 词汇**复用 rich-text 那三个 tag**(``text`` / ``a`` / ``at``),只多两个
可选布尔 ``b`` / ``i``(缺省省略键)。于是现有 rich-text fixture 一个字节都不用
改,双端的内联渲染循环直接复用。

支持的子集(飞书 lark_md 的常用部分):

    **粗体**  *斜体*  [文字](https://…)
    <at id=all></at>  <at id=ou_xxx>名字</at>
    <a href='https://…'>文字</a>
    <font color='red'>文字</font>   →  降级成纯文本 + warning

``<font>`` 刻意不支持:双端都有深色模式,外部服务钦定的硬编码色我们保证不了
对比度。降级不静默,warning 会出现在 webhook 的 200 响应里。
"""

from __future__ import annotations

import re
from typing import Any

#: 一次扫描就能切出来的「块状」记号。顺序即优先级:HTML 形态在前,markdown
#: 链接在后 —— ``<a href='...'>[x](y)</a>`` 这种嵌套按外层算。
_TOKEN_RE = re.compile(
    r"""
      (?P<at><at\s+id=(?P<atq>['"]?)(?P<at_id>[^'">\s]+)(?P=atq)\s*>(?P<at_label>.*?)</at>)
    | (?P<at_void><at\s+id=(?P<atq2>['"]?)(?P<at_id2>[^'">\s]+)(?P=atq2)\s*/?>)
    | (?P<a><a\s+href=(?P<aq>['"]?)(?P<a_href>[^'">\s]+)(?P=aq)[^>]*>(?P<a_text>.*?)</a>)
    | (?P<font><font\b[^>]*>(?P<font_text>.*?)</font>)
    # href 允许一层配对括号:合法 URL 里就有(维基百科的 Foo_(bar))。写成
    # [^)\s]+ 会把它截断成坏链接,顺带在正文里留下一个裸右括号。
    | (?P<mdlink>\[(?P<md_text>[^\]\n]*)\]\((?P<md_href>(?:[^()\s]|\([^()\s]*\))+)\))
    """,
    re.VERBOSE | re.DOTALL | re.IGNORECASE,
)

#: 强调。``**`` 必须排在 ``*`` 前面,否则粗体会被当成两个空斜体。
_EMPH_RE = re.compile(r"\*\*(?P<b>.+?)\*\*|\*(?P<i>[^*\n]+?)\*", re.DOTALL)

#: 与 `bot_webhook.render_at_tags` 同一个哨兵值。这里不 import 它,免得两个
#: 服务模块互相依赖;口径由 `test_lark_md` 钉住。
_AT_EVERYONE_NAME = "所有人"

WARN_FONT_COLOR = "font-color-dropped"


def _is_web_url(href: str) -> bool:
    lowered = href.strip().lower()
    return lowered.startswith("http://") or lowered.startswith("https://")


def _emphasized(text: str) -> list[dict[str, Any]]:
    """把一段纯文本按 ``**粗**`` / ``*斜*`` 切成若干 text span。"""
    spans: list[dict[str, Any]] = []
    pos = 0
    for m in _EMPH_RE.finditer(text):
        if m.start() > pos:
            spans.append({"tag": "text", "text": text[pos : m.start()]})
        if m.group("b") is not None:
            spans.append({"tag": "text", "text": m.group("b"), "b": True})
        else:
            spans.append({"tag": "text", "text": m.group("i"), "i": True})
        pos = m.end()
    if pos < len(text):
        spans.append({"tag": "text", "text": text[pos:]})
    return [s for s in spans if s.get("text")]


def parse(content: str, *, warnings: list[str] | None = None) -> list[dict[str, Any]]:
    """``lark_md``(或 ``plain_text``,它是前者的子集)→ span 数组。

    永不抛异常:认不出的记号就当普通文字。外部输入的解析器抛异常等于把
    「对方写错了一个尖括号」变成我们的 500。
    """
    warn = warnings if warnings is not None else []
    spans: list[dict[str, Any]] = []
    pos = 0

    def flush(text: str) -> None:
        if text:
            spans.extend(_emphasized(text))

    for m in _TOKEN_RE.finditer(content):
        flush(content[pos : m.start()])
        pos = m.end()

        if m.group("at") is not None or m.group("at_void") is not None:
            uid = (m.group("at_id") or m.group("at_id2") or "").strip()
            label = (m.group("at_label") or "").strip()
            if uid.lower() == "all":
                spans.append({"tag": "at", "uid": "all", "name": _AT_EVERYONE_NAME})
            elif uid or label:
                # 用发送方自己写的 label,绝不查目录 —— 拿任意 id 反查真名会把
                # 一个泄漏的 webhook URL 变成人名枚举接口(同 render_at_tags)。
                spans.append({"tag": "at", "uid": uid, "name": label or uid})
            continue

        if m.group("a") is not None:
            text = (m.group("a_text") or "").strip()
            href = (m.group("a_href") or "").strip()
            if not text:
                continue
            if _is_web_url(href):
                spans.append({"tag": "a", "text": text, "href": href})
            else:
                # javascript:/data: 是攻击面不是链接。留住字,去掉链接。
                flush(text)
            continue

        if m.group("font") is not None:
            if WARN_FONT_COLOR not in warn:
                warn.append(WARN_FONT_COLOR)
            flush(m.group("font_text") or "")
            continue

        if m.group("mdlink") is not None:
            text = (m.group("md_text") or "").strip()
            href = (m.group("md_href") or "").strip()
            if not text:
                continue
            if _is_web_url(href):
                spans.append({"tag": "a", "text": text, "href": href})
            else:
                flush(text)
            continue

    flush(content[pos:])
    return spans


def spans_plain(spans: list[dict[str, Any]]) -> str:
    """span 数组 → 纯文本投影(预览 / 全文搜索 / @我 检测都读它)。"""
    pieces: list[str] = []
    for span in spans:
        tag = span.get("tag")
        if tag in ("text", "a"):
            pieces.append(str(span.get("text") or ""))
        elif tag == "at":
            name = str(span.get("name") or span.get("uid") or "")
            pieces.append(f"@{name}")
    return "".join(pieces)
