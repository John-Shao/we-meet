"""Project the Host directory into work.org/work.member (D2 §2.8)."""

import logging

from core.models import Membership, Organization

from work.api.context import role_cursor

logger = logging.getLogger(__name__)

ROLE_MAP = {
    "owner": "owner",
    "administrator": "admin",
    "dept_admin": "member",
    "member": "member",
}


def _revision(instance) -> int:
    return int(instance.updated_at.timestamp())


def _org_status(org: Organization) -> str:
    if org.archived_at is not None:
        return "archived"
    return "active" if org.is_active else "suspended"


def sync_org(org: Organization) -> None:
    with role_cursor(str(org.id), "work_directory") as cursor:
        cursor.execute(
            "SELECT work.sync_org_projection(%s, %s, %s, %s, %s, %s)",
            [
                str(org.id),
                org.name,
                _org_status(org),
                org.is_active and org.archived_at is None,
                "cn-north",
                _revision(org),
            ],
        )


def sync_member(membership: Membership) -> None:
    org_id = str(membership.organization_id)
    # Resolve the core user before switching to work_directory: that role has
    # no SELECT on meet_user, and a lazy FK load inside the block would 503.
    subject_id = membership.user.sub
    with role_cursor(org_id, "work_directory") as cursor:
        cursor.execute(
            "SELECT work.sync_member_projection(%s, %s, %s, %s, %s, %s)",
            [
                org_id,
                subject_id,
                membership.status,
                ROLE_MAP.get(membership.org_role, "member"),
                membership.status == "active",
                _revision(membership),
            ],
        )


def run_once() -> dict:
    """Incremental pass over all organizations and memberships."""
    synced_orgs = 0
    synced_members = 0
    for org in Organization.objects.all().order_by("id"):
        try:
            sync_org(org)
            synced_orgs += 1
        except Exception:
            logger.exception("work directory org sync failed org_id=%s", org.id)
            continue
        for membership in Membership.objects.filter(organization=org).select_related(
            "user"
        ):
            try:
                sync_member(membership)
                synced_members += 1
            except Exception:
                logger.exception(
                    "work directory member sync failed org_id=%s subject=%s",
                    org.id,
                    membership.user_id,
                )
    return {"orgs": synced_orgs, "members": synced_members}
