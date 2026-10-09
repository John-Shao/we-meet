"""Bounded directory lookup for editorial speaker naming, not voiceprint access."""

from django.db.models import Q

from core import models

PAGE_SIZE = 25
MAX_PAGE_SIZE = 50


def name(user):
    """Public account name only: never personal remarks or contact details."""
    return user.full_name or user.short_name or "Unnamed member"


def memberships():
    return models.Membership.objects.filter(
        status=models.MembershipStatusChoices.ACTIVE, organization__is_active=True
    )


def members(record, actor, query="", department_id=None):
    """Apply the same member visibility boundary to lookup and writes."""
    scopes = memberships()
    if record.organization_id:
        scopes = scopes.filter(organization_id=record.organization_id)
        users = models.User.objects.filter(pk__in=scopes.values("user_id"))
    else:
        scopes = scopes.filter(
            organization_id__in=memberships()
            .filter(user=actor)
            .values("organization_id")
        )
        users = models.User.objects.filter(
            Q(pk__in=scopes.values("user_id")) | Q(pk=actor.pk)
        )
    if department_id:
        users = users.filter(
            pk__in=scopes.filter(
                department_id=department_id,
                department__is_active=True,
                department__deleted_at__isnull=True,
            ).values("user_id")
        )
    if query:
        users = users.filter(
            Q(full_name__icontains=query) | Q(short_name__icontains=query)
        )
    return users.filter(is_active=True, is_device=False).order_by("full_name", "id")


def department_choices(record, actor, query="", offset=0, limit=PAGE_SIZE):
    """Record-bound departments, independent of the caller's primary org."""
    scope = memberships()
    if record.organization_id:
        scope = scope.filter(organization_id=record.organization_id)
    else:
        scope = scope.filter(
            organization_id__in=memberships()
            .filter(user=actor)
            .values("organization_id")
        )
    rows = (
        models.Department.objects.filter(
            pk__in=scope.values("department_id"),
            is_active=True,
            deleted_at__isnull=True,
        )
        .select_related("organization")
        .order_by("organization_id", "path", "id")
    )
    if query:
        rows = rows.filter(name__icontains=query)
    total = rows.count()
    return {
        "results": [
            {
                "ref": str(row.pk),
                "kind": "department",
                "name": row.name,
                "organization_name": row.organization.name,
                "department_name": "",
                "department_id": str(row.pk),
            }
            for row in rows[offset : offset + limit]
        ],
        "next_offset": offset + limit if offset + limit < total else None,
    }


def relationships(actor, query=""):
    """Only current accepted relationships owned by this actor are selectable."""
    rows = models.ExternalContact.objects.filter(
        Q(user_a=actor) | Q(user_b=actor),
        status=models.ExternalContactStatusChoices.ACCEPTED,
        user_a__is_active=True,
        user_b__is_active=True,
        user_a__is_device=False,
        user_b__is_device=False,
    )
    if query:
        rows = rows.filter(
            Q(user_a=actor)
            & (
                Q(user_b__full_name__icontains=query)
                | Q(user_b__short_name__icontains=query)
            )
            | Q(user_b=actor)
            & (
                Q(user_a__full_name__icontains=query)
                | Q(user_a__short_name__icontains=query)
            )
        )
    return rows.select_related("user_a", "user_b").order_by("id")


def lookup(  # noqa: PLR0913
    record,
    actor,
    *,
    query="",
    kind="all",
    department_id=None,
    offset=0,
    limit=PAGE_SIZE,
):
    """Paginate minimal contact cards; never expose the actor's private remarks."""
    from core.services.speaker_attribution import authorize  # noqa: PLC0415

    authorize(record, actor)
    if (
        kind not in {"all", "member", "external", "departments"}
        or not isinstance(limit, int)
        or not 1 <= limit <= MAX_PAGE_SIZE
        or not isinstance(offset, int)
        or not 0 <= offset <= 10000
    ):
        raise ValueError("invalid_contact_filters")
    if kind == "departments":
        return department_choices(record, actor, query, offset, limit)
    people = members(record, actor, query, department_id)
    contacts = relationships(actor, query)
    member_count = people.count() if kind != "external" else 0
    external_count = contacts.count() if kind != "member" and not department_id else 0
    selected = list(people[offset : offset + limit]) if member_count else []
    selected_ids = [user.pk for user in selected]
    scope = memberships().filter(user_id__in=selected_ids)
    if record.organization_id:
        scope = scope.filter(organization_id=record.organization_id)
    else:
        scope = scope.filter(
            organization_id__in=memberships()
            .filter(user=actor)
            .values("organization_id")
        )
    contexts = {}
    for membership in scope.select_related("department", "organization").order_by(
        "-is_primary", "created_at"
    ):
        contexts.setdefault(membership.user_id, membership)
    results = []
    for user in selected:
        context = contexts.get(user.pk)
        results.append(
            {
                "ref": f"member:{user.pk}",
                "kind": "member",
                "name": name(user),
                "organization_name": context.organization.name if context else "",
                "department_name": context.department.name
                if context and context.department_id
                else "",
                "department_id": str(context.department_id)
                if context and context.department_id
                else None,
            }
        )
    remaining = limit - len(results)
    if external_count and remaining:
        start = max(0, offset - member_count)
        for relationship in contacts[start : start + remaining]:
            target = relationship.other_user(actor)
            results.append(
                {
                    "ref": f"external:{relationship.pk}",
                    "kind": "external",
                    "name": name(target),
                    "organization_name": "",
                    "department_name": "",
                    "department_id": None,
                }
            )
    total = member_count + external_count
    return {
        "results": results,
        "next_offset": offset + limit if offset + limit < total else None,
    }


def resolve(record, actor, reference):
    """Resolve current visibility again at write time, never trust a snapshot."""
    from uuid import UUID  # noqa: PLC0415

    from core.services.speaker_attribution import AttributionDenied  # noqa: PLC0415

    try:
        kind, value = reference.split(":", 1)
        identifier = UUID(value)
    except (ValueError, AttributeError) as error:
        raise AttributionDenied("Invalid contact reference.") from error
    if kind == "member":
        target = members(record, actor).filter(pk=identifier).first()
        if target is None:
            raise AttributionDenied("That member is no longer selectable.")
        return target, "", "member", None
    if kind == "external":
        relationship = relationships(actor).filter(pk=identifier).first()
        if relationship is None:
            raise AttributionDenied("That contact is no longer selectable.")
        target = relationship.other_user(actor)
        if members(record, actor).filter(pk=target.pk).exists():
            return target, "", "member", None
        return None, name(target)[:128], "contact", relationship
    raise AttributionDenied("Invalid contact type.")
