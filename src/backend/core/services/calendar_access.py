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
    calendar, _ = models.PersonalCalendar.objects.get_or_create(
        organization=organization,
        owner=user,
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


def calendar_permission(calendar, viewer) -> str:
    """Resolve the authorization behind a subscription.

    Same-organization members inherit the owner's calendar default; an
    explicit grant overrides it.  Cross-organization access requires both an
    accepted external-contact relationship and an explicit grant.
    """
    if calendar.owner_id == viewer.id:
        return models.CalendarAccessChoices.DETAILS

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
    owner_active = models.Membership.objects.filter(
        organization=calendar.organization,
        user=calendar.owner,
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
    """Base queryset projected onto one user's personal calendar."""
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


def event_access_for_calendar_permission(event, viewer, permission) -> EventAccess:
    """Apply event visibility to one already-authorized calendar projection."""
    if event.organizer_id == viewer.id or any(
        attendee.user_id == viewer.id for attendee in event.attendees.all()
    ):
        return EventAccess.DETAILS
    if event.visibility == models.EventVisibilityChoices.PRIVATE:
        return EventAccess.BUSY
    if event.visibility == models.EventVisibilityChoices.PUBLIC:
        return EventAccess.DETAILS
    return (
        EventAccess.DETAILS
        if permission == models.CalendarAccessChoices.DETAILS
        else EventAccess.BUSY
    )


def _event_access_through_calendar(event, viewer, calendar) -> EventAccess:
    """Resolve an event while explicitly viewing one subscribed calendar."""
    if calendar.owner_id not in event_calendar_owner_ids(event):
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
            subscriber=viewer,
            enabled=True,
            calendar__owner_id__in=owner_ids,
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
