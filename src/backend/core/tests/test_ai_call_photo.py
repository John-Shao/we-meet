"""Photo inference is ephemeral and owned by a live call, with bounded JPEG inputs."""

import base64
import io
from datetime import timedelta
from unittest import mock

from django.core.cache import cache
from django.utils import timezone

import pytest
from PIL import Image
from rest_framework.test import APIClient

from core import models
from core.factories import UserFactory
from core.services.llm_client import LLMUnavailable

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/ai-call/photo/"


@pytest.fixture
def photo_setup():
    cache.clear()
    user = UserFactory()
    client = APIClient()
    client.force_authenticate(user)
    lease = models.DirectAIAllocation.objects.create(
        user=user,
        model="qwen3.8-omni-flash-realtime",
        transport="aoq",
        status="active",
        lease_until=timezone.now() + timedelta(minutes=2),
    )
    image = io.BytesIO()
    Image.new("RGB", (32, 24), "red").save(image, format="JPEG")
    body = {
        "session_id": str(lease.pk),
        "question": "What color is this?",
        "image": base64.b64encode(image.getvalue()).decode(),
    }
    with mock.patch("core.api.ai_call_photo.LLMClient.from_settings") as factory:
        factory.return_value.chat.return_value = "Red."
        yield client, lease, body, factory


def test_photo_sends_exact_image_and_question_and_keeps_inputs_out_of_usage(
    photo_setup,
):
    client, _, body, factory = photo_setup
    response = client.post(URL, body, format="json")
    assert response.status_code == 200
    assert response.data == {"answer": "Red."}
    assert response["Cache-Control"] == "no-store"
    kwargs = factory.return_value.chat.call_args.kwargs
    assert kwargs["user"] == [
        {"type": "text", "text": body["question"]},
        {
            "type": "image_url",
            "image_url": {"url": "data:image/jpeg;base64," + body["image"]},
        },
    ]
    assert kwargs["system"] == models.AIPrompt.objects.get(code="call.photo_qa").content
    factory.assert_called_once_with(timeout=25, max_retries=0, model="qwen3.8-flash")
    factory.return_value.close.assert_called_once()


@pytest.mark.parametrize("state", ["other_user", "closed", "expired", "other_model"])
def test_photo_rejects_unowned_or_inactive_calls_before_inference(photo_setup, state):
    client, lease, body, factory = photo_setup
    if state == "other_user":
        lease.user = UserFactory()
    elif state == "closed":
        lease.status = "released"
    elif state == "expired":
        lease.lease_until = timezone.now() - timedelta(seconds=1)
    else:
        lease.model = "different-model"
    lease.save()
    assert client.post(URL, body, format="json").status_code == 409
    factory.assert_not_called()


@pytest.mark.parametrize(
    "image",
    [
        "",
        "not-base64",
        "https://example.com/photo.jpg",
        base64.b64encode(b"not a JPEG").decode(),
        base64.b64encode(b"x" * 512_001).decode(),
    ],
    ids=["empty", "base64", "url", "invalid-jpeg", "oversized"],
)
def test_photo_rejects_malformed_or_oversized_images(photo_setup, image):
    client, _, body, factory = photo_setup
    assert client.post(URL, {**body, "image": image}, format="json").status_code == 400
    factory.assert_not_called()


@pytest.mark.parametrize(
    "format_,size", [("PNG", (10, 10)), ("JPEG", (1922, 10)), ("JPEG", (1500, 1500))]
)
def test_photo_bounds_decoded_format_and_dimensions(photo_setup, format_, size):
    client, _, body, factory = photo_setup
    stream = io.BytesIO()
    Image.new("RGB", size, "red").save(stream, format=format_)
    body["image"] = base64.b64encode(stream.getvalue()).decode()
    assert client.post(URL, body, format="json").status_code == 400
    factory.assert_not_called()


@pytest.mark.parametrize(
    "failure,status",
    [
        (LLMUnavailable("private provider error"), 503),
        (RuntimeError("private photo payload"), 502),
    ],
)
def test_provider_errors_are_sanitized_and_client_closed(photo_setup, failure, status):
    client, _, body, factory = photo_setup
    factory.return_value.chat.side_effect = failure
    response = client.post(URL, body, format="json")
    assert response.status_code == status
    assert "private" not in str(response.data)
    assert body["image"] not in str(response.data)
    factory.return_value.close.assert_called_once()


def test_hangup_during_inference_discards_late_answer(photo_setup):
    client, lease, body, factory = photo_setup

    def infer(**_):
        lease.status = "released"
        lease.save()
        return "late answer"

    factory.return_value.chat.side_effect = infer
    response = client.post(URL, body, format="json")
    assert response.status_code == 409
    assert "late answer" not in str(response.data)


def test_disabled_managed_prompt_never_calls_provider(photo_setup):
    client, _, body, factory = photo_setup
    models.AIPrompt.objects.filter(code="call.photo_qa").update(is_active=False)
    assert client.post(URL, body, format="json").status_code == 503
    factory.assert_not_called()


def test_authentication_is_required(photo_setup):
    _, _, body, factory = photo_setup
    assert APIClient().post(URL, body, format="json").status_code == 401
    factory.assert_not_called()
