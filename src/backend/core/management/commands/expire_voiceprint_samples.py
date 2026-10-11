"""Bounded sweep for the independent voiceprint audio retention window."""

import json

from django.core.management.base import BaseCommand, CommandError
from django.db.models import F, Q
from django.utils import timezone

from core import models
from core.services.voiceprint_retention import expire_sample


class Command(BaseCommand):
    help = (
        "Clear expired voiceprint audio and unconfirmed features without touching ASR."
    )

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=100)

    def handle(self, *args, **options):
        limit = options["limit"]
        if not 1 <= limit <= 1000:
            raise CommandError("Limit must be between 1 and 1000.")
        rows = (
            models.VoiceprintSample.objects.filter(expires_at__lte=timezone.now())
            .filter(
                ~Q(encrypted_audio=b"")
                | Q(status__in=["pending", "processing", "ready"])
                | (
                    ~Q(encrypted_embedding=b"")
                    & (
                        ~Q(status="confirmed")
                        | ~Q(generation=F("profile__consent__generation"))
                    )
                )
                | (
                    ~Q(generation=F("profile__consent__generation"))
                    & ~Q(status="deleted")
                ),
            )
            .order_by("expires_at", "id")
            .values_list("pk", flat=True)[:limit]
        )
        count = sum(expire_sample(identifier) for identifier in list(rows))
        self.stdout.write(json.dumps({"expired": count}, sort_keys=True))
