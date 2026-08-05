"""把一次卡片按钮点击回调给外部服务(二期 A3)。

**异步的理由不是性能,是隔离**:点击接口必须立刻返回,群成员的 UI 不该等一个
第三方服务。所以点击那一刻记账 + 广播就完成了,回调只是「另外还要通知一个人」。

失败**不影响群里已经发生的事** —— 点击已经定局、结果条已经广播。回调失败只
让那次点击的 ``callback_state`` 变 failed,群主在机器人详情页看得到分类。
"""

import logging

from django.utils import timezone

from core import models
from core.services import bot_callback as signing
from core.services.outbound_http import OutboundBlocked, post_json
from core.tasks._task import task

logger = logging.getLogger(__name__)

#: 最多重试两次(共三次尝试)。再多就是在替对方的故障放大流量。
MAX_ATTEMPTS = 3


@task(bind=False)
def deliver_card_callback(action_id: str, attempt: int = 1):
    """把 ``ImCardAction`` 回调出去。

    自己调度重试而不是用 Celery 的 ``retry``:重试条件要看**分类**
    (超时/5xx/429 才重试,4xx 和地址类不重试),那个判断在
    :func:`core.services.bot_callback.should_retry` 里,离 Celery 越远越好测。
    """
    action = (
        models.ImCardAction.objects.select_related("card__installation")
        .filter(pk=action_id)
        .first()
    )
    if action is None:
        return
    card = action.card
    install = card.installation
    if install is None or not install.callback_url or not install.callback_enabled:
        return

    button_def = (card.buttons or {}).get(action.button_id) or {}
    payload = signing.build_payload(
        install=install,
        card=card,
        action=action,
        button_def=button_def,
        display_name=_display_name(action.user),
    )
    raw, headers = signing.build_request(install, payload)

    try:
        response = post_json(install.callback_url, raw, headers)
    except OutboundBlocked as exc:
        _fail(action, install, exc.category, attempt)
        return

    if response.status >= 400:
        category = "refused" if response.status < 500 else "upstream_error"
        if signing.should_retry(status=response.status) and attempt < MAX_ATTEMPTS:
            deliver_card_callback.apply_async(
                args=[action_id, attempt + 1], countdown=5 * attempt
            )
            return
        _fail(action, install, category, attempt)
        return

    _succeed(action, install, response.body)


def _display_name(user) -> str:
    return (getattr(user, "full_name", "") or getattr(user, "email", "") or "").strip()


def _fail(action, install, category: str, attempt: int) -> None:
    if signing.should_retry(category=category) and attempt < MAX_ATTEMPTS:
        deliver_card_callback.apply_async(
            args=[str(action.pk), attempt + 1], countdown=5 * attempt
        )
        return
    models.ImCardAction.objects.filter(pk=action.pk).update(
        callback_state="failed", callback_error=category
    )
    # 连续失败到阈值就停用回调 —— 自愈,不需要 cron。地址填错的群主会在详情页
    # 看到「已停用」和分类,而不是我们每次点击都去敲一个不存在的主机。
    count = install.callback_failure_count + 1
    fields = {"callback_failure_count": count}
    if count >= signing.MAX_CONSECUTIVE_FAILURES:
        fields["callback_enabled"] = False
    models.ImBotInstallation.objects.filter(pk=install.pk).update(**fields)
    logger.warning(
        "bot callback failed action=%s install=%s category=%s attempt=%s",
        action.pk,
        install.pk,
        category,
        attempt,
    )


def _succeed(action, install, body: dict) -> None:
    updates = {"callback_state": "done", "callback_error": ""}
    # 上游可以用自己的话覆盖群里的结果条。当**不可信输入**处理 —— 见
    # clean_upstream_text:只收字符串、压空白、截断,不解析 markdown。
    text = signing.clean_upstream_text(body.get("text"))
    if text and action.resolves:
        updates["result_text"] = text
    models.ImCardAction.objects.filter(pk=action.pk).update(**updates)
    if install.callback_failure_count:
        models.ImBotInstallation.objects.filter(pk=install.pk).update(
            callback_failure_count=0
        )


def is_stale_pending(action) -> bool:
    """``pending`` 超过 5 分钟就读作超时。

    **惰性判定,不靠定时任务**:仓库里没有 beat schedule,不为这一件事引入
    一个。而且 Celery 挂了的时候,一个也挂了的清理任务并不能救场 —— 读取时
    判反而永远有效。
    """
    if action.callback_state != "pending":
        return False
    return (timezone.now() - action.created_at).total_seconds() > 300
