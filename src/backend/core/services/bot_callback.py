"""按钮点击 → 外部服务的出站回调(二期 A3)。

传输层的 SSRF 防护全在 :mod:`core.services.outbound_http`;这里只管**说什么**
和**怎么签**。

## 出站签名与入站飞书签名彻底分开

|      | 入站(飞书兼容)          | 出站(我们的)                |
|------|-------------------------|-----------------------------|
| key  | ``f"{ts}\\n{secret}"``   | ``callback_secret``         |
| data | **空串**                | ``f"v1:{ts}:{raw_body}"``   |
| 编码 | base64 / JSON body 的 ``sign`` | hex / ``X-WeMeet-Signature`` |
| 密钥 | ``signing_secret``(群主 UI 可读) | ``callback_secret``(**另一把**) |

共用一把的话,任何能看到入站密钥的人都能伪造我们的出站调用。

## 点击人身份

``actor.id`` 是 ``hmac_sha256(callback_secret, user.pk)[:32]`` —— **每个安装
独立的假名**。外部服务仍能判「同一个人点了两次」做幂等和限流,跨安装不可关联。
密钥轮换后假名会变,这是**特性**:轮换 = 断掉外部积累的行为画像。

``actor.display_name`` 由 ``callback_include_identity`` 控制,**默认关**。
理由:webhook 是群主配的,但点按钮的是每个成员 —— 默认把他们的姓名发给第三方,
是群主替别人做的决定。

**永不外发**:消息 body、群成员名单、我们的内部 pk。
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import time
from typing import Any

SIGNATURE_HEADER = "X-WeMeet-Signature"
TIMESTAMP_HEADER = "X-WeMeet-Timestamp"

#: 上游可以用自己的话覆盖群里的结果条,但只有这一个字段,而且当**不可信输入**
#: 处理:截断 + 去掉换行,不解析 markdown、不允许链接。这是唯一会把上游内容
#: 显示给用户的地方。
MAX_UPSTREAM_TEXT = 120

#: 连续失败这么多次就自动停用回调。与「群没了自动停用安装」同一套路,自愈。
MAX_CONSECUTIVE_FAILURES = 20

#: 只对这些情况重试。4xx 不重试 —— 对方的拒绝就是答案,重试只是骚扰。
RETRYABLE = {"timeout", "unreachable"}
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def sign(secret: str, timestamp: str, raw_body: str) -> str:
    """出站签名。见模块头的对照表 —— 与入站那套**刻意不同**,别「顺手统一」。"""
    payload = f"v1:{timestamp}:{raw_body}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def actor_pseudonym(secret: str, user_pk: Any) -> str:
    """每个安装独立的点击人假名。内部 pk 永不外发。"""
    return hmac.new(
        secret.encode("utf-8"), str(user_pk).encode("utf-8"), hashlib.sha256
    ).hexdigest()[:32]


def build_payload(
    *,
    install,
    card,
    action,
    button_def: dict[str, Any],
    display_name: str,
) -> dict[str, Any]:
    """回调体。**只有这些字段** —— 不带消息 body、不带成员名单、不带内部 id。"""
    actor: dict[str, Any] = {"id": actor_pseudonym(install.callback_secret, action.user_id)}
    if install.callback_include_identity and display_name:
        actor["display_name"] = display_name
    return {
        "v": 1,
        "type": "card.button.clicked",
        "cid": card.cid,
        "mid": card.mid,
        "button": {
            "id": action.button_id,
            "text": button_def.get("text") or "",
            # 发送方自己塞的私有载荷,原样还给它 —— 这正是它存在的意义。
            "value": (card.values or {}).get(action.button_id),
        },
        "actor": actor,
        "ts": int(time.time()),
    }


def build_request(install, payload: dict[str, Any]) -> tuple[str, dict[str, str]]:
    """``(raw_body, headers)``。签的是**这个字节串**,所以调用方必须原样发出去。"""
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    timestamp = str(payload.get("ts") or int(time.time()))
    return raw, {
        "Content-Type": "application/json",
        TIMESTAMP_HEADER: timestamp,
        SIGNATURE_HEADER: sign(install.callback_secret, timestamp, raw),
    }


def clean_upstream_text(raw: Any) -> str:
    """上游给的结果文案 —— **当不可信输入处理**。

    这是唯一会把上游内容显示给群里所有人的地方。所以:只收字符串、压掉所有
    空白、截断,**不解析 markdown、不允许链接**。上游想在群里放一个可点的
    链接,得走别的路。
    """
    if not isinstance(raw, str):
        return ""
    return " ".join(raw.split())[:MAX_UPSTREAM_TEXT]


def should_retry(*, category: str = "", status: int = 0) -> bool:
    """只对连接超时 / 5xx / 429 重试。

    4xx 不重试:对方明确拒绝了,再发一次只是骚扰。地址类失败更不该重试 ——
    地址不会因为多试一次就变合法。
    """
    if category:
        return category in RETRYABLE
    return status in RETRYABLE_STATUS


#: ``pending`` 超过这么久就读作超时。
STALE_PENDING_SECONDS = 300


def is_stale_pending(state: str, created_at: datetime.datetime) -> bool:
    """``pending`` 超过 5 分钟就读作超时。

    **惰性判定,不靠定时任务**:仓库里没有 beat schedule,不为这一件事引入
    一个。而且 Celery 挂了的时候,一个也挂了的清理任务并不能救场 —— 读取时
    判反而永远有效。**这正是群主详情页要用它的原因**:Celery 停摆时那些行
    永远停在 ``pending``,群主看到的必须是「超时」而不是「一切正常」。
    """
    if state != "pending":
        return False
    from django.utils import timezone  # noqa: PLC0415  (纯函数模块,不在导入期拉 Django)

    return (timezone.now() - created_at).total_seconds() > STALE_PENDING_SECONDS


#: 内部分类 → 展示给群主的**四个桶**。
#:
#: 分桶在服务端不在客户端:桶是产品决策(群主看到的每一档都对应一个不同的
#: 动作 —— 等一会儿 / 找对方 / 查网络 / 改地址),而客户端只该负责翻译它。
#: 顺带把「绝不外露上游响应原文」收口成一处。
FAILURE_BUCKETS = {
    # 等一会儿。
    "timeout": "timeout",
    # 对方明确回绝,或者回了我们处理不了的东西 —— 要找对方。
    "refused": "refused",
    "upstream_error": "refused",
    "too_large": "refused",
    # 连都连不上 —— 查网络/域名。
    "unreachable": "unreachable",
    "dns": "unreachable",
    # 地址本身不被允许 —— 只能改地址。
    "empty": "blocked",
    "scheme": "blocked",
    "host": "blocked",
    "port": "blocked",
    "address": "blocked",
    "redirect": "blocked",
}


def failure_bucket(category: str) -> str:
    """未知分类兜底成 ``refused`` —— 不认识的失败也是失败,不能显示成正常。"""
    return FAILURE_BUCKETS.get(category or "", "refused")
