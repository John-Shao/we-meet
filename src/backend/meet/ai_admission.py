"""Bound concurrent provider requests for the dedicated AI WSGI pool."""

import re
from threading import BoundedSemaphore

# Keep these routes aligned with ingress_ai.yaml. Ordinary APIs stay in their pool.
AI_PATHS = (
    r"/api/v1[.]0/users/me/ai/ask(-stream)?/",
    r"/api/v1[.]0/search/ask(-stream)?/",
    r"/api/v1[.]0/rooms/[^/]+/ask-ai(-stream)?/",
    r"/api/v1[.]0/meeting-records/[^/]+/questions/([^/]+/)?",
    r"/api/v1[.]0/assistant-summary/",
)
HEALTH_PATHS = {"/__heartbeat__", "/__lbheartbeat__"}


class _Response:
    """Release capacity on exhaustion, errors and close before the first byte."""

    def __init__(self, response, release):
        self.response = response
        self.iterator = iter(response)
        self.release = release
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        if self.closed:
            raise StopIteration
        try:
            return next(self.iterator)
        except BaseException:
            self.close()
            raise

    def close(self):
        if not self.closed:
            self.closed = True
            try:
                close = getattr(self.response, "close", None)
                if close:
                    close()
            finally:
                self.release()


class AIAdmission:
    """Process-local limit; use more Gunicorn threads than admitted requests."""

    def __init__(self, application, capacity):
        if capacity < 1:
            raise ValueError("AI_MAX_CONCURRENT_REQUESTS must be positive")
        self.application = application
        self.slots = BoundedSemaphore(capacity)

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        if path in HEALTH_PATHS:
            return self.application(environ, start_response)
        if not any(re.fullmatch(pattern, path) for pattern in AI_PATHS):
            start_response("404 Not Found", [("Content-Type", "application/json")])
            return [b'{"detail":"Not found."}']
        if not self.slots.acquire(blocking=False):
            start_response(
                "503 Service Unavailable",
                [
                    ("Content-Type", "application/json"),
                    ("Retry-After", "5"),
                    ("Cache-Control", "no-store"),
                ],
            )
            return [b'{"detail":"AI capacity is busy. Please try again shortly."}']
        try:
            return _Response(
                self.application(environ, start_response), self.slots.release
            )
        except BaseException:
            self.slots.release()
            raise
