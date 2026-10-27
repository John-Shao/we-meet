"""Work request observability: correlation id and metadata-only metrics."""

import time
import uuid

from work.observability.metrics import emit


class WorkObservabilityMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        correlation_id = getattr(request, "correlation_id", None) or uuid.uuid4().hex
        request.correlation_id = correlation_id
        started = time.monotonic()
        response = self.get_response(request)
        path = getattr(request, "path", "")
        if path.startswith("/work/v1/"):
            elapsed = time.monotonic() - started
            match = getattr(request, "resolver_match", None)
            route = getattr(match, "url_name", None) or "unmatched"
            context = getattr(request, "work_context", None)
            # Unauthenticated and rejected calls have no tenant yet; they still
            # need a series, and "" keeps `sum by (org_id)` from dropping them.
            org_id = getattr(context, "org_id", "") or ""
            emit(
                "work_api_requests_total",
                1,
                {
                    "org_id": org_id,
                    "route": route,
                    "method": request.method,
                    "status_class": f"{response.status_code // 100}xx",
                },
            )
            emit(
                "work_api_request_duration_seconds",
                elapsed,
                {"org_id": org_id, "route": route, "method": request.method},
            )
            response["X-Correlation-ID"] = correlation_id
            response["X-Work-Duration-Ms"] = str(int(elapsed * 1000))
        return response
