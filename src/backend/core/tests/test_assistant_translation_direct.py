import json
from unittest.mock import patch

from django.core.cache import cache

import pytest
import requests
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.models import AIPrompt

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
    with patch("core.api.assistant_translation.provider_http.request") as post:
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
    assert response.data["session_lease"]["enforce"] is False
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


OFFER = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"


@pytest.mark.parametrize(
    "purpose,model",
    [
        ("translation", "qwen3.8-livetranslate-flash-realtime"),
        ("language_detection", "qwen3.8-omni-flash-realtime"),
    ],
)
def test_webrtc_exchanges_only_sdp_with_model_scoped_lease(direct, purpose, model):
    client, post, upstream = direct
    upstream.iter_content.return_value = [
        b"v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\n\n"
    ]
    response = client.post(
        URL,
        {**PAIR, "transport": "webrtc", "purpose": purpose, "sdp": OFFER},
        format="json",
    )
    assert response.status_code == 200
    assert response.data["transport"] == "webrtc"
    assert response.data["model"] == model
    assert response.data["sdp"].startswith("v=0\r\n")
    assert response.data["sdp"].endswith("\r\n") and not response.data["sdp"].endswith(
        "\r\n\r\n"
    )
    assert "aoq" not in response.data
    assert "private-provider-key" not in str(response.data)
    assert response["Cache-Control"] == "no-store"
    assert "session_lease" in response.data
    assert post.call_args.kwargs["data"] == OFFER.encode()
    assert post.call_args.kwargs["headers"]["Content-Type"] == "application/sdp"
    assert "x-dashscope-rtc-transport" not in post.call_args.kwargs["headers"]
    assert post.call_args.kwargs["params"] == {"model": model}


@pytest.mark.parametrize(
    "body",
    [
        {"transport": "unknown"},
        {"transport": "webrtc"},
        {"transport": "webrtc", "sdp": "v=0\nm=audio 9 RTP/AVP 0\n"},
        {"transport": "webrtc", "sdp": "x" * 131073},
        {"transport": "aoq", "sdp": OFFER},
    ],
)
def test_invalid_transport_offer_does_not_allocate(direct, body):
    assert direct[0].post(URL, {**PAIR, **body}, format="json").status_code == 400
    direct[1].assert_not_called()


@pytest.mark.parametrize(
    "answer",
    [
        b"not-sdp",
        b"v=0\nm=video 9 RTP/AVP 96\n",
        b"v=0\nm=audio 9 RTP/AVP 0\n",
        b"x" * 131073,
    ],
    ids=["invalid", "missing-audio", "missing-data", "oversized"],
)
def test_webrtc_rejects_malformed_or_oversized_answer(direct, answer):
    direct[2].iter_content.return_value = [answer]
    assert (
        direct[0]
        .post(URL, {**PAIR, "transport": "webrtc", "sdp": OFFER}, format="json")
        .status_code
        == 502
    )


def test_language_detection_uses_rendered_backend_template(direct):

    client, post, _ = direct
    prompt = AIPrompt.objects.get(code="translation.language_detection")
    prompt.content = "Only {source_language} or {target_language}; unknown otherwise."
    prompt.save()
    response = client.post(
        URL, {**PAIR, "purpose": "language_detection"}, format="json"
    )
    assert response.status_code == 200
    assert response.data["instructions"] == "Only zh or en; unknown otherwise."
    post.reset_mock()
    prompt.is_active = False
    prompt.save()
    assert (
        client.post(
            URL, {**PAIR, "purpose": "language_detection"}, format="json"
        ).status_code
        == 503
    )
    post.assert_not_called()
