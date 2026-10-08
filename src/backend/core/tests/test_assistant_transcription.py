"""Dedicated, short-lived client credentials without general-key fallback."""

import json
import time
from unittest.mock import patch

from django.core.cache import cache

import pytest
import requests
from rest_framework.test import APIClient

from core.factories import UserFactory

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/assistant-transcription/session/"


@pytest.fixture
def direct(settings):
    cache.clear()
    settings.DASHSCOPE_ASR_CLIENT_API_KEY = "dedicated-asr-key"
    settings.DASHSCOPE_API_KEY = "general-key-must-not-be-issued"
    settings.DASHSCOPE_WORKSPACE_ID = "asr-test"
    settings.DASHSCOPE_REGION = "cn-beijing"
    client = APIClient()
    client.force_authenticate(UserFactory())
    with patch("core.api.assistant_transcription.provider_http.request") as request:
        upstream = request.return_value.__enter__.return_value
        upstream.status_code = 200
        upstream.iter_content.return_value = [
            json.dumps(
                {"token": "st-test", "expires_at": int(time.time()) + 60}
            ).encode()
        ]
        yield client, request, upstream


def test_dedicated_key_and_fixed_model(direct):
    client, request, _ = direct
    response = client.post(URL, {"model": "another-model"}, format="json")
    assert response.status_code == 200
    assert response.data["model"] == "qwen-audio-3.1-asr-flash-streaming"
    assert (
        response.data["url"]
        == "wss://asr-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
    )
    assert response["Cache-Control"] == "no-store"
    assert response.data["session_lease"]["enforce"] is False
    options = request.call_args.kwargs
    assert options["headers"]["Authorization"] == "Bearer dedicated-asr-key"
    assert options["params"]["expire_in_seconds"] == 60
    assert options["allow_redirects"] is False


def test_never_falls_back_to_general_key(direct, settings):
    client, request, _ = direct
    settings.DASHSCOPE_ASR_CLIENT_API_KEY = ""
    assert client.post(URL).status_code == 503
    request.assert_not_called()


def test_login_required(direct):
    _, request, _ = direct
    assert APIClient().post(URL).status_code in (401, 403)
    request.assert_not_called()


@pytest.mark.parametrize(
    "body",
    [
        [],
        {},
        {"token": "long-lived-key", "expires_at": int(time.time()) + 60},
        {"token": "st-test", "expires_at": 1},
    ],
)
def test_invalid_upstream_credentials_are_not_returned(direct, body):
    client, _, upstream = direct
    upstream.iter_content.return_value = [json.dumps(body).encode()]
    assert client.post(URL).status_code == 502


def test_upstream_errors_are_sanitized(direct):
    client, request, _ = direct
    request.side_effect = requests.ConnectionError("dedicated-asr-key")
    response = client.post(URL)
    assert response.status_code == 502
    assert "dedicated-asr-key" not in str(response.data)


def test_upstream_response_bound(direct):
    client, _, upstream = direct
    upstream.iter_content.return_value = [b"x" * 8193]
    assert client.post(URL).status_code == 502
