"""Work Bearer-plane auth epoch (control-design §1.1).

The desktop shell authenticates to Work with its native Keycloak access token.
Work's ``session_revision`` for that plane is this per-user persistent counter,
NOT a value derived from the token: the shell refreshes its token every ~30s and
a token-derived revision would invalidate every pairing/ticket/proof mid-cycle.

The Host advances the epoch on login and logout so that logging out (or switching
account) invalidates every Bearer device session, lease and unconsumed permit the
user holds. The cookie plane keeps its own session-key-hash revision; the two are
namespaced by ``auth_plane`` and never satisfy each other.

Scope note (§1.1 trigger matrix): this module currently covers login/logout only.
The remaining revocation triggers — Keycloak back-channel session revocation,
password/credential change, admin revocation and account switch — are a documented
follow-up gap ("撤销不到"): until they also advance the epoch, those events do not
yet invalidate Bearer sessions.
"""

from django.db.models import F

from core.models import User


def bump_auth_epoch(*, user_id) -> None:
    """Atomically advance one user's Bearer-plane auth epoch by one.

    A single ``UPDATE ... SET auth_epoch = auth_epoch + 1`` is race-free across
    workers without a row lock or a read-modify-write. Callers that need the new
    value re-read the row; the login/logout hooks do not.
    """
    User.objects.filter(pk=user_id).update(auth_epoch=F("auth_epoch") + 1)


def bump_auth_epoch_by_sub(*, sub) -> None:
    """Advance the epoch for the user with this OIDC ``sub`` (Keycloak user id).

    Used by the native Bearer login (mobile OTP), which knows the Keycloak subject
    but not the Django primary key. Best-effort: a brand-new user whose Django row
    is created lazily on first API call has no row yet, so this is a no-op and the
    epoch starts at 0 on creation — correct for a first login, which has no prior
    Bearer sessions to invalidate.
    """
    if not sub:
        return
    User.objects.filter(sub=sub).update(auth_epoch=F("auth_epoch") + 1)