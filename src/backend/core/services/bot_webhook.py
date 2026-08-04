"""飞书-compatible webhook payloads → we-meet IM messages.

Pure functions: no HTTP, no database, no jusi. The view layer
(``core/api/bot_webhook.py``) owns transport, rate limiting and delivery; this
module owns "what does this JSON mean".

The request format is 飞书's custom-bot format **verbatim**, because the point of
the feature is that a team already pushing CI notifications to 飞书 can add a
second URL and be done. That compatibility extends to the signature algorithm
and the response envelope, both of which differ from anything else in this
codebase — see :func:`feishu_sign`.

Supported ``msg_type``:

  - ``text``  → our plain ``text`` content type. No new protocol, no client change.
  - ``post``  → ``rich-text`` (see :mod:`core.services.im_cards`), flattened to a
    single language and with images degraded to a ``[图片]`` placeholder.
"""

import base64
import hashlib
import hmac
import ipaddress
import json
import re
import time
from typing import Any, NamedTuple

from core.services import im_cards

# 飞书 error codes we reuse verbatim (their wording, because SDKs in the wild
# branch on the message string), plus our own in the 11xxx range.
CODE_OK = 0
CODE_BAD_TOKEN = 19001
CODE_BOT_DISABLED = 19003
CODE_BAD_SIGN = 19021
CODE_IP_NOT_ALLOWED = 19022
CODE_NO_KEYWORD = 19024
CODE_RATE_LIMITED = 11000
CODE_BODY_TOO_LARGE = 11001
CODE_BAD_BODY = 11002
CODE_BAD_MSG_TYPE = 11003
CODE_EMPTY_CONTENT = 11004
CODE_IM_UNAVAILABLE = 11005
CODE_CONVERSATION_GONE = 11006

MSG_BAD_TOKEN = "param invalid: incoming webhook access token invalid"
MSG_BAD_SIGN = (
    "sign match fail or timestamp is not within one hour from current time"
)
MSG_NO_KEYWORD = "Key Words Not Found"

#: 飞书 allows an hour of clock drift on the signature timestamp.
SIGN_WINDOW_SECONDS = 3600

#: Whole-request cap, checked before JSON parsing.
MAX_BODY_BYTES = 20 * 1024

#: Cap on the rendered text of one message.
MAX_TEXT_RUNES = 4000

#: Literal that both clients' "@我" detection matches for a broadcast mention.
#: It is a zh string on purpose: the check is ``body.includes('@' + t('mention.
#: everyone'))``, so an ``Everyone`` locale will not light up. Known limitation —
#: fixing it means making both clients match a locale-independent token.
AT_EVERYONE = "@所有人"

IMAGE_PLACEHOLDER = "[图片]"

#: 飞书 wraps ``post`` content in a locale envelope. We keep one language; this
#: is the preference order when several are present.
_LOCALE_PREFERENCE = ("zh_cn", "zh", "zh_hans", "en_us", "en")

_AT_TAG_RE = re.compile(
    r'<at\s+user_id="(?P<uid>[^"]*)"\s*>(?P<label>.*?)</at\s*>', re.IGNORECASE | re.DOTALL
)
_AT_TAG_SELF_CLOSING_RE = re.compile(
    r'<at\s+user_id="(?P<uid>[^"]*)"\s*/>', re.IGNORECASE
)


class BotMessage(NamedTuple):
    """A message ready to hand to jusi."""

    content_type: str
    body: str
    #: Rendered text, for keyword matching. Never sent as-is for rich-text.
    plain: str


class BotPayloadError(Exception):
    """A payload we can describe precisely back to the sender."""

    def __init__(self, code: int, message: str, http_status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


# ---- security ---------------------------------------------------------------


def feishu_sign(timestamp: str, secret: str) -> str:
    """飞书's custom-bot signature.

    The secret is the HMAC **key** and the data is empty — not the other way
    round, and not over the request body at all:

        key  = f"{timestamp}\\n{secret}"
        sign = base64(hmac_sha256(key, b""))

    Deliberately unlike our own admin/push HMAC (``key=secret``, data =
    ``method\\npath\\nts\\nbody``). Do not "unify" them: the whole value of this
    endpoint is that a script written against 飞书 works unchanged.
    """
    string_to_sign = f"{timestamp}\n{secret}"
    digest = hmac.new(
        string_to_sign.encode("utf-8"), b"", digestmod=hashlib.sha256
    ).digest()
    return base64.b64encode(digest).decode("utf-8")


def check_signature(payload: dict, secret: str, *, now: float | None = None) -> bool:
    """Verify ``timestamp``/``sign`` from the JSON body (not headers — 飞书's shape)."""
    if not secret:
        return False
    timestamp = str(payload.get("timestamp") or "")
    sign = str(payload.get("sign") or "")
    if not timestamp or not sign:
        return False
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    current = time.time() if now is None else now
    if abs(current - ts) > SIGN_WINDOW_SECONDS:
        return False
    return hmac.compare_digest(feishu_sign(timestamp, secret), sign)


def check_ip_allowed(client_ip: str, allowlist) -> bool:
    """True when ``client_ip`` matches any entry. Empty allowlist = no gate.

    An unparseable client IP fails **closed** when a list is configured: an
    allowlist that silently passes everything because a proxy header changed
    shape is worse than one that rejects.
    """
    entries = [str(e).strip() for e in (allowlist or []) if str(e).strip()]
    if not entries:
        return True
    try:
        addr = ipaddress.ip_address(client_ip)
    except ValueError:
        return False
    for entry in entries:
        try:
            if addr in ipaddress.ip_network(entry, strict=False):
                return True
        except ValueError:
            continue
    return False


def check_keywords(text: str, keywords) -> bool:
    """True when any keyword appears in the rendered text. Empty list = no gate."""
    words = [str(k).strip() for k in (keywords or []) if str(k).strip()]
    if not words:
        return True
    return any(word in text for word in words)


# ---- payload → message -------------------------------------------------------


def build_message(payload: Any) -> BotMessage:
    """Map a 飞书 webhook payload to a message. Raises :class:`BotPayloadError`."""
    if not isinstance(payload, dict):
        raise BotPayloadError(CODE_BAD_BODY, "invalid request body")
    msg_type = str(payload.get("msg_type") or "").strip()
    if msg_type == "text":
        return _build_text(payload)
    if msg_type == "post":
        return _build_post(payload)
    if not msg_type:
        raise BotPayloadError(CODE_BAD_MSG_TYPE, "msg_type is required")
    raise BotPayloadError(
        CODE_BAD_MSG_TYPE, f"unsupported msg_type: {msg_type} (supported: text, post)"
    )


def _content_of(payload: dict) -> dict:
    content = payload.get("content")
    if not isinstance(content, dict):
        raise BotPayloadError(CODE_BAD_BODY, "content must be an object")
    return content


def _build_text(payload: dict) -> BotMessage:
    text = _content_of(payload).get("text")
    if not isinstance(text, str):
        raise BotPayloadError(CODE_BAD_BODY, "content.text must be a string")
    rendered = render_at_tags(text).strip()
    if not rendered:
        raise BotPayloadError(CODE_EMPTY_CONTENT, "empty content")
    if len(rendered) > MAX_TEXT_RUNES:
        raise BotPayloadError(
            CODE_BODY_TOO_LARGE, f"text exceeds {MAX_TEXT_RUNES} characters", 413
        )
    return BotMessage(content_type="text", body=rendered, plain=rendered)


def render_at_tags(text: str) -> str:
    """Turn 飞书's ``<at>`` markup into the plain ``@name`` our bubbles use.

    ``user_id="all"`` becomes the literal :data:`AT_EVERYONE`, which is what
    both clients' unread-mention check looks for. For a specific person we use
    **the label the sender wrote**, never a directory lookup: resolving an
    arbitrary id to a real name would turn any leaked webhook URL into a
    name-enumeration oracle, and the sender already knows who they meant.
    """

    def _replace(match: "re.Match[str]") -> str:
        uid = (match.groupdict().get("uid") or "").strip()
        label = (match.groupdict().get("label") or "").strip()
        if uid.lower() == "all":
            return AT_EVERYONE
        return f"@{label or uid}"

    text = _AT_TAG_RE.sub(_replace, text)
    return _AT_TAG_SELF_CLOSING_RE.sub(_replace, text)


def _pick_locale(post: dict) -> dict:
    """Flatten 飞书's ``{zh_cn: …, en_us: …}`` envelope down to one language."""
    for key in _LOCALE_PREFERENCE:
        candidate = post.get(key)
        if isinstance(candidate, dict):
            return candidate
    for value in post.values():
        if isinstance(value, dict):
            return value
    raise BotPayloadError(CODE_BAD_BODY, "content.post has no language block")


def _build_post(payload: dict) -> BotMessage:
    post = _content_of(payload).get("post")
    if not isinstance(post, dict):
        raise BotPayloadError(CODE_BAD_BODY, "content.post must be an object")
    block = _pick_locale(post)
    title = block.get("title")
    title = title.strip() if isinstance(title, str) else ""
    raw_paragraphs = block.get("content")
    if not isinstance(raw_paragraphs, list):
        raise BotPayloadError(CODE_BAD_BODY, "content.post.<lang>.content must be a list")

    paragraphs: list[list[dict[str, Any]]] = []
    for raw in raw_paragraphs:
        if not isinstance(raw, list):
            continue
        tags = [t for t in (_normalize_tag(item) for item in raw) if t]
        if tags:
            paragraphs.append(tags)

    if not paragraphs and not title:
        raise BotPayloadError(CODE_EMPTY_CONTENT, "empty content")

    plain = rich_text_plain(title, paragraphs)
    if len(plain) > MAX_TEXT_RUNES:
        raise BotPayloadError(
            CODE_BODY_TOO_LARGE, f"text exceeds {MAX_TEXT_RUNES} characters", 413
        )
    card = im_cards.build_rich_text(content=paragraphs, title=title, plain=plain)
    return BotMessage(
        content_type=im_cards.RICH_TEXT,
        body=json.dumps(card, ensure_ascii=False),
        plain=plain,
    )


def _normalize_tag(item: Any) -> dict[str, Any] | None:
    """One 飞书 inline tag → one of ours, or None to drop it.

    Degradations are visible rather than silent: an image becomes ``[图片]``
    (we have no upload channel a bot could use, so the ``image_key`` would never
    resolve), and a non-http link keeps its words and loses its href.
    """
    if not isinstance(item, dict):
        return None
    tag = str(item.get("tag") or "").strip().lower()

    if tag == "text":
        text = item.get("text")
        return {"tag": "text", "text": text} if isinstance(text, str) and text else None

    if tag == "a":
        text = item.get("text")
        href = item.get("href")
        if not isinstance(text, str) or not text:
            return None
        if isinstance(href, str) and _is_web_url(href):
            return {"tag": "a", "text": text, "href": href}
        # A javascript:/data: href is an XSS attempt, not a link. Keep the words.
        suffix = f"({href})" if isinstance(href, str) and href else ""
        return {"tag": "text", "text": f"{text}{suffix}"}

    if tag == "at":
        uid = str(item.get("user_id") or "").strip()
        name = item.get("user_name")
        name = name.strip() if isinstance(name, str) else ""
        if uid.lower() == "all":
            return {"tag": "at", "uid": "all", "name": "所有人"}
        if not uid and not name:
            return None
        return {"tag": "at", "uid": uid, "name": name or uid}

    if tag == "img":
        return {"tag": "text", "text": IMAGE_PLACEHOLDER}

    return None


def _is_web_url(href: str) -> bool:
    lowered = href.strip().lower()
    return lowered.startswith("http://") or lowered.startswith("https://")


def rich_text_plain(title: str, paragraphs: list[list[dict[str, Any]]]) -> str:
    """Flatten rich text to prose — the ``plain`` projection, and what keyword
    gating matches against."""
    lines: list[str] = []
    if title:
        lines.append(title)
    for paragraph in paragraphs:
        pieces: list[str] = []
        for tag in paragraph:
            kind = tag.get("tag")
            if kind == "text":
                pieces.append(str(tag.get("text") or ""))
            elif kind == "a":
                pieces.append(str(tag.get("text") or ""))
            elif kind == "at":
                name = str(tag.get("name") or tag.get("uid") or "")
                pieces.append(AT_EVERYONE if tag.get("uid") == "all" else f"@{name}")
        line = "".join(pieces).strip()
        if line:
            lines.append(line)
    return " ".join(lines).strip()
