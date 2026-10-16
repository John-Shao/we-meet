"""Retired translation transports never allocate another paid provider connection."""

from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.models import DirectAIAllocation

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/assistant-translation/session/"


@pytest.mark.parametrize("transport", ["aoq", "webrtc"])
def test_direct_translation_requires_upgrade_without_upstream_request(transport):
    client = APIClient()
    client.force_authenticate(UserFactory())
    with patch("core.services.provider_http.request") as upstream:
        response = client.post(
            URL,
            {"source_language": "zh", "target_language": "en", "transport": transport},
            format="json",
        )
    assert response.status_code == 426
    assert response.data["code"] == "client_upgrade_required"
    assert response.data["protocol_version"] == 2
    upstream.assert_not_called()
    assert not DirectAIAllocation.objects.exists()


def test_retired_endpoint_still_requires_authentication():
    assert APIClient().post(URL, {}, format="json").status_code in (401, 403)
