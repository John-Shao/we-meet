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
            match = getattr(request, "resolver_match", None)
            emit(
                "work_api_requests_total",
                1,
                {
                    "route": getattr(match, "url_name", None) or "unmatched",
                    "method": request.method,
                    "status_class": f"{response.status_code // 100}xx",
                },
            )
            response["X-Correlation-ID"] = correlation_id
            response["X-Work-Duration-Ms"] = str(
                int((time.monotonic() - started) * 1000)
            )
        return response
