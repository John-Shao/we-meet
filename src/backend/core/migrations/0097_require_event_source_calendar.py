import django.db.models.deletion
from django.db import migrations, models


def backfill_missing_source_calendars(apps, schema_editor):
    Calendar = apps.get_model("core", "Calendar")
    CalendarEvent = apps.get_model("core", "CalendarEvent")
    for event in CalendarEvent.objects.filter(source_calendar__isnull=True).iterator(
        chunk_size=500
    ):
        calendar, _ = Calendar.objects.get_or_create(
            organization_id=event.organization_id,
            owner_id=event.organizer_id,
            kind="primary",
            defaults={"organization_default_access": "free_busy"},
        )
        CalendarEvent.objects.filter(pk=event.pk).update(source_calendar_id=calendar.pk)


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0096_alter_calendar_description_alter_calendar_name_and_more")
    ]

    operations = [
        migrations.RunPython(
            backfill_missing_source_calendars,
            migrations.RunPython.noop,
        ),
        migrations.AlterField(
            model_name="calendarevent",
            name="source_calendar",
            field=models.ForeignKey(
                help_text=(
                    "Owning calendar. Legacy writers that omit it are assigned the "
                    "organizer's primary calendar before persistence."
                ),
                on_delete=django.db.models.deletion.CASCADE,
                related_name="source_events",
                to="core.calendar",
            ),
        ),
    ]
