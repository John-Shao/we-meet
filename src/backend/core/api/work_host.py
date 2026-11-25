"""Internal Host endpoints for Work identity verification and governance events.

The endpoints are reached through the meet ingress with client-certificate
verification. The ingress passes the verified client certificate as
``ssl-client-cert``; these views verify that certificate against
``WORK_HOST_MTLS_CA_PEM`` and require the configured workload identity.
The backend must not be reachable directly from workloads that are not the
Work control plane. Session responses contain no cookie, CSRF token or
Work-domain data; the governance port is read-only and returns no content.
"""

import base64
import hashlib
import logging
import os
import re
import urllib.parse
import uuid
from datetime import datetime, timezone
from functools import lru_cache

from django.conf import settings
from django.db import transaction
from django.http import JsonResponse
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

import jwt
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID
from mozilla_django_oidc.contrib.drf import OIDCAuthentication
from rest_framework import exceptions

from core.api.directory import get_caller_organization
from core.models import (
    Membership,
    MembershipStatusChoices,
    Organization,
    WorkGovernanceEvent,
    WorkGovernanceSequence,
)

logger = logging.getLogger(__name__)

CLIENT_CERT_HEADER = "Ssl-Client-Cert"
MEMBER_ROLE_MAP = {
    "owner": "owner",
    "administrator": "admin",
    "dept_admin": "member",
    "member": "member",
}
SUBJECT_PATTERN = re.compile(r"^[A-Za-z0-9_.:@-]{1,128}$")
REGION_PATTERN = re.compile(r"^[a-z0-9-]{3,64}$")
DEFAULT_LIMIT = 50
MAX_LIMIT = 100


def session_revision(session_key: str) -> int:
    """Stable per-session revision; rotates when Django rotates the session key."""
    digest = hashlib.sha256(session_key.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") & 0x7FFFFFFFFFFFFFFF


def _ca_pem() -> str:
    return getattr(settings, "WORK_HOST_MTLS_CA_PEM", "") or os.environ.get(
        "WORK_HOST_MTLS_CA_PEM", ""
    )


def _expected_identity() -> str:
    return (
        getattr(settings, "WORK_HOST_MTLS_CLIENT_IDENTITY", "")
        or os.environ.get("WORK_HOST_MTLS_CLIENT_IDENTITY", "")
        or "work-control-plane"
    )


def _verify_client_certificate(request, expected_identity=None) -> bool:
    raw = request.headers.get(CLIENT_CERT_HEADER) or request.META.get(
        "HTTP_SSL_CLIENT_CERT"
    )
    ca_pem = _ca_pem()
    if not raw or not ca_pem:
        return False
    try:
        client = x509.load_pem_x509_certificate(
            urllib.parse.unquote(raw).encode("utf-8")
        )
        ca = x509.load_pem_x509_certificate(ca_pem.encode("utf-8"))
    except ValueError:
        return False

    return (
        _certificates_are_current(ca, client)
        and client.issuer == ca.subject
        and _signature_is_valid(ca, client)
        and _client_auth_is_allowed(client)
        and _common_name_is_expected(client, expected_identity)
    )


def _certificates_are_current(ca, client) -> bool:
    now = datetime.now(timezone.utc)
    return (
        ca.not_valid_before_utc <= now <= ca.not_valid_after_utc
        and client.not_valid_before_utc <= now <= client.not_valid_after_utc
    )


def _signature_is_valid(ca, client) -> bool:
    key = ca.public_key()
    try:
        if isinstance(key, rsa.RSAPublicKey):
            key.verify(
                client.signature,
                client.tbs_certificate_bytes,
                padding.PKCS1v15(),
                client.signature_hash_algorithm,
            )
        elif isinstance(key, ec.EllipticCurvePublicKey):
            key.verify(
                client.signature,
                client.tbs_certificate_bytes,
                ec.ECDSA(client.signature_hash_algorithm),
            )
        else:
            return False
    except Exception:  # pylint: disable=broad-exception-caught  # noqa: BLE001
        # Every signature-verification failure is a denial.
        return False
    return True


def _client_auth_is_allowed(client) -> bool:
    try:
        extended = client.extensions.get_extension_for_class(
            x509.ExtendedKeyUsage
        ).value
    except x509.ExtensionNotFound:
        return False
    return ExtendedKeyUsageOID.CLIENT_AUTH in extended


def _common_name_is_expected(client, expected_identity=None) -> bool:
    common_names = client.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
    return bool(common_names) and common_names[0].value == (
        expected_identity or _expected_identity()
    )


@lru_cache(maxsize=4)
def _work_bearer_jwk_client(endpoint):
    return jwt.PyJWKClient(endpoint, timeout=settings.OIDC_TIMEOUT)


def _verified_bearer_claims(request):
    authorization = request.META.get("HTTP_AUTHORIZATION", "")
    scheme, separator, token = authorization.partition(" ")
    if (
        not separator
        or scheme.lower() != "bearer"
        or not token
        or any(character.isspace() for character in token)
    ):
        raise exceptions.AuthenticationFailed("Invalid Bearer authorization header")

    issuer = (settings.OIDC_OP_URL or "").strip()
    audience = (settings.WORK_HOST_BEARER_AUDIENCE or "").strip()
    jwks_endpoint = (settings.OIDC_OP_JWKS_ENDPOINT or "").strip()
    algorithm = settings.OIDC_RP_SIGN_ALGO
    if (
        not issuer
        or not audience
        or not jwks_endpoint
        or algorithm not in {"RS256", "RS384", "RS512", "ES256", "ES384", "ES512"}
    ):
        raise RuntimeError("Work Bearer JWT verification is not configured")

    try:
        signing_key = _work_bearer_jwk_client(jwks_endpoint).get_signing_key_from_jwt(
            token
        )
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=[algorithm],
            audience=audience,
            issuer=issuer,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
    except jwt.PyJWKClientConnectionError as error:
        raise RuntimeError("Work Bearer JWKS is unavailable") from error
    except jwt.PyJWKClientError as error:
        if "Unable to find a signing key" in str(error):
            raise exceptions.AuthenticationFailed(
                "Unknown Bearer signing key"
            ) from error
        raise RuntimeError("Work Bearer JWKS is invalid") from error
    except jwt.InvalidTokenError as error:
        raise exceptions.AuthenticationFailed("Invalid Bearer token") from error

    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject:
        raise exceptions.AuthenticationFailed("Bearer token has no subject")
    return claims


@method_decorator(csrf_exempt, name="dispatch")
@method_decorator(never_cache, name="dispatch")
@method_decorator(require_POST, name="dispatch")
class WorkHostSessionVerifyView(View):
    """Verify a Host session for the Work control plane over workload mTLS."""

    def post(self, request):
        """Return the verified identity or a fail-closed error."""
        if not _verify_client_certificate(request):
            return JsonResponse({"code": "client_identity_invalid"}, status=403)

        cookie_name = settings.SESSION_COOKIE_NAME
        raw_cookies = request.META.get("HTTP_COOKIE", "")
        if len(re.findall(rf"(?:^|;\s*){re.escape(cookie_name)}=", raw_cookies)) != 1:
            return JsonResponse({"code": "session_invalid"}, status=401)

        user = getattr(request, "user", None)
        if (
            user is None
            or not getattr(user, "is_authenticated", False)
            or not getattr(user, "is_active", False)
        ):
            return JsonResponse({"code": "session_invalid"}, status=401)

        session_key = getattr(request.session, "session_key", None)
        if not session_key:
            return JsonResponse({"code": "session_invalid"}, status=401)

        organization = get_caller_organization(user)
        if organization is None:
            return JsonResponse({"code": "session_invalid"}, status=401)

        subject_id = getattr(user, "sub", None) or str(user.id)
        verified_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return JsonResponse(
            {
                "subject_id": subject_id,
                "org_id": str(organization.id),
                "session_revision": session_revision(session_key),
                "verified_at": verified_at.replace("+00:00", "Z"),
            }
        )


@method_decorator(csrf_exempt, name="dispatch")
@method_decorator(never_cache, name="dispatch")
@method_decorator(require_POST, name="dispatch")
class WorkHostBearerVerifyView(View):
    """Verify a desktop native Bearer token for the Work control plane (v3).

    Bearer-plane sibling of :class:`WorkHostSessionVerifyView` (control-design
    §1.1 plane (b), §2.2): the same workload mTLS boundary, but the end-user
    credential is the shell's native Keycloak access token — verified by the same
    OIDC resource-server path ``/api/`` uses — not a Django session cookie. A
    cookie can never satisfy this port and the returned ``session_revision`` is
    the user's persistent ``auth_epoch``, never the cookie plane's session-key
    hash. Work neither parses the token nor caches the claims.
    """

    def post(self, request):  # noqa: PLR0911  # pylint: disable=too-many-return-statements
        """Return the verified Bearer identity or a fail-closed error."""
        # Workload identity first, exactly like the cookie port: a caller that is
        # not the Work control plane is refused before any user credential reads.
        if not _verify_client_certificate(request):
            return JsonResponse({"code": "client_identity_invalid"}, status=403)

        try:
            token_claims = _verified_bearer_claims(request)
            result = OIDCAuthentication().authenticate(request)
        except exceptions.AuthenticationFailed:
            return JsonResponse({"code": "session_invalid"}, status=401)
        except Exception:  # pylint: disable=broad-exception-caught  # noqa: BLE001
            # Keycloak unreachable / unexpected verifier failure is a service
            # degradation, not a user-auth rejection: fail closed as 503.
            logger.error("Work bearer token verification failed")
            return JsonResponse({"code": "service_unavailable"}, status=503)
        if result is None:
            return JsonResponse({"code": "session_invalid"}, status=401)
        user, _token = result
        if not getattr(user, "is_active", False):
            return JsonResponse({"code": "session_invalid"}, status=401)

        # §2.2(b): the subject must be the directory's user.sub. Never fall back to
        # user.id (the cookie port does), which would mint a subject the directory
        # cannot contain and split one user across two identities.
        subject_id = (getattr(user, "sub", None) or "").strip()
        if not SUBJECT_PATTERN.fullmatch(subject_id):
            return JsonResponse({"code": "subject_unreadable"}, status=401)
        if token_claims["sub"] != subject_id:
            return JsonResponse({"code": "session_invalid"}, status=401)

        organization = get_caller_organization(user)
        if organization is None:
            return JsonResponse({"code": "session_invalid"}, status=401)

        verified_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return JsonResponse(
            {
                "subject_id": subject_id,
                "org_id": str(organization.id),
                "session_revision": user.auth_epoch,
                "verified_at": verified_at.replace("+00:00", "Z"),
            }
        )


def _pagination(request):
    raw_limit = request.GET.get("limit")
    try:
        limit = int(raw_limit) if raw_limit is not None else DEFAULT_LIMIT
    except (TypeError, ValueError) as error:
        raise ValueError("limit") from error
    if limit < 1 or limit > MAX_LIMIT:
        raise ValueError("limit")
    raw_cursor = request.GET.get("cursor") or ""
    if not raw_cursor:
        return None, limit
    try:
        padded = raw_cursor + "=" * (-len(raw_cursor) % 4)
        return uuid.UUID(base64.urlsafe_b64decode(padded).decode("utf-8")), limit
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("cursor") from error


def _next_cursor(values):
    return (
        base64.urlsafe_b64encode(str(values[-1]).encode("utf-8")).rstrip(b"=").decode()
    )


def _org_status(organization):
    if organization.archived_at is not None:
        return "archived"
    return "active" if organization.is_active else "suspended"


def _org_item(organization):
    gaps = []
    name = (organization.name or "").strip()
    if not name or len(name) > 128:
        gaps.append("name")
    home_region = organization.home_region or ""
    if not REGION_PATTERN.fullmatch(home_region):
        gaps.append("home_region")
    revision = organization.directory_revision
    if revision is None or revision <= 0:
        gaps.append("revision")
    return {
        "org_id": str(organization.id),
        "name": name,
        "status": _org_status(organization),
        "home_region": home_region,
        "revision": revision,
        "gaps": gaps,
    }


def _member_item(membership):
    gaps = []
    subject_id = (membership.user.sub or "").strip()
    if not SUBJECT_PATTERN.fullmatch(subject_id):
        gaps.append("subject_id")
    role = MEMBER_ROLE_MAP.get(membership.org_role)
    if role is None:
        gaps.append("role")
    revision = membership.directory_revision
    if revision is None or revision <= 0:
        gaps.append("revision")
    status = membership.status
    if status != MembershipStatusChoices.LEFT and not membership.user.is_active:
        status = "suspended"
    return {
        "subject_id": subject_id,
        "status": status,
        "role": role,
        "work_seat": membership.work_seat,
        "revision": revision,
        "gaps": gaps,
    }


def _pagination_error():
    return JsonResponse({"code": "invalid_pagination"}, status=422)


@method_decorator(never_cache, name="dispatch")
@method_decorator(require_GET, name="dispatch")
class WorkHostOrgListView(View):
    """List organizations for authoritative Work directory discovery."""

    def get(self, request):
        """Return one keyset page of organizations."""
        if not _verify_client_certificate(request):
            return JsonResponse({"code": "client_identity_invalid"}, status=403)
        try:
            cursor, limit = _pagination(request)
        except ValueError:
            return _pagination_error()

        query = Organization.objects.order_by("id")
        if cursor is not None:
            query = query.filter(id__gt=cursor)
        rows = list(query[: limit + 1])
        has_more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = (
            _next_cursor([row.id for row in rows]) if has_more and rows else None
        )
        return JsonResponse(
            {"items": [_org_item(row) for row in rows], "next_cursor": next_cursor}
        )


@method_decorator(never_cache, name="dispatch")
@method_decorator(require_GET, name="dispatch")
class WorkHostMemberListView(View):
    """List organization members for directory synchronization."""

    def get(self, request, org_id):
        """Return one keyset page of members."""
        if not _verify_client_certificate(request):
            return JsonResponse({"code": "client_identity_invalid"}, status=403)
        if not Organization.objects.filter(id=org_id).exists():
            return JsonResponse({"code": "org_not_found"}, status=404)
        try:
            cursor, limit = _pagination(request)
        except ValueError:
            return _pagination_error()
        raw_revision = request.GET.get("revision_after")
        try:
            revision_after = int(raw_revision) if raw_revision not in (None, "") else 0
        except (TypeError, ValueError):
            return _pagination_error()
        if revision_after < 0:
            return _pagination_error()

        query = (
            Membership.objects.filter(organization_id=org_id)
            .select_related("user")
            .order_by("id")
        )
        if cursor is not None:
            query = query.filter(id__gt=cursor)
        if revision_after:
            query = query.filter(directory_revision__gt=revision_after)
        rows = list(query[: limit + 1])
        has_more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = (
            _next_cursor([row.id for row in rows]) if has_more and rows else None
        )
        return JsonResponse(
            {"items": [_member_item(row) for row in rows], "next_cursor": next_cursor}
        )


def _governance_event_item(event):
    return {
        "event_seq": event.event_seq,
        "command_id": str(event.command_id),
        "kind": event.kind,
        "target_subject_id": event.target_subject_id or None,
        "desired": event.desired,
        "payload_hash": event.payload_hash,
        "member_revision": event.member_revision,
        "org_revision": event.org_revision,
        "permissions_revision": event.permissions_revision,
        "applied_at": event.applied_at.astimezone(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
    }


def _governance_cursor(request):
    raw_after = request.GET.get("after_event_seq", "0")
    raw_limit = request.GET.get("limit", str(DEFAULT_LIMIT))
    if not re.fullmatch(r"[0-9]+", raw_after) or not re.fullmatch(r"[0-9]+", raw_limit):
        raise ValueError("invalid governance cursor")
    after = int(raw_after)
    limit = int(raw_limit)
    if limit < 1 or limit > MAX_LIMIT:
        raise ValueError("invalid governance cursor")
    return after, limit


@method_decorator(never_cache, name="dispatch")
@method_decorator(require_GET, name="dispatch")
class WorkHostGovernanceEventsView(View):
    """Read one organization's immutable governance event page."""

    def get(self, request):
        """Return events and any first gap from a consistent Host snapshot."""
        try:
            org_id = uuid.UUID(request.GET.get("org_id", ""))
        except (ValueError, TypeError):
            return JsonResponse({"code": "org_not_found"}, status=404)
        expected_identity = (
            getattr(settings, "WORK_HOST_GOVERNANCE_EVENTS_IDENTITY", "")
            or "work-governance-events"
        )
        if not _verify_client_certificate(request, expected_identity):
            return JsonResponse({"code": "client_identity_invalid"}, status=403)
        if not Organization.objects.filter(id=org_id).exists():
            return JsonResponse({"code": "org_not_found"}, status=404)
        try:
            after, limit = _governance_cursor(request)
        except ValueError:
            return JsonResponse({"code": "invalid_cursor"}, status=422)

        with transaction.atomic():
            sequence = (
                WorkGovernanceSequence.objects.select_for_update()
                .filter(organization_id=org_id)
                .first()
            )
            latest = sequence.last_event_seq if sequence is not None else 0
            if after > latest:
                return JsonResponse({"code": "invalid_cursor"}, status=422)
            rows = list(
                WorkGovernanceEvent.objects.filter(
                    organization_id=org_id, event_seq__gt=after
                ).order_by("event_seq")[: limit + 1]
            )

        events = []
        expected = after + 1
        gap_from = None
        gap_to = None
        for event in rows[:limit]:
            if gap_from is None and event.event_seq != expected:
                gap_from = expected
                gap_to = event.event_seq
            events.append(_governance_event_item(event))
            expected = event.event_seq + 1
        if gap_from is None and expected <= latest and len(rows) <= limit:
            gap_from = expected
            gap_to = latest + 1

        gap = None
        if gap_from is not None:
            logger.warning(
                "Work governance event gap org=%s from=%s to=%s",
                org_id,
                gap_from,
                gap_to,
            )
            gap = {
                "from_seq": gap_from,
                "to_seq_exclusive": gap_to,
                "seat_events": [],
                "coverage": "lost",
            }
        return JsonResponse(
            {
                "events": events,
                "latest_event_seq": latest,
                "gap": gap,
            }
        )
