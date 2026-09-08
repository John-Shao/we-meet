"""Repair existing Docs display names without invitations or user login."""

from django.core.management.base import BaseCommand, CommandError

from core.services.docs_client import DocsServiceError
from core.services.docs_profiles import sync_docs_profiles


class Command(BaseCommand):
    help = "Synchronize existing Docs users' names from the Meet directory"

    def handle(self, *args, **options):
        try:
            result = sync_docs_profiles()
        except DocsServiceError as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(f"Docs profiles: {result}")
