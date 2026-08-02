# Data migration — P10 M2: stamp existing rooms with their owner's organization.
#
# ``Room`` has no creator column; ownership lives in ``ResourceAccess`` with
# ``role='owner'``. So the backfill goes room → owner access → that user's
# primary active membership → organization.
#
# Rooms whose owner has no membership (or no owner at all) are left null on
# purpose. The column exists for **reporting scope**, not for access control —
# guessing an organization for an unattributable room would put a stranger's
# meeting into somebody's dashboard, which is worse than a null.

from django.db import migrations


def backfill(apps, schema_editor):
    Room = apps.get_model("core", "Room")
    ResourceAccess = apps.get_model("core", "ResourceAccess")
    Membership = apps.get_model("core", "Membership")

    owner_by_room = dict(
        ResourceAccess.objects.filter(role="owner", user__isnull=False)
        .values_list("resource_id", "user_id")
    )
    if not owner_by_room:
        return

    org_by_user = {}
    for user_id, organization_id in (
        Membership.objects.filter(
            user_id__in=set(owner_by_room.values()), status="active"
        )
        .order_by("-is_primary")
        .values_list("user_id", "organization_id")
    ):
        org_by_user.setdefault(user_id, organization_id)

    # Group rooms by organization so this is one UPDATE per org, not per room —
    # a deployment with tens of thousands of rooms should not run that many
    # statements inside a migration.
    rooms_by_org = {}
    for room_id, user_id in owner_by_room.items():
        organization_id = org_by_user.get(user_id)
        if organization_id is not None:
            rooms_by_org.setdefault(organization_id, []).append(room_id)

    for organization_id, room_ids in rooms_by_org.items():
        Room.objects.filter(resource_id__in=room_ids).update(
            organization_id=organization_id
        )


def unbackfill(apps, schema_editor):
    apps.get_model("core", "Room").objects.update(organization=None)


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0075_ai_usage_and_activity"),
    ]

    operations = [
        migrations.RunPython(backfill, reverse_code=unbackfill),
    ]
