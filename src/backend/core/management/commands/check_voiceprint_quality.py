"""Bounded independent Qwen quality batch; never a general ASR endpoint."""

import json

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.services.voiceprint_quality import QualityError, load_configuration
from core.services.voiceprint_quality_jobs import (
    enabled,
    enqueue_ready,
    pending_ids,
    process_one,
)


class Command(BaseCommand):
    help = "Check enrollment speech, speaker count and random prompts with Qwen."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=10)

    def handle(self, *args, **options):
        limit = options["limit"]
        if not 1 <= limit <= 100:
            raise CommandError("Limit must be between 1 and 100.")
        counts = dict.fromkeys(
            ["succeeded", "failed", "canceled", "expired", "skipped"], 0
        )
        if not enabled():
            self.stdout.write(
                json.dumps({**counts, "enabled": False, "admitted": 0}, sort_keys=True)
            )
            return
        try:
            config = load_configuration(settings.MEETING_VOICEPRINT_QUALITY_CONFIG_FILE)
        except QualityError:
            raise CommandError("quality_configuration_invalid") from None
        admitted = enqueue_ready(limit)
        for identifier in pending_ids(limit):
            status = process_one(identifier, config)
            counts[status if status in counts else "skipped"] += 1
        self.stdout.write(
            json.dumps(
                {**counts, "enabled": True, "admitted": admitted}, sort_keys=True
            )
        )
