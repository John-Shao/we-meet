import json
from unittest.mock import patch

from django.core.cache import cache

import pytest
import requests
from rest_framework.test import APIClient

from core.factories import UserFactory

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/assistant-translation/session/"
PAIR = {"source_language": "zh", "target_language": "en"}


@pytest.fixture
def direct(settings):
    cache.clear()
    settings.DASHSCOPE_API_KEY = "private-provider-key"
    settings.DASHSCOPE_WORKSPACE_ID = "llm-test"
    settings.DASHSCOPE_REGION = "cn-beijing"
    client = APIClient()
    client.force_authenticate(UserFactory())
    with patch("core.api.assistant_translation.requests.post") as post:
        upstream = post.return_value.__enter__.return_value
        upstream.status_code = 200
        upstream.iter_content.return_value = [
            json.dumps(
                {
                    "sid": "session",
                    "aoqTokenForClient": "temporary-token",
                    "clientRelayCertFingerprint": "fingerprint",
                    "clientRelayEndpoints": [{"endpoint": "192.0.2.1", "port": 8443}],
                    "extraInfo": {"workspaceIdHash": "workspace"},
                    "secret": "not-allowed",
                }
            ).encode()
        ]
        yield client, post, upstream


@pytest.mark.parametrize(
    "purpose,model",
    [
        ("translation", "qwen3.8-livetranslate-flash-realtime"),
        ("language_detection", "qwen3.8-omni-flash-realtime"),
    ],
)
def test_model_scoped_allocation_without_speech_proxy(direct, purpose, model):
    client, post, _ = direct
    response = client.post(
        URL,
        {**PAIR, "purpose": purpose, "model": "evil", "url": "https://evil"},
        format="json",
    )
    assert response.status_code == 200
    assert response.data["model"] == model
    assert response.data["aoq"]["aoqTokenForClient"] == "temporary-token"
    assert "private-provider-key" not in str(response.data)
    assert "not-allowed" not in str(response.data)
    assert response["Cache-Control"] == "no-store"
    assert post.call_args.kwargs["params"] == {"model": model}
    assert post.call_args.kwargs["headers"]["x-dashscope-rtc-transport"] == "moq"
    assert post.call_args.kwargs["data"] == b"{}"
    assert post.call_args.kwargs["allow_redirects"] is False


def test_requires_authenticated_account(direct):
    assert APIClient().post(URL, PAIR, format="json").status_code in (401, 403)
    direct[1].assert_not_called()


@pytest.mark.parametrize(
    "body",
    [
        {**PAIR, "purpose": "other"},
        {**PAIR, "target_language": "zh"},
        {**PAIR, "target_language": "xx"},
    ],
)
def test_validates_request_before_allocation(direct, body):
    assert direct[0].post(URL, body, format="json").status_code == 400
    direct[1].assert_not_called()


@pytest.mark.parametrize("status", [302, 401, 429, 500])
def test_rejects_provider_errors_and_redirects(direct, status):
    direct[2].status_code = status
    assert direct[0].post(URL, PAIR, format="json").status_code == 502


@pytest.mark.parametrize(
    "payload",
    [b"{}", b"not-json", b"x" * 131073],
    ids=["missing", "invalid", "oversized"],
)
def test_bounded_validated_allocation(direct, payload):
    direct[2].iter_content.return_value = [payload]
    assert direct[0].post(URL, PAIR, format="json").status_code == 502


def test_timeout_is_controlled(direct):
    direct[1].side_effect = requests.Timeout("private")
    response = direct[0].post(URL, PAIR, format="json")
    assert response.status_code == 502
    assert "private" not in str(response.data)


def test_invalid_config_never_sends_key(direct, settings):
    settings.DASHSCOPE_WORKSPACE_ID = "evil/path"
    assert direct[0].post(URL, PAIR, format="json").status_code == 503
    direct[1].assert_not_called()
