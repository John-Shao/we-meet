"""Turn requests into daily activity counters (P10 M2).

Deliberately the thinnest possible middleware: map the path to a module, ask a
cache whether this (user, module) has already been counted in the last five
minutes, and if not, hand the write to a task.

**No synchronous database access here.** Every request in the product passes
through this, including the ones that are already the slowest, so anything more
than a cache round-trip would be a tax on the whole API.

Organization resolution is also deliberately absent: it needs a query, and the
task can do it just as well off the request thread.
"""

import logging

from django.utils import timezone

from core.services.activity import module_for_path, should_record

logger = logging.getLogger(__name__)


class ActivityMiddleware:
    """Records that a signed-in user touched a product area today."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        try:
            self._maybe_record(request, response)
        except Exception:  # noqa: BLE001 — analytics must never break a response
            logger.debug("activity middleware failed", exc_info=True)
        return response

    @staticmethod
    def _maybe_record(request, response):
        # Only successful, authenticated, state-carrying requests count. A 403
        # is not usage, and counting it would make "who uses messaging" include
        # everyone who was denied it.
        if response.status_code >= 400:
            return
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated or getattr(user, "is_device", False):
            return
        module = module_for_path(request.path)
        if module is None:
            return
        if not should_record(user.id, module, timezone.localdate()):
            return

        from core.tasks.activity import record_activity

        record_activity.delay(str(user.id), None, module)
