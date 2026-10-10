"""Direct AI call signalling never exposes credentials or creates meeting rooms."""

import json
from unittest import mock

from django.core.cache import cache

import pytest
import requests
from rest_framework.test import APIClient

from core import models
from core.factories import UserFactory

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/ai-call/session/"
SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"


def test_photo_capability_resolves_managed_prompts_before_allocation(call_setup):
    client, profile, post, _ = call_setup
    body = {"sdp": SDP, "profile_code": profile.code, "photo_qa": True}
    response = client.post(URL, body, format="json")
    assert response.status_code == 200
    assert response.data["tool_instructions"]["photo"] == models.AIPrompt.objects.get(code="call.tool.photo").content
    assert response.data["tool_instructions"]["take_photo_description"]
    post.reset_mock()
    models.AIPrompt.objects.filter(code="call.photo_qa").update(is_active=False)
    assert client.post(URL, body, format="json").status_code == 503
    post.assert_not_called()


def test_aoq_allocation_uses_temporary_credentials(call_setup):
    """AOQ shares catalog authorization but returns only connection credentials."""
    client, profile, post, upstream = call_setup
    allocation = {
        "sid": "test-session",
        "aoqTokenForClient": "temporary-token",
        "clientRelayCertFingerprint": "sha256/test-fingerprint",
        "clientRelayEndpoints": [{"endpoint": "192.0.2.1", "port": 8443}],
        "extraInfo": {"workspaceIdHash": "test-workspace"},
        "unexpected_secret": "must-not-be-returned",
    }
    upstream.iter_content.return_value = [json.dumps(allocation).encode()]
    response = client.post(
        URL, {"transport": "aoq", "profile_code": profile.code}, format="json"
    )
    assert response.status_code == 200
    assert response.data["aoq"]["aoqTokenForClient"] == "temporary-token"
    assert response.data["aoq"]["workspaceIdHash"] == "test-workspace"
    assert "sdp" not in response.data
    assert "must-not-be-returned" not in str(response.data)
    assert "test-provider-key" not in str(response.data)
    assert response["Cache-Control"] == "no-store"
    _, kwargs = post.call_args
    assert kwargs["headers"]["x-dashscope-rtc-transport"] == "moq"
    assert kwargs["headers"]["Content-Type"] == "application/json"
    assert kwargs["params"]["model"] == "qwen3.8-omni-flash-realtime"
    assert kwargs["data"] == b"{}"
    assert not kwargs["allow_redirects"]


def test_allocation_limit_rejects_before_another_paid_session(call_setup, settings):
    settings.DIRECT_AI_MAX_ACTIVE_ALLOCATIONS = 1
    client, profile, post, _ = call_setup
    body = {"sdp": SDP, "profile_code": profile.code}
    response = client.post(URL, body, format="json")
    assert response.status_code == 200
    assert response.data["session_lease"]["enforce"] is True
    assert client.post(URL, body, format="json").status_code == 429
    post.assert_called_once()


@pytest.mark.parametrize(
    "allocation", ["not-json", "null", "{}", '{"clientRelayEndpoints": []}']
)
def test_invalid_aoq_allocation_is_rejected(call_setup, allocation):
    client, profile, _, upstream = call_setup
    upstream.iter_content.return_value = [allocation.encode()]
    response = client.post(
        URL, {"transport": "aoq", "profile_code": profile.code}, format="json"
    )
    assert response.status_code == 502


@pytest.mark.parametrize("body", [{"transport": "unknown"}, {"transport": "webrtc"}])
def test_invalid_transport_or_missing_offer_is_rejected(call_setup, body):
    client, profile, post, _ = call_setup
    response = client.post(URL, {"profile_code": profile.code, **body}, format="json")
    assert response.status_code == 400
    post.assert_not_called()


@pytest.fixture
def call_setup(settings):
    """Configure test credentials and an active Qwen 3.8 catalog profile."""
    cache.clear()
    settings.DASHSCOPE_API_KEY = "test-provider-key"
    settings.DASHSCOPE_WORKSPACE_ID = "llm-test"
    settings.DASHSCOPE_REGION = "cn-beijing"
    vendor, _ = models.AIVendor.objects.get_or_create(
        code="aliyun", defaults={"display_name": "Aliyun"}
    )
    model, _ = models.AIModel.objects.update_or_create(
        code="aliyun/qwen3.8-omni-flash-realtime",
        vendor=vendor,
        capability="omni",
        defaults={"display_name": "Qwen 3.8", "is_active": True},
    )
    voice, _ = models.AIVoice.objects.update_or_create(
        model=model,
        value="Tina",
        defaults={"label": "Tina", "is_active": True},
    )
    profile = models.AIAgentProfile.objects.create(
        code="test-direct-call",
        display_name="Call",
        architecture="omni",
        omni_model=model,
        default_voice=voice,
    )
    client = APIClient()
    client.force_authenticate(UserFactory())
    with mock.patch("core.api.ai_call.provider_http.request") as post:
        upstream = post.return_value.__enter__.return_value
        upstream.status_code = 200
        upstream.iter_content.return_value = [SDP.encode()]
        yield client, profile, post, upstream


@pytest.mark.parametrize("video", [False, True])
def test_authenticated_offer_uses_same_fixed_model_without_rooms(call_setup, video):
    """Audio and camera calls negotiate the same model; credentials stay server-side."""
    client, profile, post, _ = call_setup
    offer = SDP + ("m=video 9 UDP/TLS/RTP/SAVPF 96\r\n" if video else "")
    room_count = models.Room.objects.count()
    response = client.post(
        URL, {"sdp": offer, "profile_code": profile.code}, format="json"
    )
    assert response.status_code == 200
    assert response.data["sdp"] == SDP
    assert response.data["voice"] == "Tina"
    assert "test-provider-key" not in str(response.data)
    assert response["Cache-Control"] == "no-store"
    assert models.Room.objects.count() == room_count
    args, kwargs = post.call_args
    assert (
        args[1]
        == "https://llm-test.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime"
    )
    assert kwargs["params"] == {"model": "qwen3.8-omni-flash-realtime"}
    assert kwargs["headers"]["Authorization"] == "Bearer test-provider-key"
    assert kwargs["data"] == offer.encode()
    assert not kwargs["allow_redirects"]


def test_anonymous_cannot_create_provider_session(call_setup):
    """The public catalog does not imply public access to paid sessions."""
    _, profile, post, _ = call_setup
    response = APIClient().post(
        URL, {"sdp": SDP, "profile_code": profile.code}, format="json"
    )
    assert response.status_code in (401, 403)
    post.assert_not_called()


@pytest.mark.parametrize(
    "field,value",
    [
        ("sdp", "not SDP"),
        ("sdp", "v=0\n" + "x" * 131072),
        ("voice_id", "not-a-uuid"),
        ("profile_code", "doubao"),
    ],
    ids=["invalid-sdp", "oversized-sdp", "invalid-voice", "wrong-profile"],
)
def test_invalid_requests_do_not_reach_provider(call_setup, field, value):
    """Invalid input and unapproved profiles are rejected before SDP exchange."""
    client, profile, post, _ = call_setup
    body = {"sdp": SDP, "profile_code": profile.code, field: value}
    response = client.post(URL, body, format="json")
    assert response.status_code == 400
    post.assert_not_called()


def test_voice_from_another_model_cannot_cross_into_call(call_setup):
    """Cached selections from older providers fall back to the profile default."""
    client, profile, _, _ = call_setup
    other = models.AIModel.objects.create(
        vendor=profile.omni_model.vendor,
        capability="tts",
        code="test/other",
        display_name="Other",
    )
    voice = models.AIVoice.objects.create(model=other, value="Other", label="Other")
    response = client.post(
        URL,
        {"sdp": SDP, "profile_code": profile.code, "voice_id": str(voice.id)},
        format="json",
    )
    assert response.status_code == 200
    assert response.data["voice"] == "Tina"


def test_disabled_model_cannot_open_call(call_setup):
    """Admin disabling a model prevents new direct calls."""
    client, profile, post, _ = call_setup
    models.AIModel.objects.filter(id=profile.omni_model_id).update(is_active=False)
    response = client.post(
        URL, {"sdp": SDP, "profile_code": profile.code}, format="json"
    )
    assert response.status_code == 400
    post.assert_not_called()


def test_missing_workspace_does_not_attempt_connection(call_setup, settings):
    """A malformed backend endpoint setting fails locally."""
    client, profile, post, _ = call_setup
    settings.DASHSCOPE_WORKSPACE_ID = "invalid.example/path"
    response = client.post(
        URL, {"sdp": SDP, "profile_code": profile.code}, format="json"
    )
    assert response.status_code == 503
    post.assert_not_called()


@pytest.mark.parametrize("status", [302, 401, 429, 500])
def test_provider_error_body_is_never_exposed(call_setup, status):
    """Redirects and provider failures return a generic application error."""
    client, profile, _, upstream = call_setup
    upstream.status_code = status
    upstream.text = "sensitive-provider-error"
    response = client.post(
        URL, {"sdp": SDP, "profile_code": profile.code}, format="json"
    )
    assert response.status_code == 502
    assert "sensitive-provider-error" not in str(response.data)


def test_timeout_returns_controlled_error(call_setup):
    """Provider timeouts do not crash the endpoint."""
    client, profile, post, _ = call_setup
    post.side_effect = requests.Timeout("sensitive-provider-error")
    response = client.post(
        URL, {"sdp": SDP, "profile_code": profile.code}, format="json"
    )
    assert response.status_code == 502


def test_repeated_session_creation_is_throttled(call_setup):
    """Session setup is rate-limited even with a valid account."""
    client, profile, post, _ = call_setup
    for _ in range(6):
        assert (
            client.post(
                URL, {"sdp": SDP, "profile_code": profile.code}, format="json"
            ).status_code
            == 200
        )
    assert (
        client.post(
            URL, {"sdp": SDP, "profile_code": profile.code}, format="json"
        ).status_code
        == 429
    )
    assert post.call_count == 6


def test_selected_voice_prompt_and_region_are_used(call_setup, settings):
    """Selections from the shared catalog configure the direct connection."""
    client, profile, post, _ = call_setup
    settings.DASHSCOPE_REGION = "ap-southeast-1"
    voice, _ = models.AIVoice.objects.update_or_create(
        model_id=profile.omni_model_id,
        value="Ryan",
        defaults={"label": "Ryan", "is_active": True},
    )
    prompt = models.AIPrompt.objects.create(
        label="Direct call test", content="Be concise."
    )
    response = client.post(
        URL,
        {
            "sdp": SDP,
            "profile_code": profile.code,
            "voice_id": str(voice.id),
            "prompt_id": str(prompt.id),
        },
        format="json",
    )
    assert response.status_code == 200
    assert response.data["voice"] == "Ryan"
    assert response.data["instructions"] == "Be concise."
    assert "llm-test.ap-southeast-1.maas.aliyuncs.com" in post.call_args.args[1]


@pytest.mark.parametrize(
    "answer", [b"not SDP", b"v=0\n" + b"x" * 131072], ids=["invalid", "oversized"]
)
def test_provider_answer_is_validated(call_setup, answer):
    """Do not hand malformed or unbounded provider responses to native WebRTC."""
    client, profile, _, upstream = call_setup
    upstream.iter_content.return_value = [answer]
    response = client.post(
        URL, {"sdp": SDP, "profile_code": profile.code}, format="json"
    )
    assert response.status_code == 502


@pytest.mark.parametrize("selected", [False, True])
def test_backend_prompt_edits_are_used_without_client_overrides(call_setup, selected):
    client, profile, post, _ = call_setup
    default = models.AIPrompt.objects.get(code="call.default")
    default.content = "Edited default"
    default.save()
    scene = models.AIPrompt.objects.get(code="call.scene.practice")
    scene.content = "Edited practice"
    scene.save()
    camera = models.AIPrompt.objects.get(code="call.tool.camera")
    camera.content = "Edited camera rules"
    camera.save()
    body = {"sdp": SDP, "profile_code": profile.code}
    if selected:
        body["prompt_id"] = str(scene.id)
    response = client.post(URL, body, format="json")
    assert response.status_code == 200
    assert response.data["instructions"] == (
        "Edited practice" if selected else "Edited default"
    )
    assert response.data["tool_instructions"]["camera"] == "Edited camera rules"
    assert "end_call" in response.data["tool_instructions"]["end_call"]


def test_system_prompt_cannot_be_selected_as_scene_and_disabled_rules_block_allocation(
    call_setup,
):
    client, profile, post, _ = call_setup
    system = models.AIPrompt.objects.get(code="translation.language_detection")
    response = client.post(
        URL,
        {"sdp": SDP, "profile_code": profile.code, "prompt_id": str(system.id)},
        format="json",
    )
    assert response.status_code == 200
    assert (
        response.data["instructions"]
        == models.AIPrompt.objects.get(code="call.default").content
    )
    post.reset_mock()
    models.AIPrompt.objects.filter(code="call.tool.camera").update(is_active=False)
    assert (
        client.post(
            URL, {"sdp": SDP, "profile_code": profile.code}, format="json"
        ).status_code
        == 503
    )
    post.assert_not_called()
