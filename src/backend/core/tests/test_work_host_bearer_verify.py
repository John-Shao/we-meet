"""Host Bearer access verification wire (control-design §1.1 plane (b), §2.2)."""

from unittest import mock

from django.test import override_settings

import pytest
from requests.exceptions import HTTPError
from rest_framework import exceptions

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

URL = "/work-host/v3/sessions/verify"
# A dummy JWKS endpoint lets the OIDC backend initialise in tests; it is never
# fetched when no Bearer token is present (get_access_token returns None first).
MTLS = override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM,
    WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY,
    OIDC_OP_JWKS_ENDPOINT="https://idp.example.test/jwks",
)


def _authenticate(user):
    """Patch the OIDC Bearer verifier to resolve ``user`` for any token."""
    patcher = mock.patch("core.api.work_host.OIDCAuthentication")
    mock_auth = patcher.start()
    mock_auth.return_value.authenticate.return_value = (user, "native-token")
    return patcher


@MTLS
def test_returns_verified_bearer(client):
    user = UserFactory(sub="subject-bearer", auth_epoch=7)
    organization = OrganizationFactory()
    MembershipFactory(user=user, organization=organization, is_primary=True)

    patcher = _authenticate(user)
    try:
        response = client.post(
            URL, HTTP_AUTHORIZATION="Bearer native-token", **cert_headers(CLIENT_PEM)
        )
    finally:
        patcher.stop()

    assert response.status_code == 200
    data = response.json()
    assert data["subject_id"] == "subject-bearer"
    assert data["org_id"] == str(organization.id)
    # Bearer plane session_revision is the persistent auth_epoch, not a session hash.
    assert data["session_revision"] == 7
    assert data["verified_at"].endswith("Z")
    assert "cookie" not in data


@MTLS
def test_session_revision_tracks_auth_epoch(client):
    user = UserFactory(sub="subject-epoch", auth_epoch=0)
    MembershipFactory(user=user, organization=OrganizationFactory(), is_primary=True)

    patcher = _authenticate(user)
    try:
        first = client.post(URL, HTTP_AUTHORIZATION="Bearer t", **cert_headers(CLIENT_PEM))
        user.auth_epoch = 42
        user.save(update_fields=["auth_epoch"])
        second = client.post(URL, HTTP_AUTHORIZATION="Bearer t", **cert_headers(CLIENT_PEM))
    finally:
        patcher.stop()

    assert first.json()["session_revision"] == 0
    assert second.json()["session_revision"] == 42


@MTLS
@pytest.mark.parametrize(
    "headers",
    [
        {},
        cert_headers(WRONG_CA_CLIENT_PEM),
        cert_headers(OTHER_CN_PEM),
        cert_headers(EXPIRED_PEM),
    ],
)
def test_rejects_invalid_client_certificate(client, headers):
    user = UserFactory(sub="subject-mtls")
    MembershipFactory(user=user, organization=OrganizationFactory())

    patcher = _authenticate(user)
    try:
        response = client.post(
            URL, HTTP_AUTHORIZATION="Bearer native-token", **headers
        )
    finally:
        patcher.stop()

    assert response.status_code == 403
    assert response.json() == {"code": "client_identity_invalid"}


@MTLS
def test_mtls_checked_before_token(client):
    # No Authorization header at all: a bad workload cert must still yield 403,
    # proving the mTLS boundary precedes any user-credential read.
    response = client.post(URL, **cert_headers(OTHER_CN_PEM))
    assert response.status_code == 403
    assert response.json() == {"code": "client_identity_invalid"}


@MTLS
def test_rejects_missing_bearer(client):
    user = UserFactory(sub="subject-no-token")
    MembershipFactory(user=user, organization=OrganizationFactory())

    # Real verifier, no Authorization header → no credential → 401.
    response = client.post(URL, **cert_headers(CLIENT_PEM))
    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@MTLS
def test_cookie_session_cannot_satisfy_bearer(client):
    user = UserFactory(sub="subject-cookie")
    MembershipFactory(user=user, organization=OrganizationFactory())
    client.force_login(user)

    # A cookie session exists but no Bearer token: the port must refuse it.
    response = client.post(URL, **cert_headers(CLIENT_PEM))
    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@MTLS
def test_rejects_invalid_token(client):
    patcher = mock.patch("core.api.work_host.OIDCAuthentication")
    mock_auth = patcher.start()
    mock_auth.return_value.authenticate.side_effect = exceptions.AuthenticationFailed(
        "bad token"
    )
    try:
        response = client.post(
            URL, HTTP_AUTHORIZATION="Bearer bad", **cert_headers(CLIENT_PEM)
        )
    finally:
        patcher.stop()

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@MTLS
def test_verifier_outage_is_service_unavailable(client):
    patcher = mock.patch("core.api.work_host.OIDCAuthentication")
    mock_auth = patcher.start()
    mock_auth.return_value.authenticate.side_effect = HTTPError("keycloak down")
    try:
        response = client.post(
            URL, HTTP_AUTHORIZATION="Bearer t", **cert_headers(CLIENT_PEM)
        )
    finally:
        patcher.stop()

    assert response.status_code == 503
    assert response.json() == {"code": "service_unavailable"}


@MTLS
def test_rejects_inactive_user(client):
    user = UserFactory(sub="subject-inactive", is_active=False)
    patcher = _authenticate(user)
    try:
        response = client.post(
            URL, HTTP_AUTHORIZATION="Bearer t", **cert_headers(CLIENT_PEM)
        )
    finally:
        patcher.stop()

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@MTLS
def test_rejects_missing_subject(client):
    # §2.2(b): no fallback to user.id — a user without a readable sub is refused.
    user = UserFactory(sub=None)
    patcher = _authenticate(user)
    try:
        response = client.post(
            URL, HTTP_AUTHORIZATION="Bearer t", **cert_headers(CLIENT_PEM)
        )
    finally:
        patcher.stop()

    assert response.status_code == 401
    assert response.json() == {"code": "subject_unreadable"}


@MTLS
def test_rejects_user_without_organization(client):
    user = UserFactory(sub="subject-no-org")
    patcher = _authenticate(user)
    try:
        response = client.post(
            URL, HTTP_AUTHORIZATION="Bearer t", **cert_headers(CLIENT_PEM)
        )
    finally:
        patcher.stop()

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@MTLS
def test_rejects_get(client):
    user = UserFactory(sub="subject-get")
    patcher = _authenticate(user)
    try:
        response = client.get(URL, **cert_headers(CLIENT_PEM))
    finally:
        patcher.stop()

    assert response.status_code == 405