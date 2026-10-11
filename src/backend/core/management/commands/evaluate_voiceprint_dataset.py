"""Execute a private prepared-PCM research corpus against an isolated encoder."""

import base64
import json
import os
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlsplit

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.services.voiceprint_encoder import EncoderClient
from core.services.voiceprint_evaluation import (
    MAX_MANIFEST_BYTES,
    Dataset,
    EvaluationError,
    execute,
    fields,
    require,
    unique_object,
)


def read_json(path, maximum):
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    require(len(data) <= maximum, "evaluation_input_too_large")
    return json.loads(data, object_pairs_hook=unique_object)


class Command(BaseCommand):
    help = __doc__
    requires_system_checks = []

    def add_arguments(self, parser):
        parser.add_argument("--manifest", type=Path, required=True)
        parser.add_argument("--dataset-root", type=Path, required=True)
        parser.add_argument("--isolated-encoder-config", type=Path, required=True)
        parser.add_argument("--output", type=Path, required=True)
        parser.add_argument("--deadline-seconds", type=int, default=3600)

    def handle(self, *args, **options):
        try:
            require(
                not any(
                    getattr(settings, key)
                    for key in (
                        "MEETING_VOICEPRINT_ENABLED",
                        "MEETING_VOICEPRINT_SAMPLING_ENABLED",
                        "MEETING_VOICEPRINT_MATCHING_ENABLED",
                    )
                ),
                "evaluation_business_flags_must_be_disabled",
            )
            require(not options["output"].exists(), "evaluation_output_exists")
            dataset = Dataset(
                read_json(options["manifest"], MAX_MANIFEST_BYTES),
                options["dataset_root"],
            )
            config = read_json(options["isolated_encoder_config"], 8192)
            fields(config, ("purpose", "url", "api_token", "permit_key", "ca_bundle"))
            require(
                config["purpose"] == "speaker-evaluation-only",
                "evaluation_isolated_config_required",
            )
            target = urlsplit(config["url"])
            host = target.hostname or ""
            local = host == "localhost" or host.endswith((".svc", ".svc.cluster.local"))
            try:
                local = local or ip_address(host).is_private
            except ValueError:
                pass
            require(
                target.scheme == "https" and local, "evaluation_private_https_required"
            )
            client = EncoderClient(
                config["url"],
                api_token=config["api_token"].encode("ascii"),
                permit_key=base64.b64decode(config["permit_key"], validate=True),
                ca_bundle=config["ca_bundle"],
            )
            report = execute(
                dataset, client, deadline_seconds=options["deadline_seconds"]
            )
            payload = (
                json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n"
            ).encode("utf-8")
            descriptor = os.open(
                options["output"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
            )
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
        except Exception as error:  # noqa: BLE001 -- No private path, audio or credential traceback.
            code = (
                str(error)
                if isinstance(error, EvaluationError)
                else "evaluation_execution_failed"
            )
            raise CommandError(code) from None
        self.stdout.write("voiceprint_research_report_written")
