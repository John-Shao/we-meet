"""Directory (通讯录) + org-structure read API.

Exposes the organization's department tree and member directory so the IM
new-conversation picker, meeting invite and (future) approval routing can
browse / search people by department instead of guessing raw identifiers. This
replaces the ``ALLOW_UNSECURE_USER_LISTING`` escape hatch with an org-scoped,
authenticated directory.

Read-only on purpose — department / membership mutations live in the admin
console (P1-d). Every queryset is scoped to the caller's organization from day
one, even though MVP runs a single organization.
"""

import logging
import uuid
from typing import Optional

from django.db.models import Q

from rest_framework import mixins, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models, utils
from core.api import permissions
from core.api.serializers import UserLightSerializer
from core.api.viewsets import Pagination
from core.services.phone_reveal import send_phone_viewed_notice

logger = logging.getLogger(__name__)


def get_caller_organization(user):
    """Resolve the caller's organization (MVP: the single org of their membership).

    Prefers the primary membership; returns ``None`` for users with no active
    membership (so their directory queries come back empty rather than leaking
    another organization's data).
    """
    membership = (
        models.Membership.objects.filter(
            user=user, status=models.MembershipStatusChoices.ACTIVE
        )
        .select_related("organization")
        .order_by("-is_primary", "created_at")
        .first()
    )
    return membership.organization if membership else None


class DepartmentSerializer(serializers.ModelSerializer):
    """Serialize a department node (flat; the client builds the tree from path/parent)."""

    head = UserLightSerializer(read_only=True)

    class Meta:
        model = models.Department
        fields = [
            "id",
            "name",
            "parent",
            "path",
            "depth",
            "sort_order",
            "head",
        ]
        read_only_fields = fields


def contact_flag_context(user) -> dict:
    """Serializer context carrying the caller's two per-contact flag sets.

    ``{"starred_ids": {...}, "special_alert_ids": {...}}`` from **one** query —
    these lists are personal and short. Computed once per request and passed
    through the serializer context so ``is_starred`` / ``special_alert`` never
    turn into an N+1 over a member page.

    The two are separate sets, not one: 星标 and 他的消息特别提醒 are independent
    (see ``ContactPreference``), so a person can be in either, both, or neither.
    """
    starred: set = set()
    alerted: set = set()
    rows = models.ContactPreference.objects.filter(owner=user).values_list(
        "target_id", "is_starred", "special_alert"
    )
    for target_id, is_starred, special_alert in rows:
        if is_starred:
            starred.add(target_id)
        if special_alert:
            alerted.add(target_id)
    return {"starred_ids": starred, "special_alert_ids": alerted}


def mask_phone(phone: str) -> str:
    """Mask a phone for display: keep first 3 + last 4, star the middle
    (138****1990). Numbers too short to keep both ends are fully starred.
    The full number is served only by the reveal-phone endpoint (P3)."""
    p = (phone or "").strip()
    if len(p) <= 7:
        return "*" * len(p)
    return f"{p[:3]}****{p[-4:]}"


class DirectoryMemberSerializer(serializers.Serializer):
    """Serialize a Membership row as a person-card for the directory / picker.

    ``id`` is the we-meet user id — the IM new-conversation endpoint resolves the
    peer's IM uid server-side from it (P1-d), so the raw IM uid is never exposed
    here nor resolved per-row (which would lazily register every listed user).
    """

    id = serializers.UUIDField(source="user.id", read_only=True)
    # The membership row id — admins PATCH /admin/memberships/{membership_id}/ to
    # move this person between departments.
    membership_id = serializers.UUIDField(source="id", read_only=True)
    sub = serializers.CharField(source="user.sub", read_only=True)
    full_name = serializers.CharField(source="user.full_name", read_only=True)
    short_name = serializers.CharField(source="user.short_name", read_only=True)
    email = serializers.EmailField(source="user.email", read_only=True)
    avatar_url = serializers.SerializerMethodField()
    title = serializers.CharField(read_only=True)
    org_role = serializers.CharField(read_only=True)
    department = serializers.SerializerMethodField()
    is_self = serializers.SerializerMethodField()
    phone = serializers.SerializerMethodField()
    is_starred = serializers.SerializerMethodField()
    special_alert = serializers.SerializerMethodField()

    def get_avatar_url(self, obj):
        """Short-lived presigned GET URL for the avatar, '' if unset."""
        return utils.generate_profile_image_get_url("avatar", obj.user.avatar_key)

    def get_department(self, obj):
        """Lightweight {id, name} of the membership's department, or None (org-level)."""
        if obj.department_id:
            return {"id": str(obj.department_id), "name": obj.department.name}
        return None

    def get_is_self(self, obj):
        """Whether this card is the caller (lets the UI hide 'message myself')."""
        request = self.context.get("request")
        return bool(request and obj.user_id == request.user.id)

    def get_phone(self, obj):
        """Phone for the card. Same-org visibility is already enforced by the
        queryset; here we only decide masking: self → full, others → masked
        (138****1990). Empty when the user has no phone. The full number for
        another member comes only from the reveal-phone endpoint (P3)."""
        phone = obj.user.phone or ""
        if not phone:
            return ""
        request = self.context.get("request")
        if request and obj.user_id == request.user.id:
            return phone
        return mask_phone(phone)

    def get_is_starred(self, obj):
        """Whether the caller starred this person — **filing only**.

        Reads the pre-computed set from the context (``contact_flag_context``) so
        a member page costs one extra query, not one per row. Absent context (a
        serializer used outside these viewsets) reads as not-starred.
        """
        starred = self.context.get("starred_ids")
        return bool(starred) and obj.user_id in starred

    def get_special_alert(self, obj):
        """Whether the caller enabled 他的消息特别提醒 for this person.

        Independent of :meth:`get_is_starred` — see ``ContactPreference``. Same
        pre-computed-set trick, same not-set fallback.
        """
        alerted = self.context.get("special_alert_ids")
        return bool(alerted) and obj.user_id in alerted


class DepartmentViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet
):
    """Browse the caller organization's department tree (read-only)."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = DepartmentSerializer
    pagination_class = None  # department trees are small — return the whole list

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.Department.objects.none()
        queryset = (
            models.Department.objects.filter(
                organization=organization,
                is_active=True,
                deleted_at__isnull=True,
            )
            .select_related("head")
            .order_by("path", "sort_order", "name")
        )
        parent = self.request.query_params.get("parent")
        if parent:
            queryset = queryset.filter(parent_id=parent)
        return queryset

    @action(detail=True, methods=["get"])
    def members(self, request, *args, **kwargs):
        """Members of this department, optionally of its whole subtree."""
        department = self.get_object()
        memberships = (
            models.Membership.objects.filter(
                status=models.MembershipStatusChoices.ACTIVE,
                user__is_device=False,
                user__sub__isnull=False,  # skip OIDC-less Django-admin accounts
            )
            .exclude(user__sub="")
            .select_related("user", "department")
            .order_by("user__full_name")
        )
        if request.query_params.get("include_subtree") == "true":
            subtree_ids = models.Department.objects.filter(
                organization=department.organization,
                path__startswith=department.path,
            ).values_list("id", flat=True)
            memberships = memberships.filter(department_id__in=subtree_ids)
        else:
            memberships = memberships.filter(department=department)

        paginator = Pagination()
        page = paginator.paginate_queryset(memberships, request, view=self)
        serializer = DirectoryMemberSerializer(
            page,
            many=True,
            context={"request": request, **contact_flag_context(request.user)},
        )
        return paginator.get_paginated_response(serializer.data)


class DirectoryMemberViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet
):
    """Search / browse organization members, one card per user (read-only).

    The list is built from each user's *primary* membership (guaranteed unique
    per user per organization), so a person never appears twice.
    """

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = DirectoryMemberSerializer
    pagination_class = Pagination
    lookup_field = "user_id"

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.Membership.objects.none()
        queryset = (
            models.Membership.objects.filter(
                organization=organization,
                status=models.MembershipStatusChoices.ACTIVE,
                is_primary=True,
                user__is_device=False,
                user__sub__isnull=False,  # skip OIDC-less Django-admin accounts
            )
            .exclude(user__sub="")
            .select_related("user", "department")
            .order_by("user__full_name")
        )
        department = self.request.query_params.get("department")
        if department:
            queryset = queryset.filter(department_id=department)
        query = self.request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(
                Q(user__full_name__icontains=query)
                | Q(user__email__icontains=query)
            )
        return queryset

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["request"] = self.request
        context.update(contact_flag_context(self.request.user))
        return context

    @action(detail=True, methods=["post"], url_path="reveal-phone")
    def reveal_phone(self, request, user_id=None):
        """Return a member's FULL phone number (the masked list never carries it).

        Same-org visibility is enforced by get_queryset (cross-org → 404). Any
        reveal of ANOTHER member's number posts a `phone-viewed` system message
        into the direct conversation so the owner is notified (best-effort — a
        jusi hiccup never blocks the reveal). Revealing one's own number is a
        no-op notice-wise.
        """
        membership = self.get_object()
        target = membership.user
        phone = target.phone or ""
        if phone and target.id != request.user.id:
            try:
                send_phone_viewed_notice(request.user, target)
            except Exception:  # noqa: BLE001 — notice is best-effort
                logger.warning(
                    "phone-viewed notice failed (viewer=%s owner=%s)",
                    request.user.pk,
                    target.pk,
                    exc_info=True,
                )
        return Response({"phone": phone}, status=status.HTTP_200_OK)


def parse_user_id(raw) -> Optional[uuid.UUID]:
    """Coerce a client-supplied user id to UUID, ``None`` when malformed.
    Keeps a garbage path segment a 400 instead of a queryset-level 500."""
    try:
        return uuid.UUID(str(raw or "").strip())
    except (ValueError, AttributeError, TypeError):
        return None


def org_membership_of(caller, user_id):
    """The target's ACTIVE primary membership in ``caller``'s org, or None.

    Same org-scoping as ``DirectoryMemberViewSet``: per-contact flags may only be
    set on people the caller can already see in the directory.
    """
    organization = get_caller_organization(caller)
    if organization is None:
        return None
    return (
        models.Membership.objects.filter(
            organization=organization,
            user_id=user_id,
            status=models.MembershipStatusChoices.ACTIVE,
            is_primary=True,
            user__is_device=False,
        )
        .select_related("user", "department")
        .first()
    )


class StarredContactViewSet(viewsets.GenericViewSet):
    """The caller's own 星标联系人 list — ``GET /api/v1.0/directory/starred/``.

    Read-only. Setting either per-contact flag goes through
    ``ContactPreferenceView`` (``directory/contact-prefs/{user_id}/``) — there is
    no POST/DELETE here, because 星标 is only one of two independent flags and
    one endpoint for both keeps the client from having to know that.

    The list is projected through the target's *Membership* in the caller's
    organization and reuses ``DirectoryMemberSerializer``, so a starred person
    who left the org (or was never in it) simply stops appearing — no tombstone
    rows to clean up. Bare array on purpose: a personal star list is short.
    """

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = DirectoryMemberSerializer
    pagination_class = None

    def get_queryset(self):
        return models.ContactPreference.objects.filter(
            owner=self.request.user, is_starred=True
        )

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["request"] = self.request
        context.update(contact_flag_context(self.request.user))
        return context

    def list(self, request):
        """Starred members as directory cards, ordered like the directory itself."""
        target_ids = list(self.get_queryset().values_list("target_id", flat=True))
        organization = get_caller_organization(request.user)
        if organization is None or not target_ids:
            return Response([], status=status.HTTP_200_OK)
        memberships = (
            models.Membership.objects.filter(
                organization=organization,
                user_id__in=target_ids,
                status=models.MembershipStatusChoices.ACTIVE,
                is_primary=True,
                user__is_device=False,
            )
            .select_related("user", "department")
            .order_by("user__full_name")
        )
        serializer = self.get_serializer(memberships, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)


class ContactPreferenceViewSet(viewsets.GenericViewSet):
    """The caller's per-contact flags — ``/api/v1.0/directory/contact-prefs/``.

        GET /directory/contact-prefs/            → flags only, bare array
        PUT /directory/contact-prefs/{user_id}/  → set either / both flags

    ``list`` returns just ids + booleans, not member cards::

        [{"user_id": "…", "is_starred": true, "special_alert": false}, …]

    That is deliberately different from ``/directory/starred/``: this one primes
    the client's local flag sets (the conversation list needs to know which peers
    to mark, for peers whose cards it never fetched), while ``starred/`` returns
    renderable, org-projected, name-ordered cards for the 星标联系人 page. Rows
    whose target left the org are kept here on purpose — dropping them would need
    a Membership join for a payload nobody renders.

    ``update`` body carries either flag, both, or neither (a no-op read)::

        {"is_starred": true}              → 星标 only
        {"special_alert": true}           → 他的消息特别提醒 only
        {"is_starred": false, "special_alert": true}

    Omitted keys are left alone, so a client toggling one switch never clobbers
    the other. Idempotent. Responds with the member card, which carries both
    flags back — the caller re-renders from one authoritative shape instead of
    trusting its own optimistic state.

    Both flags false → the row is deleted rather than kept as a no-op tombstone.

    Org-scoped: a target outside the caller's directory is a 404, same as
    ``DirectoryMemberViewSet`` (never reveal that the user id exists elsewhere).
    """

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = DirectoryMemberSerializer
    pagination_class = None
    lookup_field = "target_id"
    lookup_url_kwarg = "user_id"

    def get_queryset(self):
        return models.ContactPreference.objects.filter(owner=self.request.user)

    def list(self, request):
        """Flags only — what the client needs to prime its local sets."""
        rows = self.get_queryset().values_list("target_id", "is_starred", "special_alert")
        return Response(
            [
                {
                    "user_id": str(target_id),
                    "is_starred": is_starred,
                    "special_alert": special_alert,
                }
                for target_id, is_starred, special_alert in rows
            ],
            status=status.HTTP_200_OK,
        )

    def update(self, request, user_id=None):
        parsed = parse_user_id(user_id)
        if parsed is None:
            return Response(
                {"user_id": "a valid user id is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if parsed == request.user.id:
            return Response(
                {"user_id": "cannot set contact preferences on yourself"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        membership = org_membership_of(request.user, parsed)
        if membership is None:
            return Response(status=status.HTTP_404_NOT_FOUND)

        data = request.data or {}
        row = models.ContactPreference.objects.filter(
            owner=request.user, target_id=parsed
        ).first()
        is_starred = bool(row.is_starred) if row else False
        special_alert = bool(row.special_alert) if row else False
        if "is_starred" in data:
            is_starred = bool(data["is_starred"])
        if "special_alert" in data:
            special_alert = bool(data["special_alert"])

        if not is_starred and not special_alert:
            if row is not None:
                row.delete()
        elif row is None:
            models.ContactPreference.objects.create(
                owner=request.user,
                target_id=parsed,
                is_starred=is_starred,
                special_alert=special_alert,
            )
        else:
            row.is_starred = is_starred
            row.special_alert = special_alert
            row.save(update_fields=["is_starred", "special_alert", "updated_at"])

        # Serialize AFTER the write so the returned card carries the new flags.
        serializer = DirectoryMemberSerializer(
            membership,
            context={"request": request, **contact_flag_context(request.user)},
        )
        return Response(serializer.data, status=status.HTTP_200_OK)


class DirectoryMeView(APIView):
    """The caller's own membership context — organization + org role.

    The management console (M 端) reads this to decide whether to admit the
    caller (``is_org_admin``) and to label the current organization in its
    shell. It stays read-only and member-accessible; the actual admin
    mutations remain guarded by ``IsOrgAdmin`` (``core/api/admin_org.py``).
    """

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        membership = (
            models.Membership.objects.filter(
                user=request.user,
                status=models.MembershipStatusChoices.ACTIVE,
            )
            .select_related("organization")
            .order_by("-is_primary", "created_at")
            .first()
        )
        if membership is None:
            return Response(
                {"organization": None, "org_role": None, "is_org_admin": False}
            )
        organization = membership.organization
        is_org_admin = membership.org_role in (
            models.OrgRoleChoices.ADMIN,
            models.OrgRoleChoices.OWNER,
        )
        return Response(
            {
                "organization": {
                    "id": str(organization.id),
                    "name": organization.name,
                },
                "org_role": membership.org_role,
                "is_org_admin": is_org_admin,
            }
        )
