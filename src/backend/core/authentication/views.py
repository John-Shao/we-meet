"""OIDC views that advance the Work Bearer-plane auth epoch.

The repo advances the epoch at the view layer rather than via signals (the same
convention ``User.save`` follows). Each hook only adds an atomic epoch bump around
the upstream lasuite behaviour; the OIDC flow itself is unchanged.

Scope (§1.1 trigger matrix): login, logout, account switch (the callback's
fresh-login branch) and Keycloak back-channel logout are wired here. The
back-channel hook is the receiver for the Keycloak-originated triggers — session
revocation, password/credential change and admin revocation — which Keycloak
delivers as a back-channel logout token. Whether Keycloak actually emits those
tokens depends on the client's ``backchannelLogout`` switch and logout URL, which
are a production Keycloak configuration step (see :mod:`core.authentication.epochs`).
"""

from lasuite.oidc_login.views import (
    OIDCAuthenticationCallbackView,
    OIDCBackChannelLogoutView,
    OIDCLogoutCallbackView,
    OIDCLogoutView,
)

from core.authentication.epochs import bump_auth_epoch, bump_auth_epoch_by_sub


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


class WorkOIDCBackChannelLogoutView(OIDCBackChannelLogoutView):
    """Bump the Bearer-plane epoch on a Keycloak back-channel logout.

    This is the receiver for the §1.1 triggers that originate in Keycloak —
    session revocation, password/credential change and admin revocation — which
    Keycloak delivers as a server-to-server logout token. The parent validates the
    token (signature, iss/aud/exp, events claim, no nonce, jti replay) before
    calling ``logout_user_sessions``; the bump therefore only fires for a valid,
    non-replayed token.

    The epoch advances by ``sub`` regardless of whether any Django session was
    deleted: a desktop-only Bearer user may hold no Django session at all, yet
    every Bearer device session/lease/permit they hold must still be invalidated.
    A token carrying only ``sid`` (no ``sub``) cannot be mapped to a user epoch and
    is left to the parent's session cleanup.
    """

    def logout_user_sessions(self, sub, sid=None):
        if sub:
            bump_auth_epoch_by_sub(sub=sub)
        return super().logout_user_sessions(sub, sid)