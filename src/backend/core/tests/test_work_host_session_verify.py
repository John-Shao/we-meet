"""Host session verification wire (HW-01/HW-04/HW-05)."""

from urllib.parse import quote

from django.conf import settings
from django.test import override_settings

import pytest

from core.api.work_host import session_revision
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.tests.host_mtls import (
    CA_PEM,
    CLIENT_PEM,
    EXPIRED_PEM,
    IDENTITY,
    OTHER_CN_PEM,
    WRONG_CA_CLIENT_PEM,
    cert_headers,
)

pytestmark = pytest.mark.django_db

URL = "/work-host/v2/sessions/verify"


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_returns_verified_session(client):
    user = UserFactory(sub="subject-1")
    organization = OrganizationFactory()
    MembershipFactory(user=user, organization=organization, is_primary=True)
    client.force_login(user)
    session_key = client.session.session_key

    response = client.post(URL, **cert_headers(CLIENT_PEM))

    assert response.status_code == 200
    data = response.json()
    assert data["subject_id"] == "subject-1"
    assert data["org_id"] == str(organization.id)
    assert data["session_revision"] == session_revision(session_key)
    assert data["verified_at"].endswith("Z")
    assert "cookie" not in data


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
@pytest.mark.parametrize(
    "headers",
    [
        {},
        cert_headers(WRONG_CA_CLIENT_PEM),
        cert_headers(OTHER_CN_PEM),
        cert_headers(EXPIRED_PEM),
        {"HTTP_SSL_CLIENT_CERT": quote("not-a-certificate")},
    ],
)
def test_rejects_invalid_client_certificate(client, headers):
    user = UserFactory(sub="subject-identity")
    MembershipFactory(user=user, organization=OrganizationFactory())
    client.force_login(user)

    response = client.post(URL, **headers)

    assert response.status_code == 403
    assert response.json() == {"code": "client_identity_invalid"}


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_rejects_duplicate_session_cookie(client):
    user = UserFactory(sub="subject-duplicate")
    MembershipFactory(user=user, organization=OrganizationFactory())
    client.force_login(user)
    session_key = client.session.session_key

    response = client.post(
        URL,
        HTTP_COOKIE=f"{settings.SESSION_COOKIE_NAME}=first; "
        f"{settings.SESSION_COOKIE_NAME}={session_key}",
        **cert_headers(CLIENT_PEM),
    )

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_ignores_body_org_and_subject(client):
    user = UserFactory(sub="subject-body")
    organization = OrganizationFactory()
    MembershipFactory(user=user, organization=organization)
    client.force_login(user)

    response = client.post(
        URL,
        data='{"org_id": "other-org", "subject_id": "other-subject"}',
        content_type="application/json",
        **cert_headers(CLIENT_PEM),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["org_id"] == str(organization.id)
    assert payload["subject_id"] == "subject-body"


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_rejects_missing_authenticated_session(client):
    response = client.post(URL, **cert_headers(CLIENT_PEM))
    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_rejects_user_without_organization(client):
    user = UserFactory(sub="subject-no-org")
    client.force_login(user)

    response = client.post(URL, **cert_headers(CLIENT_PEM))

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_rejects_inactive_user(client):
    user = UserFactory(sub="subject-inactive", is_active=False)
    MembershipFactory(user=user, organization=OrganizationFactory())
    client.force_login(user)

    response = client.post(URL, **cert_headers(CLIENT_PEM))

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_rejects_get(client):
    user = UserFactory(sub="subject-get")
    MembershipFactory(user=user, organization=OrganizationFactory())
    client.force_login(user)

    response = client.get(URL, **cert_headers(CLIENT_PEM))

    assert response.status_code == 405


def test_session_revision_is_stable_non_negative_and_rotates():
    first = session_revision("session-key-a")
    assert first == session_revision("session-key-a")
    assert first >= 0
    assert first != session_revision("session-key-b")
    assert first.bit_length() <= 63
