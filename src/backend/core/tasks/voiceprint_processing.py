"""Fresh, bounded DB batches: no private identifiers or configuration in broker IO."""

import io
import json
import logging
from time import monotonic

from django.core.management import call_command
from django.core.management.base import CommandError

from billiard.exceptions import SoftTimeLimitExceeded

from core.tasks._task import task

logger = logging.getLogger(__name__)


def run_batch(command):
    """Reuse the CLI authorization/lease guards; pick one current item at execution."""
    output = io.StringIO()
    try:
        call_command(command, limit=1, stdout=output, stderr=output)
        return json.loads(output.getvalue())
    except SoftTimeLimitExceeded:
        raise  # Stop this entire tick; the current child transport cleans up.
    except CommandError:
        # Config paths, credentials and framework exception text must not enter logs.
        logger.warning("voiceprint_batch_configuration_unavailable stage=%s", command)
        return {"status": "configuration_unavailable"}
    except Exception:  # noqa: BLE001 -- DB/native errors are private; durable leases and periodic scans recover.
        logger.warning("voiceprint_batch_unavailable stage=%s", command)
        return {"status": "unavailable"}


def encode_voiceprints():
    return run_batch("process_voiceprints")


def check_voiceprint_quality():
    return run_batch("check_voiceprint_quality")


def build_voiceprint_templates():
    return run_batch("build_voiceprint_templates")


@task(
    queue="voiceprint-processing",
    time_limit=120,
    soft_time_limit=105,
    ignore_result=True,
)
def process_voiceprint_batches():
    # Separate expiring messages can starve later stages under sustained load.
    # Cheap templates run first; reserve the native 35s bound plus cleanup margin.
    deadline = monotonic() + 100
    results = {}
    for stage, work in (
        ("templates", build_voiceprint_templates),
        ("quality", check_voiceprint_quality),
        ("encoding", encode_voiceprints),
    ):
        if deadline - monotonic() < 40:
            results[stage] = {"status": "budget_exhausted"}
        else:
            results[stage] = work()
    return results


@task(
    queue="voiceprint-identity", time_limit=900, soft_time_limit=850, ignore_result=True
)
def identify_speakers():
    return run_batch("identify_speakers")
