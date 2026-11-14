"""Work Bearer-plane auth epoch counter and login/logout hooks (§1.1)."""

from unittest import mock

from django.contrib.auth.models import AnonymousUser
from django.http import HttpResponseRedirect
from django.test import RequestFactory, override_settings

import pytest

from core.authentication.epochs import bump_auth_epoch, bump_auth_epoch_by_sub
from core.authentication.views import (
    WorkOIDCAuthenticationCallbackView,
    WorkOIDCLogoutCallbackView,
    WorkOIDCLogoutView,
)
from core.factories import UserFactory

pytestmark = pytest.mark.django_db


def test_auth_epoch_defaults_to_zero():
    assert UserFactory().auth_epoch == 0


def test_bump_auth_epoch_is_monotonic():
    user = UserFactory(auth_epoch=0)
    bump_auth_epoch(user_id=user.pk)
    user.refresh_from_db()
    assert user.auth_epoch == 1
    bump_auth_epoch(user_id=user.pk)
    user.refresh_from_db()
    assert user.auth_epoch == 2


def test_bump_auth_epoch_by_sub():
    user = UserFactory(sub="subject-epoch", auth_epoch=5)
    bump_auth_epoch_by_sub(sub="subject-epoch")
    user.refresh_from_db()
    assert user.auth_epoch == 6
    # Unknown subject is a no-op (first login before the Django row exists).
    bump_auth_epoch_by_sub(sub="does-not-exist")
    bump_auth_epoch_by_sub(sub="")
    user.refresh_from_db()
    assert user.auth_epoch == 6


def _callback_view(user, request_user):
    view = WorkOIDCAuthenticationCallbackView()
    view.request = RequestFactory().get("/callback/")
    view.request.user = request_user
    view.user = user
    return view


def test_login_callback_bumps_on_fresh_login():
    user = UserFactory(auth_epoch=0)
    view = _callback_view(user, AnonymousUser())
    with mock.patch(
        "core.authentication.views.OIDCAuthenticationCallbackView.login_success",
        return_value=HttpResponseRedirect("/"),
    ):
        view.login_success()
    user.refresh_from_db()
    assert user.auth_epoch == 1


def test_login_callback_does_not_bump_on_session_refresh():
    user = UserFactory(auth_epoch=3)
    # The callback re-authenticates the already-signed-in user: a refresh, not a
    # new login, so the Bearer epoch must stay put.
    view = _callback_view(user, user)
    with mock.patch(
        "core.authentication.views.OIDCAuthenticationCallbackView.login_success",
        return_value=HttpResponseRedirect("/"),
    ):
        view.login_success()
    user.refresh_from_db()
    assert user.auth_epoch == 3


def test_logout_bumps():
    user = UserFactory(auth_epoch=3)
    view = WorkOIDCLogoutView()
    request = RequestFactory().post("/logout/")
    request.user = user
    with mock.patch(
        "core.authentication.views.OIDCLogoutView.post",
        return_value=HttpResponseRedirect("/"),
    ):
        view.post(request)
    user.refresh_from_db()
    assert user.auth_epoch == 4


def test_logout_callback_bumps():
    user = UserFactory(auth_epoch=0)
    view = WorkOIDCLogoutCallbackView()
    request = RequestFactory().get("/logout-callback/")
    request.user = user
    with mock.patch(
        "core.authentication.views.OIDCLogoutCallbackView.get",
        return_value=HttpResponseRedirect("/"),
    ):
        view.get(request)
    user.refresh_from_db()
    assert user.auth_epoch == 1


def test_anonymous_logout_does_not_bump():
    user = UserFactory(auth_epoch=2)
    view = WorkOIDCLogoutView()
    request = RequestFactory().post("/logout/")
    request.user = AnonymousUser()
    with mock.patch(
        "core.authentication.views.OIDCLogoutView.post",
        return_value=HttpResponseRedirect("/"),
    ):
        view.post(request)
    user.refresh_from_db()
    assert user.auth_epoch == 2


@override_settings(
    MOBILE_AUTH_OTP_EXPIRY=600,
    OIDC_OP_JWKS_ENDPOINT="https://idp.example.test/jwks",
)
def test_native_otp_login_bumps_epoch(client):
    user = UserFactory(sub="kc-user-id", auth_epoch=0)
    with (
        mock.patch(
            "core.api.mobile_auth._validate_otp", return_value=(True, None, None)
        ),
        mock.patch(
            "core.api.mobile_auth._get_service_account_token", return_value="sa-token"
        ),
        mock.patch(
            "core.api.mobile_auth._find_or_create_keycloak_user",
            return_value="kc-user-id",
        ),
        mock.patch(
            "core.api.mobile_auth._token_exchange",
            return_value={
                "access_token": "a",
                "refresh_token": "r",
                "token_type": "Bearer",
                "expires_in": 300,
            },
        ),
    ):
        response = client.post(
            "/api/mobile/auth/verify-otp/",
            {"phone": "13800000000", "otp": "123456"},
            content_type="application/json",
        )
    assert response.status_code == 200
    user.refresh_from_db()
    assert user.auth_epoch == 1