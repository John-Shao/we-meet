"""A bounded internal baseline build batch; never accepts a caller's vectors."""

import json

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db.models import F, Q

from core import models
from core.services.voiceprint_encoder import FEATURE_SPACE
from core.services.voiceprint_templates import build


class Command(BaseCommand):
    help = "Build encrypted baselines and device groups from quality-checked owner confirmations."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=10)

    def handle(self, *args, **options):
        limit = options["limit"]
        if not 1 <= limit <= 100:
            raise CommandError("Limit must be between 1 and 100.")
        counts = dict.fromkeys(
            [
                "built",
                "unchanged",
                "disabled",
                "unavailable",
                "insufficient_audio",
                "mixed_speaker",
                "invalid_contributions",
            ],
            0,
        )
        enabled = (
            settings.MEETING_VOICEPRINT_ENABLED
            and settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED
        )
        if enabled:
            ids = (
                models.VoiceprintProfile.objects.filter(
                    Q(consent__allow_enrollment=True)
                    | Q(status="active")
                    | Q(status="paused", confirmed_at__isnull=False),
                    generation=F("consent__generation"),
                    feature_space=FEATURE_SPACE,
                    status__in=["pending", "paused", "active"],
                    consent__user__is_active=True,
                    consent__user__is_device=False,
                )
                .order_by(F("template_checked_at").asc(nulls_first=True), "id")
                .values_list("pk", flat=True)[:limit]
            )
            for identifier in list(ids):
                result = build(identifier)
                counts[result.status] += 1
        self.stdout.write(json.dumps({**counts, "enabled": enabled}, sort_keys=True))
