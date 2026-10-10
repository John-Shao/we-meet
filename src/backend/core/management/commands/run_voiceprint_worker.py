"""Validate private configuration before consuming a fixed independent queue."""

import json
import os
import shutil

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.services.recording_identity_preflight import media_config
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_crypto import VoiceprintCryptoError, load_keyring
from core.services.voiceprint_encoder import EncoderError
from core.services.voiceprint_matching import load_policy
from core.services.voiceprint_quality import QualityError
from core.services.voiceprint_quality import load_configuration as quality_configuration
from core.services.voiceprint_rpc_process import (
    load_configuration as encoder_configuration,
)

QUEUES = {
    "control": "voiceprint",
    "processing": "voiceprint-processing",
    "identity": "voiceprint-identity",
}


def validate(role):
    if role not in (*QUEUES, "api"):
        raise CommandError("voiceprint_worker_role_invalid")
    if role != "api" and (
        not settings.CELERY_ENABLED or settings.CELERY_TASK_ALWAYS_EAGER
    ):
        raise CommandError("voiceprint_worker_async_configuration_required")
    # Broken/disabled model configuration must never prevent erasure or recovery.
    if role == "control" or not settings.MEETING_VOICEPRINT_ENABLED:
        return
    # This queue also carries ordinary capture diarization, without voiceprints.
    if role == "identity" and not settings.MEETING_VOICEPRINT_MATCHING_ENABLED:
        return
    try:
        load_keyring()
        if role == "processing" or (
            role in {"api", "identity"} and settings.MEETING_VOICEPRINT_MATCHING_ENABLED
        ):
            encoder_configuration(settings.MEETING_VOICEPRINT_ENCODER_CONFIG_FILE)
        if (
            role in {"api", "processing"}
            and settings.MEETING_VOICEPRINT_QUALITY_ENABLED
        ) or (
            role in {"api", "identity"} and settings.MEETING_VOICEPRINT_MATCHING_ENABLED
        ):
            quality_configuration(settings.MEETING_VOICEPRINT_QUALITY_CONFIG_FILE)
        if role in {"api", "identity"} and settings.MEETING_VOICEPRINT_MATCHING_ENABLED:
            load_policy(settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE)
            media_config()
    except (
        VoiceprintError,
        VoiceprintCryptoError,
        EncoderError,
        QualityError,
        OSError,
    ):
        raise CommandError("voiceprint_worker_private_configuration_invalid") from None


class Command(BaseCommand):
    help = (
        "Validate private settings and exec a bounded, fixed voiceprint Celery worker."
    )

    def add_arguments(self, parser):
        parser.add_argument("--role", choices=(*QUEUES, "api"), required=True)
        parser.add_argument("--check", action="store_true")

    def handle(self, *args, **options):
        role = options["role"]
        validate(role)
        if options["check"]:
            self.stdout.write(json.dumps({"role": role, "status": "ready"}))
            return
        if role not in QUEUES:
            raise CommandError("voiceprint_worker_role_invalid")
        executable = shutil.which("celery")
        if executable is None:
            raise CommandError("voiceprint_worker_executable_unavailable")
        os.execv(  # noqa: S606 -- Resolved image-installed executable, fixed argv only.
            executable,
            [
                executable,
                "-A",
                "meet.celery_app",
                "worker",
                "-Q",
                QUEUES[role],
                "--pool=prefork",
                "--concurrency=1",
                "--prefetch-multiplier=1",
                "--max-tasks-per-child=100",
                "--without-mingle",
                "--without-gossip",
                "--loglevel=info",
                f"--hostname=voiceprint-{role}@%h",
            ],
        )
