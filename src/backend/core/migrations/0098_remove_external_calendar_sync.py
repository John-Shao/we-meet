from django.db import migrations, models


def remove_external_calendar_mirrors(apps, schema_editor):
    """Remove provider-owned local mirrors before dropping sync metadata."""
    Calendar = apps.get_model("core", "Calendar")
    ContentType = apps.get_model("contenttypes", "ContentType")
    Calendar.objects.filter(kind="external").delete()
    ContentType.objects.filter(
        app_label="core",
        model__in=(
            "calendarsyncoutbox",
            "externalcalendaraccount",
            "externalcalendarbinding",
            "externaleventmirror",
        ),
    ).delete()


class Migration(migrations.Migration):
    # PostgreSQL cannot drop the provider tables in the same transaction that
    # cascades deletion through their deferred foreign-key triggers. Commit the
    # mirror cleanup before applying the schema operations below.
    atomic = False

    dependencies = [("core", "0097_require_event_source_calendar")]

    operations = [
        migrations.RunPython(
            remove_external_calendar_mirrors,
            migrations.RunPython.noop,
        ),
        migrations.DeleteModel(name="CalendarSyncOutbox"),
        migrations.DeleteModel(name="ExternalEventMirror"),
        migrations.DeleteModel(name="ExternalCalendarBinding"),
        migrations.DeleteModel(name="ExternalCalendarAccount"),
        migrations.RemoveField(model_name="calendarevent", name="sync_status"),
        migrations.AlterField(
            model_name="calendar",
            name="kind",
            field=models.CharField(
                choices=[
                    ("primary", "Primary calendar"),
                    ("shared", "Shared calendar"),
                    ("resource", "Resource calendar"),
                ],
                default="primary",
                max_length=16,
            ),
        ),
    ]
