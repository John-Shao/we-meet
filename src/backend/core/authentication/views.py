"""OIDC login/logout views that advance the Work Bearer-plane auth epoch.

The repo advances the epoch at the view layer rather than via signals (the same
convention ``User.save`` follows). Each hook only adds an atomic epoch bump around
the upstream lasuite behaviour; the OIDC flow itself is unchanged.

Scope (§1.1 trigger matrix): login and logout only. Keycloak back-channel session
revocation, credential change, admin revocation and account switch are a documented
follow-up gap — see :mod:`core.authentication.epochs`.
"""

from lasuite.oidc_login.views import (
    OIDCAuthenticationCallbackView,
    OIDCLogoutCallbackView,
    OIDCLogoutView,
)

from core.authentication.epochs import bump_auth_epoch


class WorkOIDCAuthenticationCallbackView(OIDCAuthenticationCallbackView):
    """Bump the auth epoch on a genuine login, not on a silent session refresh."""

    def login_success(self):
        # Mirror the upstream condition for calling auth.login: a callback that
        # re-authenticates the already-signed-in user is a session refresh, not a
        # new login, and must not invalidate the user's Bearer device sessions.
        request_user = getattr(self.request, "user", None)
        fresh_login = (
            not request_user
            or not request_user.is_authenticated
            or request_user != self.user
        )
        response = super().login_success()
        if fresh_login:
            bump_auth_epoch(user_id=self.user.pk)
        return response


class WorkOIDCLogoutView(OIDCLogoutView):
    """Bump the auth epoch when the user signs out."""

    def post(self, request):
        if request.user.is_authenticated:
            bump_auth_epoch(user_id=request.user.pk)
        return super().post(request)


class WorkOIDCLogoutCallbackView(OIDCLogoutCallbackView):
    """Bump the auth epoch on the OP logout callback (final Django logout)."""

    def get(self, request):
        if request.user.is_authenticated:
            bump_auth_epoch(user_id=request.user.pk)
        return super().get(request)