"""Throttling modules for the API."""

from django.conf import settings

from lasuite.drf.throttling import MonitoredThrottleMixin
from rest_framework.throttling import AnonRateThrottle, UserRateThrottle
from sentry_sdk import capture_message


def sentry_monitoring_throttle_failure(message):
    """Log when a failure occurs to detect rate limiting issues."""
    capture_message(message, "warning")


class MonitoredAnonRateThrottle(MonitoredThrottleMixin, AnonRateThrottle):
    """Throttle for the monitored scoped rate throttle."""


class MonitoredUserRateThrottle(MonitoredThrottleMixin, UserRateThrottle):
    """Throttle for the monitored scoped rate throttle."""


class RequestEntryAuthenticatedUserRateThrottle(MonitoredUserRateThrottle):
    """Throttle authenticated user requesting room entry"""

    scope = "request_entry"

    def get_cache_key(self, request, view):
        """Use the authenticated user ID as the throttle cache key."""

        if request.user and not request.user.is_authenticated:
            return None  # Defer to RequestEntryAnonRateThrottle for anonymous users.

        return super().get_cache_key(request, view)


class RequestEntryAnonRateThrottle(MonitoredAnonRateThrottle):
    """Throttle Anonymous user requesting room entry"""

    scope = "request_entry"

    def get_cache_key(self, request, view):
        """Use the lobby participant cookie ID as the throttle cache key.

        Only throttle if a cookie is already set. If no cookie exists yet,
        return None to skip throttling — the cookie will be set on the first
        response, and throttling will apply from the second request onward.

        Keying on the cookie rather than the IP address prevents penalising
        multiple users behind the same NAT/proxy, and is consistent with how
        LobbyService identifies participants.

        Note: as per DRF documentation, application-level throttling is not a
        security measure against brute-force or DoS attacks. This throttle exists
        solely to guard against accidental hammering from buggy clients.
        """

        if request.user and request.user.is_authenticated:
            return None  # Only throttle unauthenticated requests.

        participant_id = request.COOKIES.get(settings.LOBBY_COOKIE_NAME)

        if participant_id is None:
            return None  # No throttling for cookieless requests

        return self.cache_format % {
            "scope": self.scope,
            "ident": participant_id,
        }


class CreationCallbackAnonRateThrottle(MonitoredAnonRateThrottle):
    """Throttle Anonymous user requesting room generation callback"""

    scope = "creation_callback"


class RoomAIRateThrottle(MonitoredUserRateThrottle):
    """Per-participant throttle for the room sidebar AI ``ask-ai`` endpoint.

    The endpoint runs behind LiveKit token auth, so ``request.user`` may
    be ``AnonymousUser`` for lobby joiners. Keying on the token identity
    (``request.auth.identity``) catches both authenticated members and
    one-off guests with the same rate limit. Without a valid token there
    is nothing useful to throttle on — return ``None`` and let the
    authentication layer reject the request itself.
    """

    scope = "room_ai"

    def get_cache_key(self, request, view):
        ident = getattr(getattr(request, "auth", None), "identity", None)
        if not ident:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}


class GlobalSearchAIRateThrottle(MonitoredUserRateThrottle):
    """Per-user throttle for the global-search AI QA endpoints (P1-4).

    独立 scope,不与 personal_ai 抢额度;免费开放下的四道成本闸之一
    (显式触发/本限流/全空不调 LLM/熔断,见 global_search_ai_qa.md §D7)。
    """

    scope = "global_search_ai"

    def get_cache_key(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return None
        return self.cache_format % {
            "scope": self.scope,
            "ident": str(request.user.pk),
        }


class GlobalSearchAIDailyThrottle(MonitoredUserRateThrottle):
    """P1-4 M3 成本护栏:AI 问答 per-user 日上限(免费开放的第五道闸)。

    额度由 ``GLOBAL_ASK_DAILY_LIMIT`` 配置(0 = 不限,rate None 直接放行)。
    与 ``global_search_ai`` 的 10/min 突发限流叠加:前者防脚本轰炸,本限
    防全天挂机烧钱。窗口语义为 DRF 滚动 24h,非自然日,足够护栏用途。
    """

    scope = "global_search_ai_daily"

    def get_rate(self):
        limit = int(getattr(settings, "GLOBAL_ASK_DAILY_LIMIT", 0) or 0)
        return f"{limit}/day" if limit > 0 else None

    def get_cache_key(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return None
        return self.cache_format % {
            "scope": self.scope,
            "ident": str(request.user.pk),
        }


class DocsMyDocumentsRateThrottle(MonitoredUserRateThrottle):
    """Per-user throttle for the "share doc to chat" picker list endpoint.

    Unlike ``DocsSearchView`` (which short-circuits to an empty list when
    ``len(q) < 2`` before ever touching Docs), ``my-documents`` treats an empty
    ``q`` as the common "recent documents" case and therefore hits the Docs
    server-to-server endpoint + a DB ``ORDER BY`` on every call. This guards a
    bare ``GET /docs/my-documents/`` loop from hammering Docs — not a security
    control, just an accidental-hammering backstop (see DRF docs). The default
    rate stays generous enough for type-ahead in the picker (no client-side
    debounce today).
    """

    scope = "docs_my_documents"

    def get_cache_key(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return None
        return self.cache_format % {
            "scope": self.scope,
            "ident": str(request.user.pk),
        }


class DocsSessionRateThrottle(MonitoredUserRateThrottle):
    """Per-user throttle for the embedded-docs session bootstrap.

    Every call mints a one-shot login ticket at Docs, so it is both a Docs
    round-trip and (by design) a credential factory. Clients need it about once
    per docs-tab mount; the ceiling only has to stop a loop from turning into a
    ticket firehose.
    """

    scope = "docs_session"

    def get_cache_key(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return None
        return self.cache_format % {
            "scope": self.scope,
            "ident": str(request.user.pk),
        }


class PersonalAIRateThrottle(MonitoredUserRateThrottle):
    """Per-user throttle for the cross-meeting (personal) AI endpoint.

    Always requires an authenticated Django user — anonymous requests
    can't reach this view in the first place. Keying by user.id rather
    than IP avoids penalising teams behind shared NAT.
    """

    scope = "personal_ai"

    def get_cache_key(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return None
        return self.cache_format % {
            "scope": self.scope,
            "ident": str(request.user.pk),
        }


class BotWebhookTokenThrottle(MonitoredAnonRateThrottle):
    """Per-webhook-token ceiling for the group-bot endpoint (飞书 uses 100/min).

    Keyed by the token in the URL so one noisy bot cannot starve another. The
    token is a 256-bit secret, so it is a stable identity for a caller in a way
    an IP behind NAT is not.
    """

    scope = "bot_webhook"

    def get_cache_key(self, request, view):
        token = (getattr(view, "kwargs", None) or {}).get("token")
        if not token:
            return None
        return self.cache_format % {"scope": self.scope, "ident": token}


class BotWebhookBurstThrottle(BotWebhookTokenThrottle):
    """Short-window companion to the per-minute ceiling (飞书 allows 5/second)."""

    scope = "bot_webhook_burst"


class BotWebhookIPThrottle(MonitoredAnonRateThrottle):
    """Per-IP backstop for the group-bot endpoint.

    The token buckets above are useless against someone trying random tokens:
    each guess is a fresh bucket. This one bounds that, and is deliberately
    generous so a busy office behind one NAT with several bots is unaffected.
    """

    scope = "bot_webhook_ip"


class CardClickUserThrottle(MonitoredUserRateThrottle):
    """卡片按钮点击 —— 按**点击人**分桶(线 A)。

    挡的是一个人连点。``once`` 块点完就变结果条,按不动了;但 ``each`` 块
    (「重跑」那类)**刻意不定局**,按钮一直在那儿 —— 一个人就能把它当成一个
    「向第三方发请求」的按钮无限点下去。

    宽到正常人碰不到:一分钟点几十次已经不是在用产品了。
    """

    scope = "card_click"

    def get_cache_key(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return None
        return self.cache_format % {
            "scope": self.scope,
            "ident": str(request.user.pk),
        }


class CardClickInstallationThrottle(MonitoredAnonRateThrottle):
    """卡片按钮点击 —— 按**机器人安装**分桶。**三层里最要紧的一层。**

    上面那层保护不了这个场景:200 人的群里每人点一次「重跑」,每个人都在自己
    的额度内,而对方的服务器一口气吃 200 个请求 —— **我们等于替他们发起了一次
    DoS**。所以必须有一层的分桶键是「打给谁」,不是「谁在打」。

    按 installation 而不是按 bot:同一个机器人装在十个群里,十个群的流量本来
    就分别打给十个 ``callback_url``(地址在 installation 上,不在 bot 上)。

    继承 Anon 那支是因为**分桶键与请求者身份无关** —— 这里要的是「这个安装的
    总量」,把已登录用户排除掉就正好丢掉了全部要计的数。
    """

    scope = "card_click_install"

    def _installation_ident(self, request, view):
        """``mid`` → 权威的 installation。**不信客户端**,与 viewset 同一条规矩。

        查不到就不限流:那种请求马上会被 viewset 404 掉,没必要为它建一个桶
        (否则拿随机 mid 猛试反而能把别人的桶占满)。
        """
        raw = (getattr(view, "kwargs", None) or {}).get("pk")
        try:
            mid = int(raw)
        except (TypeError, ValueError):
            return None
        from core import models  # noqa: PLC0415  (循环 import:models 会拉起 api)

        install_id = (
            models.ImCardMessage.objects.filter(mid=mid)
            .values_list("installation_id", flat=True)
            .first()
        )
        return str(install_id) if install_id else None

    def get_cache_key(self, request, view):
        ident = self._installation_ident(request, view)
        if not ident:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}


class CardClickInstallationBurstThrottle(CardClickInstallationThrottle):
    """同上,短窗口的那半 —— 挡瞬时尖峰,不是持续量。

    与入站 webhook 的 ``bot_webhook`` / ``bot_webhook_burst`` 是同一手法:
    一分钟的总量和一秒钟的尖峰是两件事,只设前者的话「全群同一秒点」照样穿过去。
    """

    scope = "card_click_install_burst"


class AdminBotCredentialThrottle(MonitoredUserRateThrottle):
    """M 端逐个读机器人凭据的限流(线 B)。

    **不是防管理员** —— 有 ``org.bot.secret.read`` 的人本来就该能读。它要做的
    是让「把全组织的凭据撸一遍」这件事变慢、变可见:一次一行、每行一条审计,
    再配一个每小时的上限,批量导出就成了一件在审计日志里很显眼的事。
    """

    scope = "admin_bot_credential"
