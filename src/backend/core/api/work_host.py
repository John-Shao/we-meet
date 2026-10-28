"""Internal Host endpoint for Work session verification (HW-01/HW-04).

The endpoint is reached through the meet ingress with client-certificate
verification. The ingress passes the verified client certificate as
``ssl-client-cert``; this view verifies that certificate against
``WORK_HOST_MTLS_CA_PEM`` and requires the configured workload identity.
The backend must not be reachable directly from workloads that are not the
Work control plane. The response contains no cookie, CSRF token or Work-domain
data.
"""

import base64
import hashlib
import os
import re
import urllib.parse
import uuid
from datetime import datetime, timezone

from django.conf import settings
from django.http import JsonResponse
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID

from core.api.directory import get_caller_organization
from core.models import Membership, Organization

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


def _verify_client_certificate(request) -> bool:
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
        and _common_name_is_expected(client)
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
    except Exception:  # noqa: BLE001 - every verification failure is a denial
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


def _common_name_is_expected(client) -> bool:
    common_names = client.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
    return bool(common_names) and common_names[0].value == _expected_identity()


@method_decorator(csrf_exempt, name="dispatch")
@method_decorator(require_POST, name="dispatch")
class WorkHostSessionVerifyView(View):
    def post(self, request):
        if not _verify_client_certificate(request):
            return JsonResponse({"code": "client_identity_invalid"}, status=403)

        cookie_name = settings.SESSION_COOKIE_NAME
        raw_cookies = request.META.get("HTTP_COOKIE", "")
        if len(re.findall(rf"(?:^|;\s*){re.escape(cookie_name)}=", raw_cookies)) != 1:
            return JsonResponse({"code": "session_invalid"}, status=401)

        user = getattr(request, "user", None)
        if user is None or not getattr(user, "is_authenticated", False):
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
    return {
        "subject_id": subject_id,
        "status": membership.status,
        "role": role,
        "work_seat": membership.work_seat,
        "revision": revision,
        "gaps": gaps,
    }


def _pagination_error():
    return JsonResponse({"code": "invalid_pagination"}, status=422)


@method_decorator(require_GET, name="dispatch")
class WorkHostOrgListView(View):
    def get(self, request):
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


@method_decorator(require_GET, name="dispatch")
class WorkHostMemberListView(View):
    def get(self, request, org_id):
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
