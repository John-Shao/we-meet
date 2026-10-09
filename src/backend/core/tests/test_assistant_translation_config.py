import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.models import AIModel, AIVoice

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/assistant-translation/config/"


def test_translation_catalog_is_model_scoped_and_admin_managed():
    client = APIClient()
    client.force_authenticate(UserFactory())
    model = AIModel.objects.get(code="aliyun/qwen3.8-livetranslate-flash-realtime")
    assert model.voices.count() == 47
    assert not model.voices.filter(value="Zane").exists()
    model.voices.update(is_active=False)
    voice = AIVoice.objects.create(
        model=model, value="FutureVoice", label="New voice", sort_order=1
    )
    model.extra_config = {"default_voice": voice.value, "private": "never-return"}
    model.save()
    response = client.get(URL)
    assert response.status_code == 200
    assert response.data == {
        "model": "qwen3.8-livetranslate-flash-realtime",
        "default_voice": "FutureVoice",
        "voices": [{"value": "FutureVoice", "label": "New voice"}],
    }
    assert response["Cache-Control"] == "no-store"
    voice.is_active = False
    voice.save()
    assert client.get(URL).data["voices"] == []
    assert client.get(URL).data["default_voice"] is None


@pytest.mark.parametrize("invalid_default", ["Zane", ["Tina"], {"voice": "Tina"}])
def test_default_falls_back_to_active_voice_and_disabled_model_is_empty(
    invalid_default,
):
    client = APIClient()
    client.force_authenticate(UserFactory())
    model = AIModel.objects.get(code="aliyun/qwen3.8-livetranslate-flash-realtime")
    model.extra_config = {"default_voice": invalid_default}
    model.save()
    assert client.get(URL).data["default_voice"] == "Tina"
    model.voices.filter(value="Tina").update(is_active=False)
    assert (
        client.get(URL).data["default_voice"]
        == client.get(URL).data["voices"][0]["value"]
    )
    model.is_active = False
    model.save()
    assert client.get(URL).data["voices"] == []


def test_catalog_requires_authentication():
    assert APIClient().get(URL).status_code in (401, 403)
