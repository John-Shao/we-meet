"""Run one bounded summary scheduling/outbox pass without calling a model inline."""

from django.core.management.base import BaseCommand

from core.services.meeting_summary_automation import tick_automations


class Command(BaseCommand):
    """Operational recovery uses the same consent and rollout checks as Beat."""

    def handle(self, *args, **options):
        self.stdout.write(str(tick_automations()))
