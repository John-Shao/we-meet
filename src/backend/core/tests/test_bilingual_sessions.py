"""Business-session quotas and revocation are independent of provider connections."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from django.db import close_old_connections
from django.utils import timezone

import pytest
from rest_framework.exceptions import Throttled
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.models import BilingualSession
from core.services import bilingual_sessions

pytestmark = pytest.mark.django_db
TICKET = "/api/v1.0/assistant-translation/ticket/"
CLAIM = "/api/agent/assistant-translation/claim/"
LEASE = "/api/agent/assistant-translation/lease/"
REQUEST = {"source_language": "ja", "target_language": "fr", "protocol_version": 2}


@pytest.fixture
def admission(settings):
    settings.ASSISTANT_TRANSLATION_ENABLED = True
    settings.MEETING_CAPTURE_TRANSLATION_URL = "wss://meet.example/capture-translation"
    settings.AGENT_INTERNAL_API_TOKEN = "test-internal"
    user = UserFactory()
    client = APIClient()
    client.force_authenticate(user)
    agent = APIClient()
    agent.credentials(HTTP_X_AGENT_TOKEN="test-internal")
    return user, client, agent


def start(client, agent, **choices):
    ticket = client.post(TICKET, {**REQUEST, **choices}, format="json")
    assert ticket.status_code == 200
    response = agent.post(CLAIM, {"ticket": ticket.data["ticket"]}, format="json")
    assert response.status_code == 200
    return response.data


def test_fixed_direction_and_voice_are_frozen_in_single_business_session(admission):
    user, client, agent = admission
    grant = start(client, agent, fixed_source="fr", voice="Ethan")
    assert grant["fixed_source"] == "fr"
    assert grant["voice"] == "Ethan"
    assert grant["max_seconds"] == 900
    assert 890 <= grant["remaining_seconds"] <= 900
    assert grant["idle_seconds"] == 300
    assert BilingualSession.objects.filter(user=user, status="active").count() == 1
    assert client.post(TICKET, REQUEST, format="json").status_code == 429
    assert (
        agent.post(
            LEASE,
            {"session_id": grant["session_id"], "operation": "close"},
            format="json",
        ).data["status"]
        == "closed"
    )
    assert client.post(TICKET, REQUEST, format="json").status_code == 200


def test_client_cannot_renew_gateway_session(admission):
    _, client, agent = admission
    grant = start(client, agent)
    body = {"session_id": grant["session_id"], "operation": "heartbeat"}
    assert client.post(LEASE, body, format="json").status_code in (401, 403)
    assert agent.post(LEASE, body, format="json").data["status"] == "active"


@pytest.mark.parametrize(
    "condition", ["deadline", "lease", "disabled_user", "disabled_feature", "closed"]
)
def test_expired_or_revoked_session_never_revives(admission, settings, condition):
    user, client, agent = admission
    grant = start(client, agent)
    row = BilingualSession.objects.get(pk=grant["session_id"])
    if condition in ("deadline", "lease"):
        field = "deadline" if condition == "deadline" else "lease_until"
        BilingualSession.objects.filter(pk=row.pk).update(
            **{field: timezone.now() - timedelta(seconds=1)}
        )
    elif condition == "disabled_user":
        user.is_active = False
        user.save()
    elif condition == "disabled_feature":
        settings.ASSISTANT_TRANSLATION_ENABLED = False
    else:
        bilingual_sessions.update(row.pk, "close")
    body = {"session_id": str(row.pk), "operation": "heartbeat"}
    assert agent.post(LEASE, body, format="json").data["status"] == "expired"
    settings.ASSISTANT_TRANSLATION_ENABLED = True
    assert agent.post(LEASE, body, format="json").data["status"] == "expired"


def test_daily_quota_counts_sessions_after_close(admission, settings):
    _, client, agent = admission
    settings.ASSISTANT_TRANSLATION_MAX_DAILY = 1
    grant = start(client, agent)
    bilingual_sessions.update(grant["session_id"], "close")
    assert client.post(TICKET, REQUEST, format="json").status_code == 429


@pytest.mark.parametrize(
    "setting", ["ASSISTANT_TRANSLATION_MAX_ACTIVE", "ASSISTANT_TRANSLATION_MAX_DAILY"]
)
def test_zero_quota_fails_closed(admission, settings, setting):
    setattr(settings, setting, 0)
    assert admission[1].post(TICKET, REQUEST, format="json").status_code == 403
    assert not BilingualSession.objects.exists()


def test_legacy_client_gets_upgrade_without_reserving_or_opening_provider(admission):
    _, client, _ = admission
    assert (
        client.post(
            TICKET, {"source_language": "zh", "target_language": "en"}, format="json"
        ).status_code
        == 426
    )
    assert not BilingualSession.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_admission_cannot_exceed_one_session(admission):
    user, _, _ = admission

    def reserve():
        close_old_connections()
        try:
            return str(bilingual_sessions.reserve(user).pk)
        except Throttled:
            return None
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: reserve(), range(2)))
    assert sum(result is not None for result in results) == 1
    assert BilingualSession.objects.filter(user=user, status="issued").count() == 1
