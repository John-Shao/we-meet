"""Host Bearer access verification wire (control-design §1.1 plane (b), §2.2)."""

import json
from datetime import datetime, timedelta, timezone
from unittest import mock

from django.test import override_settings

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from rest_framework import exceptions

from core import models
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
    OIDC_OP_URL="https://idp.example.test",
    WORK_HOST_BEARER_AUDIENCE="desktop",
)


@pytest.fixture
def bearer_jwt(monkeypatch):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": "test-key", "alg": "RS256", "use": "sig"})
    client = mock.Mock()
    client.get_signing_key_from_jwt.return_value = jwt.PyJWK(jwk)
    monkeypatch.setattr(
        "core.api.work_host._work_bearer_jwk_client", lambda endpoint: client
    )

    def issue(subject="subject-bearer", *, key=None, drop=(), **overrides):
        now = datetime.now(timezone.utc)
        claims = {
            "sub": subject,
            "iss": "https://idp.example.test",
            "aud": "desktop",
            "iat": now,
            "exp": now + timedelta(minutes=5),
        }
        claims.update(overrides)
        for field in drop:
            claims.pop(field, None)
        return jwt.encode(
            claims,
            key or private_key,
            algorithm="RS256",
            headers={"kid": "test-key"},
        )

    return {"issue": issue, "wrong_key": wrong_key, "client": client}


def _authenticate(user):
    """Patch the OIDC Bearer verifier to resolve ``user`` for any token."""
    patcher = mock.patch("core.api.work_host.OIDCAuthentication")
    mock_auth = patcher.start()
    mock_auth.return_value.authenticate.return_value = (user, "native-token")
    return patcher


@MTLS
def test_returns_verified_bearer(client, bearer_jwt):
    user = UserFactory(sub="subject-bearer", auth_epoch=7)
    organization = OrganizationFactory()
    MembershipFactory(user=user, organization=organization, is_primary=True)
    token = bearer_jwt["issue"](user.sub)

    patcher = _authenticate(user)
    try:
        response = client.post(
            URL,
            HTTP_AUTHORIZATION=f"Bearer {token}",
            **cert_headers(CLIENT_PEM),
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
    assert "permissions" not in data
    assert "Set-Cookie" not in response.headers


@MTLS
def test_optional_permissions_include_work_assignment(client, bearer_jwt):
    user = UserFactory(sub="subject-permissions")
    organization = OrganizationFactory()
    MembershipFactory(user=user, organization=organization, is_primary=True)
    models.WorkGovernanceAssignment.objects.create(
        organization=organization,
        user=user,
        permissions=["org.work.seat.write"],
        revision=1,
    )
    token = bearer_jwt["issue"](user.sub)

    patcher = _authenticate(user)
    try:
        response = client.post(
            f"{URL}?include_permissions=1",
            HTTP_AUTHORIZATION=f"Bearer {token}",
            **cert_headers(CLIENT_PEM),
        )
    finally:
        patcher.stop()

    assert response.status_code == 200
    assert response.json()["permissions"] == ["org.work.seat.write"]


@MTLS
def test_session_revision_tracks_auth_epoch(client, bearer_jwt):
    user = UserFactory(sub="subject-epoch", auth_epoch=0)
    MembershipFactory(user=user, organization=OrganizationFactory(), is_primary=True)
    token = bearer_jwt["issue"](user.sub)

    patcher = _authenticate(user)
    try:
        first = client.post(
            URL, HTTP_AUTHORIZATION=f"Bearer {token}", **cert_headers(CLIENT_PEM)
        )
        user.auth_epoch = 42
        user.save(update_fields=["auth_epoch"])
        second = client.post(
            URL, HTTP_AUTHORIZATION=f"Bearer {token}", **cert_headers(CLIENT_PEM)
        )
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
        response = client.post(URL, HTTP_AUTHORIZATION="Bearer native-token", **headers)
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
def test_rejects_invalid_token(client, bearer_jwt):
    token = bearer_jwt["issue"](key=bearer_jwt["wrong_key"])
    response = client.post(
        URL, HTTP_AUTHORIZATION=f"Bearer {token}", **cert_headers(CLIENT_PEM)
    )

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@MTLS
def test_verifier_outage_is_service_unavailable(client, bearer_jwt, caplog):
    sensitive_detail = "upstream response: bearer-secret-sentinel"
    token = bearer_jwt["issue"]()
    bearer_jwt[
        "client"
    ].get_signing_key_from_jwt.side_effect = jwt.PyJWKClientConnectionError(
        sensitive_detail
    )
    response = client.post(
        URL, HTTP_AUTHORIZATION=f"Bearer {token}", **cert_headers(CLIENT_PEM)
    )

    assert response.status_code == 503
    assert response.json() == {"code": "service_unavailable"}
    records = [
        record for record in caplog.records if record.name == "core.api.work_host"
    ]
    assert len(records) == 1
    assert records[0].getMessage() == "Work bearer token verification failed"
    assert records[0].exc_info is None
    assert sensitive_detail not in caplog.text


@MTLS
def test_rejects_inactive_user(client, bearer_jwt):
    user = UserFactory(sub="subject-inactive", is_active=False)
    token = bearer_jwt["issue"](user.sub)
    patcher = _authenticate(user)
    try:
        response = client.post(
            URL, HTTP_AUTHORIZATION=f"Bearer {token}", **cert_headers(CLIENT_PEM)
        )
    finally:
        patcher.stop()

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@MTLS
def test_rejects_missing_subject(client, bearer_jwt):
    # §2.2(b): no fallback to user.id — a user without a readable sub is refused.
    user = UserFactory(sub=None)
    token = bearer_jwt["issue"]("subject-unreadable")
    patcher = _authenticate(user)
    try:
        response = client.post(
            URL, HTTP_AUTHORIZATION=f"Bearer {token}", **cert_headers(CLIENT_PEM)
        )
    finally:
        patcher.stop()

    assert response.status_code == 401
    assert response.json() == {"code": "subject_unreadable"}


@MTLS
def test_rejects_user_without_organization(client, bearer_jwt):
    user = UserFactory(sub="subject-no-org")
    token = bearer_jwt["issue"](user.sub)
    patcher = _authenticate(user)
    try:
        response = client.post(
            URL, HTTP_AUTHORIZATION=f"Bearer {token}", **cert_headers(CLIENT_PEM)
        )
    finally:
        patcher.stop()

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@MTLS
@pytest.mark.parametrize(
    "case",
    ["expired", "wrong_audience", "wrong_issuer", "missing_exp", "bad_signature"],
)
def test_rejects_invalid_jwt_claims_before_userinfo(client, bearer_jwt, case):
    now = datetime.now(timezone.utc)
    token = bearer_jwt["issue"](
        key=bearer_jwt["wrong_key"] if case == "bad_signature" else None,
        drop=("exp",) if case == "missing_exp" else (),
        **(
            {"exp": now - timedelta(minutes=1)}
            if case == "expired"
            else {"aud": "another-client"}
            if case == "wrong_audience"
            else {"iss": "https://other-idp.example.test"}
            if case == "wrong_issuer"
            else {}
        ),
    )
    with mock.patch("core.api.work_host.OIDCAuthentication") as authentication:
        response = client.post(
            URL,
            HTTP_AUTHORIZATION=f"Bearer {token}",
            **cert_headers(CLIENT_PEM),
        )

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}
    authentication.return_value.authenticate.assert_not_called()


@MTLS
def test_rejects_token_userinfo_subject_mismatch(client, bearer_jwt):
    user = UserFactory(sub="subject-userinfo")
    token = bearer_jwt["issue"]("subject-token")
    patcher = _authenticate(user)
    try:
        response = client.post(
            URL,
            HTTP_AUTHORIZATION=f"Bearer {token}",
            **cert_headers(CLIENT_PEM),
        )
    finally:
        patcher.stop()

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@MTLS
@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (exceptions.AuthenticationFailed("revoked"), 401, "session_invalid"),
        (RuntimeError("userinfo unavailable"), 503, "service_unavailable"),
    ],
)
def test_valid_jwt_still_requires_userinfo_acceptance(
    client, bearer_jwt, error, status, code
):
    token = bearer_jwt["issue"]()
    with mock.patch("core.api.work_host.OIDCAuthentication") as authentication:
        authentication.return_value.authenticate.side_effect = error
        response = client.post(
            URL,
            HTTP_AUTHORIZATION=f"Bearer {token}",
            **cert_headers(CLIENT_PEM),
        )

    assert response.status_code == status
    assert response.json() == {"code": code}


@MTLS
def test_rejects_unknown_signing_key(client, bearer_jwt):
    token = bearer_jwt["issue"]()
    bearer_jwt["client"].get_signing_key_from_jwt.side_effect = jwt.PyJWKClientError(
        'Unable to find a signing key that matches: "unknown"'
    )
    response = client.post(
        URL, HTTP_AUTHORIZATION=f"Bearer {token}", **cert_headers(CLIENT_PEM)
    )

    assert response.status_code == 401
    assert response.json() == {"code": "session_invalid"}


@MTLS
def test_missing_jwt_configuration_fails_closed(client, bearer_jwt):
    token = bearer_jwt["issue"]()
    with override_settings(OIDC_OP_URL=None):
        response = client.post(
            URL,
            HTTP_AUTHORIZATION=f"Bearer {token}",
            **cert_headers(CLIENT_PEM),
        )

    assert response.status_code == 503
    assert response.json() == {"code": "service_unavailable"}


@MTLS
def test_rejects_get(client, bearer_jwt):
    user = UserFactory(sub="subject-get")
    token = bearer_jwt["issue"](user.sub)
    patcher = _authenticate(user)
    try:
        response = client.get(
            URL, HTTP_AUTHORIZATION=f"Bearer {token}", **cert_headers(CLIENT_PEM)
        )
    finally:
        patcher.stop()

    assert response.status_code == 405
