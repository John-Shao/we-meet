import uuid

import django.db.models.deletion
import django.db.models.functions.text
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0085_calendarevent_reminder_outcome_and_more")]

    operations = [
        migrations.CreateModel(
            name="ImDraft",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, help_text="primary key for the record as UUID", primary_key=True, serialize=False, verbose_name="id")),
                ("created_at", models.DateTimeField(auto_now_add=True, editable=False, help_text="date and time at which a record was created", verbose_name="created on")),
                ("updated_at", models.DateTimeField(auto_now=True, editable=False, help_text="date and time at which a record was last updated", verbose_name="updated on")),
                ("cid", models.CharField(max_length=64, verbose_name="conversation id")),
                ("text", models.TextField(blank=True, default="", max_length=4000, verbose_name="text")),
                ("reply", models.JSONField(blank=True, null=True, verbose_name="reply snapshot")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="im_drafts", to="core.user")),
            ],
            options={"db_table": "meet_im_draft", "ordering": ("-updated_at",)},
        ),
        migrations.CreateModel(
            name="ImUserPreference",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, help_text="primary key for the record as UUID", primary_key=True, serialize=False, verbose_name="id")),
                ("created_at", models.DateTimeField(auto_now_add=True, editable=False, help_text="date and time at which a record was created", verbose_name="created on")),
                ("updated_at", models.DateTimeField(auto_now=True, editable=False, help_text="date and time at which a record was last updated", verbose_name="updated on")),
                ("recent_emojis", models.JSONField(blank=True, default=list, verbose_name="recent emojis")),
                ("user", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="im_preference", to="core.user")),
            ],
            options={"db_table": "meet_im_user_preference"},
        ),
        migrations.CreateModel(
            name="OrganizationEmoji",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, help_text="primary key for the record as UUID", primary_key=True, serialize=False, verbose_name="id")),
                ("created_at", models.DateTimeField(auto_now_add=True, editable=False, help_text="date and time at which a record was created", verbose_name="created on")),
                ("updated_at", models.DateTimeField(auto_now=True, editable=False, help_text="date and time at which a record was last updated", verbose_name="updated on")),
                ("name", models.CharField(max_length=32, verbose_name="name")),
                ("object_key", models.CharField(max_length=500, unique=True, verbose_name="object key")),
                ("content_type", models.CharField(max_length=32, verbose_name="content type")),
                ("byte_size", models.PositiveIntegerField(verbose_name="byte size")),
                ("width", models.PositiveSmallIntegerField(verbose_name="width")),
                ("height", models.PositiveSmallIntegerField(verbose_name="height")),
                ("is_animated", models.BooleanField(default=False, verbose_name="animated")),
                ("sort_order", models.PositiveIntegerField(default=0, verbose_name="sort order")),
                ("is_active", models.BooleanField(default=True, verbose_name="active")),
                ("created_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="created_organization_emojis", to="core.user")),
                ("organization", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="custom_emojis", to="core.organization")),
            ],
            options={"db_table": "meet_organization_emoji", "ordering": ("sort_order", "created_at")},
        ),
        migrations.AddConstraint(
            model_name="imdraft",
            constraint=models.UniqueConstraint(fields=("user", "cid"), name="one_im_draft_per_user_conversation"),
        ),
        migrations.AddConstraint(
            model_name="organizationemoji",
            constraint=models.UniqueConstraint(django.db.models.functions.text.Lower("name"), models.F("organization"), name="organization_emoji_name_ci_unique"),
        ),
    ]
