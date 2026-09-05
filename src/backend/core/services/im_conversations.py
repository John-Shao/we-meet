"""we-meet 侧对 jusi 会话的投影(二期线 B)。

jusi **没有任何 admin 读接口**,而 M 端治理页要显示「这个机器人装在哪个群」。
所以群名走本地投影 —— 详见 :class:`core.models.ImConversation` 的类注释。

这里只有一个写入函数,因为**只有一种写法是安全的**:所有权字段写一次,名字
每次覆盖。散着写四遍 `get_or_create` 迟早有一处把 organization 也覆盖了。
"""

from __future__ import annotations

import logging

from django.db import transaction

from core import models

logger = logging.getLogger(__name__)

MAX_NAME_LENGTH = 120


def project(
    cid: str,
    *,
    name: str | None = None,
    organization=None,
    created_by=None,
) -> None:
    """记一份会话投影。**Best-effort:永远不能让记账把正事搞挂。**

    与 ``im_bots._touch_installation`` 同一套路 —— 建群失败要报错,建群成功
    但没记上账只该在日志里出现。

    ``organization`` / ``created_by`` 是**写一次**语义,只在为空时填:
    否则别组织的人改个群名就能把归属改走,是一个很安静的越权。``name``
    则每次覆盖 —— 它本来就是「最后一次改成了什么」。

    ``name=None`` 与 ``name=""`` 不同:``None`` 是「这次调用不涉及名字」
    (比如装机器人时兜底建行),``""`` 是「名字被清空了」。
    """
    cid = (cid or "").strip()
    if not cid:
        return
    try:
        row, created = models.ImConversation.objects.get_or_create(cid=cid)
        updates: dict = {}
        if name is not None:
            trimmed = name.strip()[:MAX_NAME_LENGTH]
            if created or row.name != trimmed:
                updates["name"] = trimmed
        # 写一次:已经有值就不动。`created` 的分支单独判是为了让新行也能填上。
        if organization is not None and row.organization_id is None:
            updates["organization"] = organization
        if created_by is not None and row.created_by_id is None:
            updates["created_by"] = created_by
        if updates:
            models.ImConversation.objects.filter(pk=row.pk).update(**updates)
    except Exception:  # pragma: no cover - 记账不能拖垮建群/改名
        logger.warning("im_conversations: projection failed cid=%s", cid, exc_info=True)


def set_avatar(cid: str, avatar_key: str, *, organization=None, created_by=None):
    """Persist a group's custom avatar and return ``(row, previous_key)``.

    Unlike :func:`project`, this is the primary write for a user-visible
    setting, so database errors deliberately propagate to the API caller.
    Organization/creator retain the projection's write-once ownership rules.
    An empty key means "use the generated member mosaic".
    """
    with transaction.atomic():
        row = models.ImConversation.objects.select_for_update().filter(cid=cid).first()
        if row is None:
            row = models.ImConversation(cid=cid)
        previous_key = row.avatar_key
        row.avatar_key = (avatar_key or "").strip()[:500]
        if organization is not None and row.organization_id is None:
            row.organization = organization
        if created_by is not None and row.created_by_id is None:
            row.created_by = created_by
        row.save()
    return row, previous_key
