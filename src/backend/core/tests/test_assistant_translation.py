"""Authenticated single-use tickets for standalone automatic bilingual translation."""

import json
from unittest.mock import patch

from django.core.cache import cache

import pytest
from rest_framework.test import APIClient

from core.api.assistant_translation import LANGUAGES
from core.factories import UserFactory

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/assistant-translation/ticket/"
CLAIM = "/api/agent/assistant-translation/claim/"
PAIR = {"source_language": "zh", "target_language": "en", "protocol_version": 2}


@pytest.fixture
def setup(settings):
    cache.clear()
    settings.ASSISTANT_TRANSLATION_ENABLED = True
    settings.MEETING_CAPTURE_TRANSLATION_URL = "wss://meet.example/capture-translation"
    settings.AGENT_INTERNAL_API_TOKEN = "test-internal"
    client = APIClient()
    user = UserFactory()
    client.force_authenticate(user)
    agent = APIClient()
    agent.credentials(HTTP_X_AGENT_TOKEN="test-internal")
    return client, agent, user


def test_ticket_claimed_once_without_provider_credentials(setup):
    client, agent, _ = setup
    result = client.post(URL, PAIR, format="json")
    assert result.status_code == 200
    assert set(result.data) == {"url", "ticket", "protocol_version"}
    assert result["Cache-Control"] == "no-store"
    body = {"ticket": result.data["ticket"]}
    claim = agent.post(CLAIM, body, format="json")
    assert claim.status_code == 200
    assert all(claim.data[key] == value for key, value in PAIR.items())
    assert claim.data["voice"] == "Tina"
    assert claim.data["session_id"]
    assert agent.post(CLAIM, body, format="json").status_code == 403


@pytest.mark.parametrize("language", LANGUAGES)
def test_all_speech_languages_survive_ticket_and_claim(setup, language):
    client, agent, _ = setup
    pair = {
        "protocol_version": 2,
        "source_language": language,
        "target_language": "en" if language != "en" else "zh",
    }
    result = client.post(URL, pair, format="json")
    assert result.status_code == 200
    claim = agent.post(CLAIM, {"ticket": result.data["ticket"]}, format="json")
    assert claim.status_code == 200
    assert all(claim.data[key] == value for key, value in pair.items())


@pytest.mark.parametrize(
    "language",
    "yue el af ast be bg bn bs ca ceb et gl gu hr hu jv kk kn ky lv mk ml mr pa ro sk sl sw tg az uk".split(),
)
def test_text_only_languages_cannot_be_selected_on_either_side(setup, language):
    for source, target in ((language, "en"), ("en", language)):
        pair = {
            "source_language": source,
            "target_language": target,
            "protocol_version": 2,
        }
        assert (
            setup[0]
            .post(URL, {**pair, "protocol_version": 2}, format="json")
            .status_code
            == 400
        )


def test_anonymous_and_regular_users_cannot_claim(setup):
    client, _, _ = setup
    assert APIClient().post(URL, PAIR, format="json").status_code in (401, 403)
    ticket = client.post(URL, PAIR, format="json").data["ticket"]
    assert client.post(CLAIM, {"ticket": ticket}, format="json").status_code in (
        401,
        403,
    )


@pytest.mark.parametrize("body", [[], [2], "invalid", 2, None])
def test_non_object_ticket_body_is_rejected(setup, body):
    """Malformed JSON must not raise an unhandled attribute error."""
    response = setup[0].post(URL, json.dumps(body), content_type="application/json")
    assert response.status_code == 400


@pytest.mark.parametrize(
    "pair",
    [
        {"source_language": "zh", "target_language": "zh"},
        {"source_language": "zh", "target_language": "xx"},
    ],
)
def test_invalid_pair_rejected(setup, pair):
    assert (
        setup[0].post(URL, {**pair, "protocol_version": 2}, format="json").status_code
        == 400
    )


def test_expired_ticket_rejected(setup):
    client, agent, _ = setup
    with patch("django.core.signing.time.time", return_value=1):
        ticket = client.post(URL, PAIR, format="json").data["ticket"]
    assert agent.post(CLAIM, {"ticket": ticket}, format="json").status_code == 403


def test_disabled_user_cannot_claim_existing_ticket(setup):
    client, agent, user = setup
    ticket = client.post(URL, PAIR, format="json").data["ticket"]
    user.is_active = False
    user.save()
    assert agent.post(CLAIM, {"ticket": ticket}, format="json").status_code == 403


@pytest.mark.parametrize(
    "url",
    [
        "ws://example/capture-translation",
        "wss://u:p@example/capture-translation",
        "wss://example/capture-translation?token=secret",
    ],
)
def test_unsafe_gateway_not_advertised(setup, settings, url):
    settings.MEETING_CAPTURE_TRANSLATION_URL = url
    assert setup[0].post(URL, PAIR, format="json").status_code == 503
