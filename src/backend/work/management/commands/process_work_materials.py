"""Process durable material jobs without depending on a broker wakeup."""

from django.core.management.base import BaseCommand

from work.services import process_materials


class Command(BaseCommand):
    help = "Process up to 20 pending Work materials and retry deferred file cleanup."

    def handle(self, *args, **options):
        self.stdout.write(f"Processed {process_materials()} Work materials.")
