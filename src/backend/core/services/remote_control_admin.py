"""Organization-admin policy management; no client-selected organization scope."""

import hashlib
import json

from django.db import transaction
from django.db.models import Q

from core import models
from core.services import remote_control as remote
from core.services import remote_control_policy as policies
from core.services.remote_control_livekit import RemoteControlError

ADMIN_ROLES = (models.OrgRoleChoices.OWNER, models.OrgRoleChoices.ADMIN)


def _organization(user, *, lock=False):
    remote.human(user)
    # Never trust the request-instance directory cache for a mutation.
    users = (
        models.User.objects.select_for_update(no_key=True)
        if lock
        else models.User.objects
    )
    current = users.filter(pk=user.pk).first()
    remote.human(current)
    membership = (
        models.Membership.objects.filter(
            user=current, status=models.MembershipStatusChoices.ACTIVE
        )
        .order_by("-is_primary", "created_at")
        .first()
    )
    if membership is None:
        raise RemoteControlError("remote_control_admin_required", 403)
    organizations = models.Organization.objects
    if lock:
        organizations = organizations.select_for_update()
    organization = organizations.filter(pk=membership.organization_id).first()
    # The lock may have waited behind another transaction; refresh both the
    # account and the selected organization before checking the role.
    current.refresh_from_db()
    remote.human(current)
    selected = (
        models.Membership.objects.filter(
            user=current, status=models.MembershipStatusChoices.ACTIVE
        )
        .order_by("-is_primary", "created_at")
        .first()
    )
    if (
        not organization
        or not selected
        or selected.organization_id != organization.pk
        or not organization.is_active
        or not models.Membership.objects.filter(
            user=current,
            organization=organization,
            status=models.MembershipStatusChoices.ACTIVE,
            org_role__in=ADMIN_ROLES,
        ).exists()
    ):
        raise RemoteControlError("remote_control_admin_required", 403)
    return organization


def _stored(organization):
    configuration = organization.settings
    return (
        configuration.get("remote_control", {})
        if isinstance(configuration, dict)
        else None
    )


def _version(organization):
    # Invalid/legacy JSON remains repairable; never expose its raw content.
    raw = json.dumps(_stored(organization), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _members(organization):
    return (
        models.User.objects.filter(
            memberships__organization=organization,
            memberships__status=models.MembershipStatusChoices.ACTIVE,
            is_active=True,
            is_device=False,
            sub__isnull=False,
        )
        .exclude(sub="")
        .distinct()
    )


def _person(user):
    return {
        "id": str(user.pk),
        "name": user.full_name or user.short_name or str(user.sub),
    }


def _view(organization):
    try:
        policy = policies.normalize(_stored(organization))
        valid = True
    except RemoteControlError:
        policy, valid = dict(policies.DEFAULTS), False
    ids = set((policy["controllers"] or []) + (policy["targets"] or []))
    return {
        "organizationId": str(organization.pk),
        "policy": policy,
        "version": _version(organization),
        "valid": valid,
        "globalEnabled": remote.enabled(),
        "openSessions": models.RemoteControlSession.objects.filter(
            organization=organization, state__in=remote.OPEN
        ).count(),
        "members": [
            _person(user)
            for user in _members(organization).filter(pk__in=ids).order_by("pk")
        ],
    }


@transaction.atomic
def read_policy(user):
    organization = _organization(user)
    policies.share_organization(organization.pk)
    organization.refresh_from_db()
    return _view(organization)


def candidates(user, *, query="", after=None):
    organization = _organization(user)
    rows = _members(organization).order_by("pk")
    if query:
        rows = rows.filter(
            Q(full_name__icontains=query) | Q(short_name__icontains=query)
        )
    if after:
        rows = rows.filter(pk__gt=after)
    page = list(rows[:51])
    return {
        "results": [_person(user) for user in page[:50]],
        "next_cursor": str(page[49].pk) if len(page) > 50 else None,
    }


@transaction.atomic
def update_policy(user, *, value=None, version=None, emergency=False):
    organization = _organization(user, lock=True)
    before = _version(organization)
    if not emergency and version != before:
        raise RemoteControlError("policy_version_conflict", 409)
    if emergency:
        try:
            value = policies.normalize(_stored(organization))
        except RemoteControlError:
            value = dict(policies.DEFAULTS)
        value = {**value, "enabled": False}
    else:
        value = policies.normalize(value, complete=True)
        ids = set((value["controllers"] or []) + (value["targets"] or []))
        if _members(organization).filter(pk__in=ids).count() != len(ids):
            raise RemoteControlError("invalid_remote_control_members", 400)
    previous = organization.settings if isinstance(organization.settings, dict) else {}
    organization.settings = {**previous, "remote_control": value}
    organization.save(update_fields=["settings", "updated_at"])
    after = _version(organization)
    reason = (
        "organization_emergency_close" if emergency else "organization_policy_changed"
    )
    # Account -> organization -> session matches existing organization services.
    # No new account lock is acquired below the organization lock. Even widening
    # a policy requires a fresh request and local target consent.
    rows = (
        models.RemoteControlSession.objects.select_for_update()
        .filter(organization=organization, state__in=remote.OPEN)
        .order_by("pk")
    )
    revoked = 0
    if emergency or before != after:
        for row in rows:
            remote._finish(row, "ENDED", reason, user)  # noqa: SLF001 -- Shared terminal transition owns lifecycle audit/notification.
            revoked += 1
    models.AuditLog.objects.create(
        organization=organization,
        actor=user,
        action=(
            models.AuditActionChoices.REMOTE_CONTROL_EMERGENCY_CLOSED
            if emergency
            else models.AuditActionChoices.REMOTE_CONTROL_POLICY_CHANGED
        ),
        target_type="remote_control_policy",
        target_id=str(organization.pk),
        metadata={"before": before, "after": after, "revokedSessions": revoked},
    )
    return {**_view(organization), "revokedSessions": revoked}
