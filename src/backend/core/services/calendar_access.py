"""Calendar sharing and per-event visibility policy.

This module is the single server-side authority for deciding whether a viewer
gets no event, an anonymous busy interval, or complete details.  A subscription
is only a presentation choice; access still comes from the calendar's
organization default or an explicit grant.
"""

from enum import StrEnum

from django.db.models import Q

from core import models
from core.services import calendar_im_notify


class EventAccess(StrEnum):
    NONE = "none"
    BUSY = "busy"
    DETAILS = "details"


class SourceAccessUnavailable(Exception):
    """The source conversation was the only remaining path and IM failed."""


def ensure_personal_calendar(user, organization=None):
    """Return the user's personal calendar in an active organization."""
    if organization is None:
        membership = (
            models.Membership.objects.filter(
                user=user,
                status=models.MembershipStatusChoices.ACTIVE,
                organization__is_active=True,
            )
            .select_related("organization")
            .order_by("-is_primary", "created_at")
            .first()
        )
        if membership is None:
            return None
        organization = membership.organization
    calendar, _ = models.Calendar.objects.get_or_create(
        organization=organization,
        owner=user,
        kind=models.CalendarKindChoices.PRIMARY,
    )
    return calendar


def accepted_external_contacts(first, second) -> bool:
    """Whether two real accounts currently have an accepted contact relation."""
    user_a, user_b = models.ExternalContact.canonical_pair(first, second)
    return models.ExternalContact.objects.filter(
        user_a=user_a,
        user_b=user_b,
        status=models.ExternalContactStatusChoices.ACCEPTED,
    ).exists()


def calendar_permission(calendar, viewer) -> str:  # noqa: PLR0911
    """Resolve the authorization behind a subscription.

    Same-organization members inherit the owner's calendar default; an
    explicit grant overrides it.  Cross-organization access requires both an
    accepted external-contact relationship and an explicit grant.
    """
    if calendar.deleted_at is not None:
        return models.CalendarAccessChoices.NONE
    if calendar.owner_id == viewer.id:
        return models.CalendarAccessChoices.ADMIN
    if calendar.kind == models.CalendarKindChoices.EXTERNAL:
        return models.CalendarAccessChoices.NONE

    if calendar.kind == models.CalendarKindChoices.RESOURCE:
        same_org = models.Membership.objects.filter(
            organization=calendar.organization,
            user=viewer,
            status=models.MembershipStatusChoices.ACTIVE,
            organization__is_active=True,
        ).exists()
        return (
            models.CalendarAccessChoices.DETAILS
            if same_org
            else models.CalendarAccessChoices.NONE
        )

    grant = models.CalendarAccessGrant.objects.filter(
        calendar=calendar,
        grantee=viewer,
    ).first()
    same_org = models.Membership.objects.filter(
        organization=calendar.organization,
        user=viewer,
        status=models.MembershipStatusChoices.ACTIVE,
        organization__is_active=True,
    ).exists()
    owner_active = calendar.owner_id is None or models.Membership.objects.filter(
        organization=calendar.organization,
        user_id=calendar.owner_id,
        status=models.MembershipStatusChoices.ACTIVE,
        organization__is_active=True,
    ).exists()
    if not owner_active:
        return models.CalendarAccessChoices.NONE
    if same_org:
        return (
            grant.permission if grant else calendar.organization_default_access
        )
    viewer_active = models.Membership.objects.filter(
        user=viewer,
        status=models.MembershipStatusChoices.ACTIVE,
        organization__is_active=True,
    ).exists()
    if grant and viewer_active and accepted_external_contacts(calendar.owner, viewer):
        return grant.permission
    return models.CalendarAccessChoices.NONE


def may_share_calendar_with(owner, target, organization) -> bool:
    """Validate one explicit grant target without exposing another directory."""
    if owner.id == target.id:
        return False
    if models.Membership.objects.filter(
        organization=organization,
        user=target,
        status=models.MembershipStatusChoices.ACTIVE,
    ).exists():
        return True
    return accepted_external_contacts(owner, target)


def calendar_can_manage(calendar, viewer) -> bool:
    """Whether ``viewer`` may change settings, share, restore, or export."""
    return calendar_permission(calendar, viewer) == models.CalendarAccessChoices.ADMIN


def calendar_can_manage_for_deleted(calendar, viewer) -> bool:
    """Management check that deliberately ignores the soft-delete visibility gate."""
    if calendar.owner_id == viewer.id:
        return True
    return models.CalendarMembership.objects.filter(
        calendar=calendar,
        grantee=viewer,
        permission=models.CalendarAccessChoices.ADMIN,
    ).exists()


def calendar_can_write(calendar, viewer) -> bool:
    return calendar_permission(calendar, viewer) in (
        models.CalendarAccessChoices.WRITER,
        models.CalendarAccessChoices.ADMIN,
    )


def calendar_read_permission(permission: str) -> str:
    if permission in (
        models.CalendarAccessChoices.DETAILS,
        models.CalendarAccessChoices.WRITER,
        models.CalendarAccessChoices.ADMIN,
    ):
        return models.CalendarAccessChoices.DETAILS
    return permission


def event_calendar_owner_ids(event) -> set:
    """Owners whose personal calendars contain this event."""
    owner_ids = {event.organizer_id}
    owner_ids.update(
        event.attendees.exclude(rsvp=models.EventRSVPChoices.DECLINED)
        .exclude(user__isnull=True)
        .values_list("user_id", flat=True)
    )
    return owner_ids


def events_for_calendar(calendar):
    """Base queryset for a primary, shared, resource, or external calendar."""
    if calendar.kind in (
        models.CalendarKindChoices.SHARED,
        models.CalendarKindChoices.EXTERNAL,
    ):
        return models.CalendarEvent.objects.filter(source_calendar=calendar)
    if calendar.kind == models.CalendarKindChoices.RESOURCE:
        return models.CalendarEvent.objects.filter(
            room_bookings__room=calendar.meeting_room,
            room_bookings__status__in=("confirmed", "pending"),
        ).distinct()
    owner = calendar.owner
    return models.CalendarEvent.objects.filter(
        Q(organizer=owner, organization=calendar.organization)
        | Q(
            attendees__user=owner,
            attendees__rsvp__in=(
                models.EventRSVPChoices.NEEDS_ACTION,
                models.EventRSVPChoices.ACCEPTED,
                models.EventRSVPChoices.TENTATIVE,
            ),
        ),
    ).distinct()


def event_access_for_calendar_permission(
    event, viewer, permission, *, projection_calendar=None
) -> EventAccess:
    """Apply event visibility to one already-authorized calendar projection."""
    if event.organizer_id == viewer.id or any(
        attendee.user_id == viewer.id for attendee in event.attendees.all()
    ):
        return EventAccess.DETAILS
    # Mirrored third-party events contribute to the owner's personal busy/free
    # projection, but their provider details never inherit the primary
    # calendar's otherwise more permissive default.
    if (
        projection_calendar is not None
        and projection_calendar.kind == models.CalendarKindChoices.PRIMARY
        and event.source_calendar.kind == models.CalendarKindChoices.EXTERNAL
    ):
        return EventAccess.BUSY
    if event.visibility == models.EventVisibilityChoices.PRIVATE:
        return EventAccess.BUSY
    if event.visibility == models.EventVisibilityChoices.PUBLIC:
        return EventAccess.DETAILS
    return (
        EventAccess.DETAILS
        if calendar_read_permission(permission) == models.CalendarAccessChoices.DETAILS
        else EventAccess.BUSY
    )


def _event_access_through_calendar(event, viewer, calendar) -> EventAccess:
    """Resolve an event while explicitly viewing one subscribed calendar."""
    projected = (
        calendar.kind == models.CalendarKindChoices.PRIMARY
        and calendar.owner_id in event_calendar_owner_ids(event)
    ) or (
        calendar.kind
        in (models.CalendarKindChoices.SHARED, models.CalendarKindChoices.EXTERNAL)
        and event.source_calendar_id == calendar.id
    ) or (
        calendar.kind == models.CalendarKindChoices.RESOURCE
        and any(
            booking.room_id == calendar.meeting_room_id
            and booking.status in ("confirmed", "pending")
            for booking in event.room_bookings.all()
        )
    )
    if not projected:
        return EventAccess.NONE
    subscription = models.CalendarSubscription.objects.filter(
        calendar=calendar,
        subscriber=viewer,
        enabled=True,
    ).exists()
    if not subscription:
        return EventAccess.NONE
    permission = calendar_permission(calendar, viewer)
    if permission == models.CalendarAccessChoices.NONE:
        return EventAccess.NONE
    return event_access_for_calendar_permission(
        event,
        viewer,
        permission,
        projection_calendar=calendar,
    )


def resolve_event_access(
    event,
    viewer,
    *,
    calendar=None,
    include_source: bool = True,
) -> EventAccess:
    """Return NONE/BUSY/DETAILS for one event and authenticated viewer."""
    if not getattr(viewer, "is_authenticated", False):
        return EventAccess.NONE
    if event.organizer_id == viewer.id or any(
        attendee.user_id == viewer.id for attendee in event.attendees.all()
    ):
        return EventAccess.DETAILS

    decision = EventAccess.NONE
    if calendar is not None:
        decision = _event_access_through_calendar(event, viewer, calendar)
    else:
        owner_ids = event_calendar_owner_ids(event)
        subscriptions = models.CalendarSubscription.objects.filter(
            Q(calendar__owner_id__in=owner_ids)
            | Q(calendar_id=event.source_calendar_id),
            subscriber=viewer,
            enabled=True,
        ).select_related("calendar", "calendar__owner", "calendar__organization")
        for subscription in subscriptions:
            subscription_decision = _event_access_through_calendar(
                event, viewer, subscription.calendar
            )
            if subscription_decision == EventAccess.DETAILS:
                decision = subscription_decision
                break
            if subscription_decision == EventAccess.BUSY:
                decision = subscription_decision

    if decision != EventAccess.NONE:
        return decision

    if include_source and event.source_conversation_id:
        try:
            calendar_im_notify.verify_source_membership(
                viewer, event.source_conversation_id
            )
        except calendar_im_notify.SourceConversationAccessDenied:
            return EventAccess.NONE
        except calendar_im_notify.SourceConversationVerificationUnavailable as exc:
            raise SourceAccessUnavailable(str(exc)) from exc
        decision = (
            EventAccess.BUSY
            if event.visibility == models.EventVisibilityChoices.PRIVATE
            else EventAccess.DETAILS
        )
    return decision
