"""One bounded batch on the independent voiceprint queue; no ASR dependency."""

import json

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.services.voiceprint_encoder import EncoderError
from core.services.voiceprint_jobs import pending_ids, process_one
from core.services.voiceprint_rpc_process import load_configuration


class Command(BaseCommand):
    help = (
        "Encode authorized voiceprint clips using an independent bounded worker batch."
    )

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=10)

    def handle(self, *args, **options):
        limit = options["limit"]
        if not 1 <= limit <= 100:
            raise CommandError("Limit must be between 1 and 100.")
        counts = dict.fromkeys(
            ["succeeded", "failed", "canceled", "expired", "skipped"], 0
        )
        if not settings.MEETING_VOICEPRINT_ENABLED:
            self.stdout.write(json.dumps({**counts, "enabled": False}, sort_keys=True))
            return
        try:
            config = load_configuration(settings.MEETING_VOICEPRINT_ENCODER_CONFIG_FILE)
        except EncoderError:
            raise CommandError("encoder_configuration_invalid") from None
        for identifier in pending_ids(limit):
            status = process_one(identifier, config)
            counts[status if status in counts else "skipped"] += 1
        self.stdout.write(json.dumps({**counts, "enabled": True}, sort_keys=True))
