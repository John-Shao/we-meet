import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0091_calendar_recurrence_source_backfill"),
    ]

    operations = [
        migrations.CreateModel(
            name="ExternalContact",
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
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("accepted", "Accepted"),
                            ("declined", "Declined"),
                        ],
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("responded_at", models.DateTimeField(blank=True, null=True)),
                (
                    "requested_by",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="external_contact_requests_sent",
                        to="core.user",
                    ),
                ),
                (
                    "user_a",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="external_contacts_as_a",
                        to="core.user",
                    ),
                ),
                (
                    "user_b",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="external_contacts_as_b",
                        to="core.user",
                    ),
                ),
            ],
            options={
                "verbose_name": "external contact",
                "verbose_name_plural": "external contacts",
                "db_table": "meet_external_contact",
                "ordering": ("-updated_at",),
                "indexes": [
                    models.Index(
                        fields=["user_a", "status"],
                        name="extcontact_a_status_idx",
                    ),
                    models.Index(
                        fields=["user_b", "status"],
                        name="extcontact_b_status_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("user_a", "user_b"),
                        name="one_external_contact_per_user_pair",
                    ),
                    models.CheckConstraint(
                        condition=~models.Q(user_a=models.F("user_b")),
                        name="external_contact_users_differ",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(requested_by=models.F("user_a"))
                        | models.Q(requested_by=models.F("user_b")),
                        name="external_contact_requester_in_pair",
                    ),
                ],
            },
        ),
    ]
