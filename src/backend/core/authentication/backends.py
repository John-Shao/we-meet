"""Authentication Backends for the Meet core app."""

import contextlib
import logging

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured, SuspiciousOperation
from django.utils.translation import gettext_lazy as _

from lasuite.oidc_login.backends import (
    OIDCAuthenticationBackend as LaSuiteOIDCAuthenticationBackend,
)

from core.models import Membership, MembershipStatusChoices, Organization, User
from core.services.invitation_provisioning import claim_pending_invitations
from core.services.keycloak_phone import sync_user_phone
from core.services.marketing import (
    ContactCreationError,
    ContactData,
    get_marketing_service,
)

logger = logging.getLogger(__name__)


class OIDCAuthenticationBackend(LaSuiteOIDCAuthenticationBackend):
    """Custom OpenID Connect (OIDC) Authentication Backend.

    This class overrides the default OIDC Authentication Backend to accommodate differences
    in the User and Identity models, and handles signed and/or encrypted UserInfo response.
    """

    def get_extra_claims(self, user_info):
        """
        Return extra claims from user_info.

        Args:
          user_info (dict): The user information dictionary.

        Returns:
          dict: A dictionary of extra claims.

        """
        return {
            # Get user's full name from OIDC fields defined in settings
            "full_name": self.compute_full_name(user_info),
            "short_name": user_info.get(settings.OIDC_USERINFO_SHORTNAME_FIELD),
        }

    def post_get_or_create_user(self, user, claims, is_new_user):
        """
        Post-processing after user creation or retrieval.

        Args:
          user (User): The user instance.
          claims (dict): The claims dictionary.
          is_new_user (bool): Indicates if the user was newly created.

        Returns:
        - None

        """
        email = claims["email"]
        if is_new_user and email and settings.SIGNUP_NEW_USER_TO_MARKETING_EMAIL:
            self.signup_to_marketing_email(email)
        # P3: mirror Keycloak phoneNumber → User.phone (idempotent, self-healing
        # on every login). Best-effort inside the service; never blocks sign-in.
        #
        # Ordering is load-bearing (P10 M2-g): this used to run last, which meant
        # `user.phone` was still empty while invitations were being claimed. A
        # phone invitation could therefore never match on a first login — the one
        # login it exists for — and `ensure_default_org_membership` below would
        # then hand out a plain membership that makes every later attempt skip it.
        # Moving it up adds no round-trip; the same call already happened, later.
        sync_user_phone(user)
        # Pre-provisioning: a pending invitation places the user into the invited
        # department / role before ensure_default_org_membership falls back to a
        # plain org-level membership. Best-effort — never break login over it.
        try:
            claim_pending_invitations(user, phone=claims.get("phone_number"))
        except Exception:  # noqa: BLE001 — provisioning must not block sign-in
            logger.exception(
                "Failed to claim pending invitations for user %s", user.pk
            )
        self.ensure_default_org_membership(user)

    @staticmethod
    def ensure_default_org_membership(user):
        """Make sure every authenticated user belongs to the default organization.

        The P1-b data migration bootstrapped memberships for users that existed
        at migration time; this covers everyone who signs in afterwards. Called
        on every login (not just new users) so it also self-heals accounts that
        ended up without a membership. Idempotent and safe.
        """
        if user.is_device or not user.sub:
            return
        slug = getattr(settings, "ORGANIZATION_BOOTSTRAP_SLUG", "default")
        organization = Organization.objects.filter(slug=slug, is_active=True).first()
        if organization is None:
            return
        # P10 M4: an organization can turn auto-join off and admit people through
        # invite links instead. Absent key = True, so nothing changes for anyone
        # who has not opted in.
        #
        # ⚠️ Turning it off only stops the membership being *created*. It does
        # not make the rest of the product behave sensibly for a signed-in
        # person with no membership — org-scoped pages will simply come back
        # empty rather than explaining themselves, and IM and meetings, which
        # are not org-scoped, keep working. Designing that half-open state is
        # explicitly out of M4's scope (see docs/phases/p10b-invitation-system.md
        # §三); do not read the existence of this switch as "real admission
        # control is supported".
        if (organization.settings or {}).get("auto_join_enabled", True) is False:
            return
        if Membership.objects.filter(user=user, organization=organization).exists():
            return
        Membership.objects.create(
            organization=organization,
            user=user,
            department=None,
            is_primary=True,
            status=MembershipStatusChoices.ACTIVE,
        )

    @staticmethod
    def signup_to_marketing_email(email):
        """Pragmatic approach to newsletter signup during authentication flow.

        Details:
        1. Uses a very short timeout (1s) to prevent blocking the auth process
        2. Silently fails if the marketing service is down/slow to prioritize user experience
        3. Trade-off: May miss some signups but ensures auth flow remains fast

        Note: For a more robust solution, consider using Async task processing (Celery/Django-Q)
        """
        with contextlib.suppress(
            ContactCreationError, ImproperlyConfigured, ImportError
        ):
            marketing_service = get_marketing_service()
            contact_data = ContactData(
                email=email, attributes={"VISIO_SOURCE": ["SIGNIN"]}
            )
            marketing_service.create_contact(
                contact_data, timeout=settings.BREVO_API_TIMEOUT
            )

    def get_existing_user(self, sub, email):
        """Fetch existing user by sub or email."""
        try:
            return User.objects.get(sub=sub)
        except User.DoesNotExist:
            if email and settings.OIDC_FALLBACK_TO_EMAIL_FOR_IDENTIFICATION:
                try:
                    return User.objects.get(email__iexact=email)
                except User.DoesNotExist:
                    pass
                except User.MultipleObjectsReturned as e:
                    raise SuspiciousOperation(
                        "Multiple user accounts share a common email."
                    ) from e
        return None
