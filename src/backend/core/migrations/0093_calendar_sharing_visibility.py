import uuid

import django.db.models.deletion
from django.db import migrations, models
from django.utils import timezone


def create_personal_calendars(apps, schema_editor):
    Membership = apps.get_model("core", "Membership")
    PersonalCalendar = apps.get_model("core", "PersonalCalendar")
    now = timezone.now()
    pairs = Membership.objects.filter(
        status="active",
        organization__is_active=True,
        user__is_active=True,
    ).values_list("organization_id", "user_id").distinct()
    rows = []
    for organization_id, user_id in pairs.iterator(chunk_size=1000):
        rows.append(
            PersonalCalendar(
                id=uuid.uuid4(),
                organization_id=organization_id,
                owner_id=user_id,
                organization_default_access="free_busy",
                created_at=now,
                updated_at=now,
            )
        )
        if len(rows) == 1000:
            PersonalCalendar.objects.bulk_create(
                rows, ignore_conflicts=True, batch_size=1000
            )
            rows.clear()
    if rows:
        PersonalCalendar.objects.bulk_create(
            rows, ignore_conflicts=True, batch_size=1000
        )


class Migration(migrations.Migration):
    dependencies = [("core", "0092_external_contacts")]

    operations = [
        migrations.CreateModel(
            name="PersonalCalendar",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text="primary key for the record as UUID",
                        primary_key=True,
                        serialize=False,
                        verbose_name="id",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        editable=False,
                        help_text="date and time at which a record was created",
                        verbose_name="created on",
                    ),
                ),
                (
                    "updated_at",
                    models.DateTimeField(
                        auto_now=True,
                        editable=False,
                        help_text="date and time at which a record was last updated",
                        verbose_name="updated on",
                    ),
                ),
                (
                    "organization_default_access",
                    models.CharField(
                        choices=[
                            ("none", "Not shared"),
                            ("free_busy", "Free/busy only"),
                            ("details", "Event details"),
                        ],
                        default="free_busy",
                        help_text=(
                            "Access inherited by active members of this organization "
                            "unless an explicit grant overrides it."
                        ),
                        max_length=16,
                    ),
                ),
                (
                    "organization",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="personal_calendars",
                        to="core.organization",
                    ),
                ),
                (
                    "owner",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="personal_calendars",
                        to="core.user",
                    ),
                ),
            ],
            options={
                "db_table": "meet_personal_calendar",
                "ordering": ("created_at",),
                "indexes": [
                    models.Index(
                        fields=["organization", "owner"],
                        name="personalcal_org_owner_idx",
                    )
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("organization", "owner"),
                        name="personal_calendar_unique_org_owner",
                    )
                ],
            },
        ),
        migrations.CreateModel(
            name="CalendarAccessGrant",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text="primary key for the record as UUID",
                        primary_key=True,
                        serialize=False,
                        verbose_name="id",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        editable=False,
                        help_text="date and time at which a record was created",
                        verbose_name="created on",
                    ),
                ),
                (
                    "updated_at",
                    models.DateTimeField(
                        auto_now=True,
                        editable=False,
                        help_text="date and time at which a record was last updated",
                        verbose_name="updated on",
                    ),
                ),
                (
                    "permission",
                    models.CharField(
                        choices=[
                            ("free_busy", "Free/busy only"),
                            ("details", "Event details"),
                        ],
                        max_length=16,
                    ),
                ),
                (
                    "calendar",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="access_grants",
                        to="core.personalcalendar",
                    ),
                ),
                (
                    "grantee",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="calendar_access_grants",
                        to="core.user",
                    ),
                ),
            ],
            options={
                "db_table": "meet_calendar_access_grant",
                "ordering": ("calendar_id", "created_at"),
                "indexes": [
                    models.Index(
                        fields=["grantee", "permission"],
                        name="calgrant_grantee_perm_idx",
                    )
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("calendar", "grantee"),
                        name="calendar_grant_unique_calendar_grantee",
                    )
                ],
            },
        ),
        migrations.CreateModel(
            name="CalendarSubscription",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text="primary key for the record as UUID",
                        primary_key=True,
                        serialize=False,
                        verbose_name="id",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        editable=False,
                        help_text="date and time at which a record was created",
                        verbose_name="created on",
                    ),
                ),
                (
                    "updated_at",
                    models.DateTimeField(
                        auto_now=True,
                        editable=False,
                        help_text="date and time at which a record was last updated",
                        verbose_name="updated on",
                    ),
                ),
                ("enabled", models.BooleanField(default=True)),
                ("color", models.CharField(blank=True, default="", max_length=16)),
                (
                    "calendar",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="subscriptions",
                        to="core.personalcalendar",
                    ),
                ),
                (
                    "subscriber",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="calendar_subscriptions",
                        to="core.user",
                    ),
                ),
            ],
            options={
                "db_table": "meet_calendar_subscription",
                "ordering": ("created_at",),
                "indexes": [
                    models.Index(
                        fields=["subscriber", "enabled"],
                        name="calsub_subscriber_enabled_idx",
                    )
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("calendar", "subscriber"),
                        name="calendar_subscription_unique_calendar_subscriber",
                    )
                ],
            },
        ),
        migrations.RunPython(create_personal_calendars, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="calendarevent",
            name="visibility",
            field=models.CharField(
                choices=[
                    ("default", "Default"),
                    ("public", "Public"),
                    ("private", "Private"),
                ],
                default="default",
                max_length=20,
            ),
        ),
    ]
