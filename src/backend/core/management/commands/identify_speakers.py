"""Bounded identity batch on its own queue; never resubmits an ASR task."""

import json

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.services.capture_storage import audio_storage
from core.services.recording_identity_preflight import (
    media_config as private_media_config,
)
from core.services.speaker_identity_jobs import pending_ids, process_one
from core.services.voiceprint_candidates import enabled
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_encoder import EncoderError
from core.services.voiceprint_media import MediaConfiguration
from core.services.voiceprint_media_process import MediaError
from core.services.voiceprint_quality import QualityError
from core.services.voiceprint_quality import load_configuration as quality_configuration
from core.services.voiceprint_rpc_process import (
    load_configuration as encoder_configuration,
)
from core.services.voiceprint_source_storage import from_storage


class Command(BaseCommand):
    help = "Run a bounded private Qwen identity batch, independently of ASR."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=1)
        parser.add_argument("--ffmpeg", default="")
        parser.add_argument("--ffprobe", default="")

    def handle(self, *args, **options):
        if not 1 <= options["limit"] <= 10:
            raise CommandError("identity_batch_limit_invalid")
        counts = dict.fromkeys(
            ["succeeded", "failed", "canceled", "expired", "skipped"], 0
        )
        if not enabled():
            self.stdout.write(json.dumps({**counts, "enabled": False}, sort_keys=True))
            return
        try:
            config = {
                "media_config": MediaConfiguration(
                    options["ffmpeg"], options["ffprobe"]
                ).validate()
                if options["ffmpeg"] or options["ffprobe"]
                else private_media_config(),
                "storage_config": from_storage(audio_storage()),
                "encoder_config": encoder_configuration(
                    settings.MEETING_VOICEPRINT_ENCODER_CONFIG_FILE
                ),
                "quality_config": quality_configuration(
                    settings.MEETING_VOICEPRINT_QUALITY_CONFIG_FILE
                ),
            }
        except (VoiceprintError, EncoderError, QualityError, MediaError, OSError):
            raise CommandError("identity_configuration_invalid") from None
        for identifier in pending_ids(options["limit"]):
            status = process_one(identifier, **config)
            counts[status if status in counts else "skipped"] += 1
        self.stdout.write(json.dumps({**counts, "enabled": True}, sort_keys=True))
