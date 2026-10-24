"""Shared Work API fixtures; tasks carry only goal and background."""

import uuid

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory

ROOT = "/api/v1.0/work/"


@pytest.fixture(autouse=True)
def work_settings(settings):
    settings.WORK_ENABLED = True
    settings.WORK_AGENT_ROLLOUT_MODE = "all"
    settings.CACHES = {
        "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
    }
    settings.ALLOWED_HOSTS = ["testserver", "localhost"]
    settings.OIDC_OP_JWKS_ENDPOINT = "http://localhost/unused-test-jwks"


@pytest.fixture
def client():
    user = UserFactory()
    api = APIClient()
    api.force_authenticate(user=user)
    api.work_user = user
    return api


@pytest.fixture
def model_settings(settings):
    settings.WORK_AGENT_ENABLED = True
    settings.WORK_AGENT_URL = "http://127.0.0.1:8881"
    settings.WORK_AGENT_TOKEN = "offline-business-test-token-123456"
    settings.WORK_AGENT_MODEL = "deepseek-flash"
    settings.WORK_AGENT_TOKEN_BUDGET = 80000
    settings.WORK_AGENT_TIMEOUT = 30
    settings.WORK_AGENT_MAX_CALLS = 6
    settings.WORK_MAX_OUTPUT_TOKENS = 3000
    settings.WORK_DAILY_TOKEN_BUDGET = 200000


def task_input(_client=None):
    return {
        "goal": "Clarify launch requirements",
        "background": "Tomorrow",
    }


def submit(client, data=None, key=None):
    return client.post(
        ROOT + "tasks/",
        data or task_input(),
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()),
    )
