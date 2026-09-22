"""Object-scoped collaboration; forwarding a link never writes an access grant."""

import hashlib
import json
from functools import partial

from django.conf import settings
from django.db import transaction
from django.db.models import BooleanField, Case, Exists, OuterRef, Q, When

from core import models

SCOPES = {"record": "read_transcript", "minutes": "read_summary"}
ROLES = {"reader", "editor", "manager"}


def annotate_access(queryset, user, own, legacy, managers):
    """Keep old readers' access until an explicit object-specific change overrides it."""
    departments = models.Membership.objects.filter(
        user=user,
        status="active",
        department__is_active=True,
        department__deleted_at__isnull=True,
    ).values("department__team_key")
    groups = models.UserGroupMember.objects.filter(
        user=user, group__is_active=True, group__deleted_at__isnull=True
    ).values("group__group_key")
    for scope, ability in SCOPES.items():
        policies = models.MeetingCollaboration.objects.filter(
            record_id=OuterRef("pk"), scope=scope
        )
        grants = models.MeetingCollaborator.objects.filter(
            record_id=OuterRef("pk"), scope=scope, user=user
        )
        teams = models.MeetingCollaborationTeam.objects.filter(
            record_id=OuterRef("pk"), scope=scope
        ).filter(Q(team__in=departments) | Q(team__in=groups))
        old = models.MeetingRecordAccess.objects.filter(
            record_id=OuterRef("pk"), user=user, **{ability: True}
        )
        transferred = Exists(policies.filter(owner__isnull=False))
        owner = Exists(policies.filter(owner=user)) | (~transferred & own)
        inherited_manager = ~transferred & managers
        default_read = (~transferred & (own | legacy)) | Exists(old)
        link = Q(organization__isnull=False) & Exists(
            policies.filter(link_scope="organization")
        )
        # Organization membership is already enforced by visible_records.
        queryset = queryset.annotate(
            **{
                f"can_{ability}": Case(
                    When(
                        owner
                        | Exists(grants.filter(role__in=ROLES))
                        | Exists(teams)
                        | link,
                        then=True,
                    ),
                    When(Exists(grants), then=False),
                    When(default_read, then=True),
                    default=False,
                    output_field=BooleanField(),
                ),
                f"collaboration_{scope}_owner": owner,
                f"collaboration_{scope}_manage": owner
                | Exists(grants.filter(role="manager"))
                | Exists(teams.filter(role="manager"))
                | (~Exists(grants) & inherited_manager),
                f"collaboration_{scope}_edit": owner
                | Exists(grants.filter(role__in=["manager", "editor"]))
                | Exists(teams.filter(role__in=["manager", "editor"]))
                | (~Exists(grants) & inherited_manager),
            }
        )
        if scope == "record":
            queryset = queryset.annotate(
                collaboration_media=owner
                | Exists(grants.filter(role__in=ROLES, media=True))
                | Exists(teams)
                | link
            )
    return queryset


def scoped_record(record, user):
    from core.services.meeting_records import visible_records  # noqa: PLC0415

    if not user or not models.User.objects.filter(pk=user.pk, is_active=True).exists():
        return None
    return visible_records(user).filter(pk=record.pk).first()


def can_manage(record, user, scope):
    scoped = scoped_record(record, user)
    return bool(scoped and getattr(scoped, f"collaboration_{scope}_manage"))


def _legacy_members(record, scope):
    field = SCOPES[scope]
    result = {
        str(row.user_id): {"user": row.user, "role": "reader", "inherited": True}
        for row in record.accesses.filter(**{field: True}).select_related("user")
    }
    policy = record.collaboration_policies.filter(scope=scope).first()
    if not policy or not policy.owner_id:
        if record.meeting_session_id:
            for row in models.ResourceAccess.objects.filter(
                resource_id=record.meeting_session.room_id
            ).select_related("user"):
                role = {
                    "owner": "owner",
                    "administrator": "manager",
                    "admin": "manager",
                }.get(row.role, "reader")
                result[str(row.user_id)] = {
                    "user": row.user,
                    "role": role,
                    "inherited": True,
                }
        elif record.owner_id:
            result[str(record.owner_id)] = {
                "user": record.owner,
                "role": "owner",
                "inherited": True,
            }
    for row in record.collaborators.filter(scope=scope).select_related("user"):
        if row.role == "none":
            result.pop(str(row.user_id), None)
        else:
            result[str(row.user_id)] = {
                "user": row.user,
                "role": row.role,
                "inherited": False,
            }
    if policy and policy.owner_id:
        result[str(policy.owner_id)] = {
            "user": policy.owner,
            "role": "owner",
            "inherited": False,
        }
    return result


def state(record, user, scope):
    from core.services import collaboration_notifications as notices  # noqa: PLC0415

    scoped = scoped_record(record, user)
    if not scoped or not getattr(scoped, f"can_{SCOPES[scope]}"):
        raise PermissionError
    policy = record.collaboration_policies.filter(scope=scope).first()
    members = _legacy_members(record, scope)
    # Resolve legacy room ownership separately from admin status.
    own = bool(getattr(scoped, f"collaboration_{scope}_owner"))
    if not policy or not policy.owner_id:
        own = own or members.get(str(user.pk), {}).get("role") == "owner"
    rows = [
        {
            "id": key,
            "name": value["user"].full_name or "",
            "role": value["role"],
            "active": value["user"].is_active,
            "inherited": value["inherited"],
        }
        for key, value in members.items()
    ]
    team_names = {
        row.team_key: (row.name, row.is_active and row.deleted_at is None)
        for row in models.Department.objects.filter(
            organization_id=record.organization_id
        )
    }
    team_names.update(
        {
            row.group_key: (row.name, row.is_active and row.deleted_at is None)
            for row in models.UserGroup.objects.filter(
                organization_id=record.organization_id
            )
        }
    )
    for grant in record.collaboration_teams.filter(scope=scope):
        name, active = team_names.get(grant.team, (grant.team, False))
        rows.append(
            {
                "id": grant.team,
                "name": name,
                "active": active,
                "role": grant.role,
                "inherited": False,
            }
        )
    rows.sort(key=lambda row: (row["role"] != "owner", row["name"], row["id"]))
    return {
        "scope": scope,
        "record_id": str(record.pk),
        "revision": policy.revision if policy else 0,
        "can_manage": bool(
            settings.MEETING_SUMMARY_SHARING_ENABLED
            and getattr(scoped, f"collaboration_{scope}_manage")
        ),
        "is_owner": own,
        "link_scope": policy.link_scope if policy else "private",
        "can_link_organization": bool(record.organization_id),
        "results": rows,
        "count": len(rows),
        "can_notify": notices.available(),
        "pending_notifications": models.MeetingCollaborationNotice.objects.filter(
            receipt__policy__record=record,
            receipt__policy__scope=scope,
            receipt__actor=user,
            status="pending",
        ).count(),
    }


@transaction.atomic
def change(record_id, actor, scope, key, payload):  # noqa: PLR0912, PLR0915
    """Serialize policy revisions and preserve receipts without replaying removed grants."""
    from core.services.meeting_records import RecordConflict  # noqa: PLC0415
    from core.services.meeting_summary_sharing import eligible_users  # noqa: PLC0415

    models.User.objects.select_for_update().get(pk=actor.pk)
    record = models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    if not can_manage(record, actor, scope):
        raise PermissionError
    digest = hashlib.sha256(
        json.dumps([str(record_id), scope, payload], sort_keys=True).encode()
    ).hexdigest()
    previous = models.MeetingCollaborationReceipt.objects.filter(
        actor=actor, key=key
    ).first()
    if previous:
        if previous.request_hash != digest:
            raise RecordConflict("Request key conflicts.")
        return {**previous.result, "replayed": True}
    current = state(record, actor, scope)
    if current["revision"] != payload["expected_revision"]:
        raise RecordConflict("Collaboration changed. Refresh before retrying.")
    policy, _ = models.MeetingCollaboration.objects.get_or_create(
        record=record, scope=scope
    )
    operation = payload["operation"]
    existing = {row["id"]: row for row in current["results"]}
    if operation == "link":
        if payload["link_scope"] == "organization" and not record.organization_id:
            raise RecordConflict("An organization is required.")
        policy.link_scope = payload["link_scope"]
    else:
        members = payload["members"]
        ids = [row["id"] for row in members]
        user_ids = [uid for uid in ids if ":" not in uid]
        team_ids = [uid for uid in ids if ":" in uid]
        eligible_teams = (
            set(
                models.Department.objects.filter(
                    organization_id=record.organization_id,
                    is_active=True,
                    deleted_at__isnull=True,
                ).values_list("team_key", flat=True)
            )
            if record.organization_id
            else set()
        )
        if scope == "minutes" and record.organization_id:
            eligible_teams.update(
                models.UserGroup.objects.filter(
                    organization_id=record.organization_id,
                    is_active=True,
                    deleted_at__isnull=True,
                ).values_list("group_key", flat=True)
            )
        if operation == "invite" and (
            eligible_users(record, actor).filter(pk__in=user_ids).count()
            != len(user_ids)
            or not set(team_ids) <= eligible_teams
        ):
            raise RecordConflict("Recipient selection changed.")
        if operation != "invite" and any(uid not in existing for uid in ids):
            raise RecordConflict("Collaborator no longer exists.")
        if any(existing.get(uid, {}).get("role") == "owner" for uid in ids):
            raise RecordConflict("Transfer ownership before changing an owner.")
        if operation == "transfer":
            if (
                team_ids
                or not current["is_owner"]
                or len(ids) != 1
                or not eligible_users(record, actor).filter(pk=ids[0]).exists()
            ):
                raise PermissionError
            # Preserve existing collaborators while detaching this object's
            # ownership from the legacy room/record owner.
            for row in current["results"]:
                if ":" in row["id"]:
                    continue
                models.MeetingCollaborator.objects.get_or_create(
                    record=record,
                    scope=scope,
                    user_id=row["id"],
                    defaults={
                        "role": "manager" if row["role"] == "owner" else row["role"],
                        "media": scope == "record" and row["role"] == "owner",
                    },
                )
            policy.owner_id = ids[0]
        else:
            for member in members:
                if ":" in member["id"]:
                    if operation == "remove":
                        record.collaboration_teams.filter(
                            scope=scope, team=member["id"]
                        ).delete()
                    else:
                        models.MeetingCollaborationTeam.objects.update_or_create(
                            record=record,
                            scope=scope,
                            team=member["id"],
                            defaults={"role": member["role"]},
                        )
                    continue
                models.MeetingCollaborator.objects.update_or_create(
                    record=record,
                    scope=scope,
                    user_id=member["id"],
                    defaults={
                        "role": "none" if operation == "remove" else member["role"],
                        "media": scope == "record" and operation != "remove",
                    },
                )
    policy.revision += 1
    policy.save()
    result = {
        "scope": scope,
        "record_id": str(record.pk),
        "revision": policy.revision,
        "replayed": False,
    }
    receipt = models.MeetingCollaborationReceipt.objects.create(
        policy=policy, actor=actor, key=key, request_hash=digest, result=result
    )
    if operation == "invite" and payload.get("notify"):
        from core.services import (  # noqa: PLC0415
            collaboration_notifications as notices,
        )

        recipients = set(user_ids)
        for team in team_ids:
            if team.startswith("dept:"):
                recipients.update(
                    str(pk)
                    for pk in models.Membership.objects.filter(
                        department__team_key=team, status="active"
                    ).values_list("user_id", flat=True)
                )
            else:
                recipients.update(
                    str(pk)
                    for pk in models.UserGroupMember.objects.filter(
                        group__group_key=team
                    ).values_list("user_id", flat=True)
                )
        for uid in recipients:
            notice = models.MeetingCollaborationNotice.objects.create(
                receipt=receipt, recipient_id=uid, note=payload.get("note", "")
            )
            transaction.on_commit(partial(notices.dispatch, notice.pk))
    return result
