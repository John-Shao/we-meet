"""Prometheus scrape endpoint for the Work R0a telemetry registry.

Kept outside ``/work/v1/`` on purpose: this is not part of the D2 product API
surface, and the scrape must not require a user session.  Access is gated on
``WORK_METRICS_TOKEN``; with no token configured the endpoint stays off, so a
publicly routed ingress cannot leak per-org series by default.
"""

import hmac
import os

from django.http import HttpResponse, HttpResponseNotFound
from django.views import View

from prometheus_client import CONTENT_TYPE_LATEST

from work.observability.metrics import render


class MetricsView(View):
    def get(self, request):
        token = os.environ.get("WORK_METRICS_TOKEN")
        if not token:
            return HttpResponseNotFound()
        presented = request.headers.get("Authorization", "").removeprefix("Bearer ")
        if not hmac.compare_digest(presented, token):
            return HttpResponseNotFound()
        return HttpResponse(render(), content_type=CONTENT_TYPE_LATEST)
