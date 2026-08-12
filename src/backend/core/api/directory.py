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

from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.http import Http404
from django.utils import timezone

from rest_framework import mixins, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models, utils
from core.api import permissions
from core.api.serializers import UserLightSerializer
from core.api.validation import parse_boolean
from core.api.viewsets import Pagination
from core.services.phone_reveal import send_phone_viewed_notice

logger = logging.getLogger(__name__)


def get_caller_membership(user):
    """The caller's active membership (primary first), or ``None``.

    Memoized on the user instance exactly like ``User.get_teams()``: a single
    admin request otherwise resolves the same row three times — ``IsOrgAdmin``
    looks up the org, then re-queries to check the role, then the viewset's
    ``get_organization()`` looks it up again. One query per request instead.

    The cache is per-instance and ``request.user`` is rebuilt each request, so
    there is no cross-request staleness to reason about.
    """
    if not hasattr(user, "_org_membership_cache"):
        user._org_membership_cache = (  # pylint: disable=protected-access
            models.Membership.objects.filter(
                user=user, status=models.MembershipStatusChoices.ACTIVE
            )
            .select_related("organization")
            .order_by("-is_primary", "created_at")
            .first()
        )
    return user._org_membership_cache  # pylint: disable=protected-access


def get_caller_organization(user):
    """Resolve the caller's organization (MVP: the single org of their membership).

    Prefers the primary membership; returns ``None`` for users with no active
    membership (so their directory queries come back empty rather than leaking
    another organization's data).
    """
    membership = get_caller_membership(user)
    return membership.organization if membership else None


ORG_ADMIN_ROLES = (
    models.OrgRoleChoices.ADMIN,
    models.OrgRoleChoices.OWNER,
)


def is_caller_org_admin(user) -> bool:
    """Whether the caller administers their organization. Memoized per request.

    Checks **any** active membership in the org, not just the primary one — a
    user whose primary membership is a plain ``member`` may still hold an
    ``administrator`` membership on a department. ``IsOrgAdmin`` has always
    gated on that broader rule; ``/directory/me/`` used to read the primary
    membership's role only, so such a user was refused by the console guard
    while the admin API happily served them. Single source of truth now.
    """
    if not hasattr(user, "_org_admin_cache"):
        organization = get_caller_organization(user)
        user._org_admin_cache = bool(  # pylint: disable=protected-access
            organization
            and models.Membership.objects.filter(
                user=user,
                organization=organization,
                status=models.MembershipStatusChoices.ACTIVE,
                org_role__in=ORG_ADMIN_ROLES,
            ).exists()
        )
    return user._org_admin_cache  # pylint: disable=protected-access


class DepartmentSerializer(serializers.ModelSerializer):
    """Serialize a department node (flat; the client builds the tree from path/parent)."""

    head = UserLightSerializer(read_only=True)
    member_count = serializers.IntegerField(read_only=True)

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
            "code",
            # Annotated in the queryset, never a SerializerMethodField — the
            # department tree is returned whole and unpaginated, so a per-row
            # count() would be an N+1 across the entire org chart.
            "member_count",
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
    # Always False here (this serializer only ever sees active memberships); the
    # field exists so clients get one card shape and can branch on it. Departed
    # colleagues come back from the retrieve tombstone with ``left: true``.
    left = serializers.SerializerMethodField()

    def get_left(self, obj):
        return obj.status != models.MembershipStatusChoices.ACTIVE

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


class UserGroupDirectorySerializer(serializers.ModelSerializer):
    """A user group as a *share target* — the C-side view of it.

    Deliberately thin: name + the opaque key you would put in a grant, plus a
    member count for the picker. Who is in the group is not exposed here; that
    is an admin question, and a share picker does not need it.
    """

    member_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = models.UserGroup
        fields = ["id", "name", "description", "group_key", "member_count"]


class UserGroupDirectoryViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """Groups in the caller's organization, for share pickers (read-only).

    Visible to every member, not just admins: the point of a group is that
    ordinary people can share *with* it. Membership of the group is not
    returned — see the serializer.
    """

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = UserGroupDirectorySerializer
    pagination_class = None  # tens of groups, not thousands

    def get_queryset(self):
        organization = get_caller_organization(self.request.user)
        if organization is None:
            return models.UserGroup.objects.none()
        queryset = models.UserGroup.objects.filter(
            organization=organization, is_active=True, deleted_at__isnull=True
        ).annotate(member_count=Count("members", distinct=True))
        search = self.request.query_params.get("q")
        if search:
            queryset = queryset.filter(name__icontains=search.strip())
        return queryset


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
            .annotate(
                member_count=Count(
                    "memberships",
                    filter=Q(
                        memberships__status=models.MembershipStatusChoices.ACTIVE,
                        memberships__user__is_device=False,
                    ),
                    distinct=True,
                )
            )
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
                Q(user__full_name__icontains=query) | Q(user__email__icontains=query)
            )
        return queryset

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["request"] = self.request
        context.update(contact_flag_context(self.request.user))
        return context

    def retrieve(self, request, *args, **kwargs):
        """One member's card, with a tombstone fallback for departed colleagues.

        The list stays active-only, but a 404 here would white-screen the
        ``/contacts?member=<id>`` deep link that every historical message links
        to. Departed members get a reduced card instead: enough to render the
        name in history, with contact details stripped — someone who left should
        not keep handing out their phone number and email.
        """
        try:
            return super().retrieve(request, *args, **kwargs)
        except Http404:
            tombstone = self._departed_card(kwargs.get(self.lookup_field))
            if tombstone is None:
                raise
            return Response(tombstone, status=status.HTTP_200_OK)

    def _departed_card(self, user_id) -> Optional[dict]:
        """Reduced card for a former member of the caller's org, else ``None``."""
        organization = get_caller_organization(self.request.user)
        parsed = parse_user_id(user_id)
        if organization is None or parsed is None:
            return None

        membership = (
            models.Membership.objects.filter(
                organization=organization,
                user_id=parsed,
                status__in=(
                    models.MembershipStatusChoices.LEFT,
                    models.MembershipStatusChoices.SUSPENDED,
                ),
                user__is_device=False,
            )
            .select_related("user")
            .order_by("-left_at")
            .first()
        )
        if membership is None:
            return None

        user = membership.user
        snapshot = membership.left_snapshot or {}
        return {
            "id": str(user.id),
            "membership_id": str(membership.id),
            "sub": user.sub or "",
            "full_name": user.full_name or user.short_name or "",
            "short_name": user.short_name or "",
            "avatar_url": utils.generate_profile_image_get_url(
                "avatar", user.avatar_key
            ),
            # Contact details are deliberately omitted, not blanked: a departed
            # colleague's phone and email stop being the organization's to share.
            "title": snapshot.get("title", membership.title),
            "department": (
                {"id": snapshot.get("department_id"), "name": name}
                if (name := snapshot.get("department_name"))
                else None
            ),
            "org_role": snapshot.get("org_role", membership.org_role),
            "is_self": user.id == self.request.user.id,
            "left": True,
        }

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


class ExternalContactViewSet(
    mixins.ListModelMixin, mixins.DestroyModelMixin, viewsets.GenericViewSet
):
    """Mutual cross-organization contacts and their friend requests.

    Phone/email is only a discovery mechanism here.  Calendar and IM receive a
    real ``User`` id only after the request has been accepted; there is no
    email-only calendar identity in this flow.
    """

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = serializers.Serializer
    pagination_class = None

    def get_queryset(self):
        return models.ExternalContact.objects.filter(
            Q(user_a=self.request.user) | Q(user_b=self.request.user)
        ).select_related(
            "user_a",
            "user_b",
            "requested_by",
        )

    @staticmethod
    def _organization_for(user, *, exclude=None):
        memberships = models.Membership.objects.filter(
            user=user,
            status=models.MembershipStatusChoices.ACTIVE,
            organization__is_active=True,
        ).select_related("organization")
        if exclude is not None:
            memberships = memberships.exclude(organization=exclude)
        membership = memberships.order_by("-is_primary", "created_at").first()
        return membership.organization if membership else None

    def _card(self, relationship, *, user=None):
        target = user or relationship.other_user(self.request.user)
        caller_org = get_caller_organization(self.request.user)
        organization = self._organization_for(target, exclude=caller_org)
        direction = "accepted"
        if relationship.status == models.ExternalContactStatusChoices.PENDING:
            direction = (
                "outgoing"
                if relationship.requested_by_id == self.request.user.id
                else "incoming"
            )
        elif relationship.status == models.ExternalContactStatusChoices.DECLINED:
            direction = "declined"
        return {
            "relationship_id": str(relationship.id),
            "id": str(target.id),
            "full_name": target.full_name,
            "short_name": target.short_name,
            "avatar_url": utils.generate_profile_image_get_url(
                "avatar", target.avatar_key
            ),
            "organization": (
                {"id": str(organization.id), "name": organization.name}
                if organization
                else None
            ),
            "status": relationship.status,
            "direction": direction,
            "requested_at": relationship.created_at,
        }

    def list(self, request, *args, **kwargs):
        rows = self.get_queryset().filter(
            status=models.ExternalContactStatusChoices.ACCEPTED
        )
        cards = [self._card(row) for row in rows]
        cards.sort(
            key=lambda card: (card["full_name"] or card["short_name"] or "").casefold()
        )
        return Response(cards)

    @action(detail=False, methods=["get"], url_path="search")
    def search(self, request):
        """Exact account discovery by phone or email; never fuzzy-enumerate."""
        query = str(request.query_params.get("q") or "").strip()
        if not query:
            return Response([])
        organization = get_caller_organization(request.user)
        if organization is None:
            return Response([])

        # Users sharing any active membership with the caller are internal,
        # even if they also happen to belong to another organization.
        internal_ids = models.Membership.objects.filter(
            organization=organization,
            status=models.MembershipStatusChoices.ACTIVE,
        ).values_list("user_id", flat=True)
        compact_phone = "".join(ch for ch in query if ch.isdigit() or ch == "+")
        identity_filter = Q(email__iexact=query) | Q(phone=query)
        if compact_phone and compact_phone != query:
            identity_filter |= Q(phone=compact_phone)
        users = (
            models.User.objects.filter(identity_filter, is_active=True, is_device=False)
            .exclude(id=request.user.id)
            .exclude(id__in=internal_ids)
            .exclude(sub__isnull=True)
            .exclude(sub="")
            .filter(
                memberships__status=models.MembershipStatusChoices.ACTIVE,
                memberships__organization__is_active=True,
            )
            .distinct()[:20]
        )

        results = []
        for target in users:
            user_a, user_b = models.ExternalContact.canonical_pair(request.user, target)
            relationship = models.ExternalContact.objects.filter(
                user_a=user_a, user_b=user_b
            ).first()
            if relationship is None:
                # Unsaved relationship-shaped object keeps the response card
                # uniform without creating state merely because somebody searched.
                relationship = models.ExternalContact(
                    user_a=user_a,
                    user_b=user_b,
                    requested_by=request.user,
                    status=models.ExternalContactStatusChoices.DECLINED,
                )
                card = self._card(relationship, user=target)
                card.update(
                    {
                        "relationship_id": None,
                        "status": "none",
                        "direction": "none",
                        "requested_at": None,
                    }
                )
            else:
                card = self._card(relationship, user=target)
            results.append(card)
        return Response(results)

    @action(detail=False, methods=["get", "post"], url_path="requests")
    def requests(self, request):
        """List pending requests or send one to a discovered real account."""
        if request.method == "GET":
            rows = self.get_queryset().filter(
                status=models.ExternalContactStatusChoices.PENDING
            )
            return Response([self._card(row) for row in rows])

        raw_target = (request.data or {}).get("target_user_id")
        try:
            target_id = uuid.UUID(str(raw_target))
        except (ValueError, TypeError, AttributeError):
            return Response(
                {"target_user_id": "a valid user id is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if target_id == request.user.id:
            return Response(
                {"target_user_id": "cannot add yourself"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        caller_org = get_caller_organization(request.user)
        target = (
            models.User.objects.filter(
                id=target_id,
                is_active=True,
                is_device=False,
                sub__isnull=False,
            )
            .exclude(sub="")
            .first()
        )
        if (
            caller_org is None
            or target is None
            or models.Membership.objects.filter(
                user=target,
                organization=caller_org,
                status=models.MembershipStatusChoices.ACTIVE,
            ).exists()
            or self._organization_for(target, exclude=caller_org) is None
        ):
            return Response(status=status.HTTP_404_NOT_FOUND)

        user_a, user_b = models.ExternalContact.canonical_pair(request.user, target)
        try:
            with transaction.atomic():
                relationship = (
                    models.ExternalContact.objects.select_for_update()
                    .filter(user_a=user_a, user_b=user_b)
                    .first()
                )
                if relationship is None:
                    relationship = models.ExternalContact.objects.create(
                        user_a=user_a,
                        user_b=user_b,
                        requested_by=request.user,
                    )
                elif (
                    relationship.status == models.ExternalContactStatusChoices.ACCEPTED
                ):
                    pass
                elif (
                    relationship.status == models.ExternalContactStatusChoices.PENDING
                    and relationship.requested_by_id != request.user.id
                ):
                    # Crossing requests are mutual intent, so accept immediately.
                    relationship.status = models.ExternalContactStatusChoices.ACCEPTED
                    relationship.responded_at = timezone.now()
                    relationship.save(
                        update_fields=["status", "responded_at", "updated_at"]
                    )
                else:
                    relationship.requested_by = request.user
                    relationship.status = models.ExternalContactStatusChoices.PENDING
                    relationship.responded_at = None
                    relationship.save(
                        update_fields=[
                            "requested_by",
                            "status",
                            "responded_at",
                            "updated_at",
                        ]
                    )
        except IntegrityError:
            relationship = models.ExternalContact.objects.get(
                user_a=user_a, user_b=user_b
            )
        return Response(
            self._card(relationship, user=target),
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=["post"])
    def accept(self, request, *args, **kwargs):
        relationship = self.get_object()
        if relationship.status == models.ExternalContactStatusChoices.ACCEPTED:
            return Response(self._card(relationship))
        if (
            relationship.status != models.ExternalContactStatusChoices.PENDING
            or relationship.requested_by_id == request.user.id
        ):
            return Response(status=status.HTTP_403_FORBIDDEN)
        relationship.status = models.ExternalContactStatusChoices.ACCEPTED
        relationship.responded_at = timezone.now()
        relationship.save(update_fields=["status", "responded_at", "updated_at"])
        return Response(self._card(relationship))

    @action(detail=True, methods=["post"])
    def decline(self, request, *args, **kwargs):
        relationship = self.get_object()
        if (
            relationship.status != models.ExternalContactStatusChoices.PENDING
            or relationship.requested_by_id == request.user.id
        ):
            return Response(status=status.HTTP_403_FORBIDDEN)
        relationship.status = models.ExternalContactStatusChoices.DECLINED
        relationship.responded_at = timezone.now()
        relationship.save(update_fields=["status", "responded_at", "updated_at"])
        return Response(self._card(relationship))

    def destroy(self, request, *args, **kwargs):
        """Either side may remove the mutual relation or cancel a request."""
        relationship = self.get_object()
        relationship.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


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


class ContactFlagListViewSet(viewsets.GenericViewSet):
    """Base for the two per-contact flag lists — renderable member cards.

    Subclasses set :attr:`flag_field` to the ``ContactPreference`` boolean they
    project. Read-only: setting either flag goes through
    ``ContactPreferenceViewSet`` (``directory/contact-prefs/{user_id}/``), so a
    client toggling one never has to know there are two.

    Lists are projected through the target's *Membership* in the caller's
    organization and reuse ``DirectoryMemberSerializer``, so someone who left the
    org (or was never in it) simply stops appearing — no tombstone rows to clean
    up. Bare array on purpose: these personal lists are short.
    """

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = DirectoryMemberSerializer
    pagination_class = None
    #: ``ContactPreference`` boolean field this list filters on.
    flag_field: str = ""

    def get_queryset(self):
        return models.ContactPreference.objects.filter(
            owner=self.request.user, **{self.flag_field: True}
        )

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["request"] = self.request
        context.update(contact_flag_context(self.request.user))
        return context

    def list(self, request):
        """Flagged members as directory cards, ordered like the directory itself."""
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


class StarredContactViewSet(ContactFlagListViewSet):
    """星标联系人 — ``GET /api/v1.0/directory/starred/``. Rendered by 通讯录."""

    flag_field = "is_starred"


class SpecialAlertContactViewSet(ContactFlagListViewSet):
    """「他的消息特别提醒」名单 — ``GET /api/v1.0/directory/special-alert/``.

    Rendered by the App's 设置 › 通知 › 消息特别提醒 page, which is where this
    list is reviewed and pruned (the per-person switch itself lives on the
    contact's detail page — same two-entry shape as 星标).
    """

    flag_field = "special_alert"


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
        rows = self.get_queryset().values_list(
            "target_id", "is_starred", "special_alert"
        )
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
            is_starred = parse_boolean(data["is_starred"])
        if "special_alert" in data:
            special_alert = parse_boolean(data["special_alert"])

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
        from core.services.org_permissions import get_admin_context

        membership = get_caller_membership(request.user)
        if membership is None:
            return Response(
                {
                    "organization": None,
                    "org_role": None,
                    "is_org_admin": False,
                    "permissions": [],
                    "admin_scope": {"type": "all", "department_ids": []},
                }
            )
        organization = membership.organization
        is_org_admin = is_caller_org_admin(request.user)
        # P10 M2: the console renders its navigation from `permissions`, so
        # someone holding only the HR role never sees "roles and permissions".
        # `is_org_admin` stays for backwards compatibility — a client that only
        # knows the old shape keeps working, it just cannot do finer filtering.
        ctx = get_admin_context(request)
        scope_department_ids = []
        if ctx.is_scoped:
            scope_department_ids = [
                str(pk)
                for pk in models.AdminRoleScopeDepartment.objects.filter(
                    assignment__membership=membership
                )
                .order_by()
                .values_list("department_id", flat=True)
                .distinct()
            ]
        return Response(
            {
                "organization": {
                    "id": str(organization.id),
                    "name": organization.name,
                },
                "org_role": membership.org_role,
                "is_org_admin": is_org_admin,
                "permissions": sorted(ctx.permissions),
                "admin_scope": {
                    "type": ctx.scope_type,
                    "department_ids": scope_department_ids,
                },
            }
        )
