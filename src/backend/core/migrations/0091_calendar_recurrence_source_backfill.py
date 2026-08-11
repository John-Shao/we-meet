from datetime import timedelta

from django.db import migrations
from django.utils import timezone

MAX_LEAD_MINUTES = 2880


def _effective_lead(reminders):
    """Mirror the reminder worker's tolerant handling of legacy JSON values."""
    leads = []
    for raw in reminders or []:
        try:
            lead = int(raw)
        except (TypeError, ValueError):
            continue
        if 0 <= lead <= MAX_LEAD_MINUTES:
            leads.append(lead)
    return max(leads) if leads else None


def backfill_recurrence_sources(apps, schema_editor):
    CalendarEvent = apps.get_model("core", "CalendarEvent")
    now = timezone.now()
    children = (
        CalendarEvent.objects.filter(
            source_conversation_id="",
            recurrence_parent__isnull=False,
        )
        .exclude(recurrence_parent__source_conversation_id="")
        .select_related("recurrence_parent")
    )

    for child in children.iterator(chunk_size=500):
        updates = {
            "source_conversation_id": child.recurrence_parent.source_conversation_id
        }
        if child.reminder_pushed_at is None and child.status == "confirmed":
            lead = _effective_lead(child.reminders)
            if lead is not None:
                trigger_at = child.start_at - timedelta(minutes=lead)
                if trigger_at <= now:
                    # The old child could not have delivered to its source because
                    # it had none. Suppress a rollout-time stale backfill while
                    # keeping the outcome empty; a later move to a future trigger
                    # will re-arm it through the normal P0 rule.
                    updates["reminder_pushed_at"] = now
                    updates["reminder_outcome"] = ""
        CalendarEvent.objects.filter(pk=child.pk).update(**updates)


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0090_meeting_room_optional_name_required_code"),
    ]

    operations = [
        migrations.RunPython(
            backfill_recurrence_sources,
            migrations.RunPython.noop,
        ),
    ]
