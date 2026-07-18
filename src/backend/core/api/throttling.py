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
