"""Dedicated threaded WSGI entry point for model calls and SSE responses."""

from os import environ

from meet.ai_admission import AIAdmission
from meet.wsgi import application as django_application

application = AIAdmission(
    django_application, int(environ.get("AI_MAX_CONCURRENT_REQUESTS", "2"))
)
