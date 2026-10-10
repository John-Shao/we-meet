"""A fresh Celery-enabled interpreter catches registration masked by test fallbacks."""

import json
import os
import subprocess
import sys
from pathlib import Path


def test_real_celery_tasks_are_discovered_and_routed_without_publishing():
    script = """
import json
import sys
stage = "bootstrap"
try:
    from configurations import importer
    importer.install()
    import django
    django.setup()
    from celery import Task
    from meet.celery_app import app
    app.autodiscover_tasks(force=True)
    expected = {
        "process_voiceprint_batches": ("voiceprint-processing", 120, 105),
        "identify_speakers": ("voiceprint-identity", 900, 850),
    }
    for suffix, (queue, hard, soft) in expected.items():
        stage = suffix
        name = "core.tasks.voiceprint_processing." + suffix
        work = app.tasks[name]
        assert isinstance(work, Task) and work.ignore_result
        assert (work.queue, work.time_limit, work.soft_time_limit) == (queue, hard, soft)
        route = app.amqp.router.route(work._get_exec_options(), name, args=(), kwargs={})
        assert route["queue"].name == queue
    stage = "queue_isolation"
    assert app.tasks["core.tasks.capture_diarization.process_capture_diarization"].queue == "voiceprint-identity"
    assert app.tasks["core.tasks.voiceprint_maintenance.maintain_voiceprints"].queue == "voiceprint"
    print(json.dumps({"status": "passed", "registered_batches": 2}))
except Exception:
    print(json.dumps({"status": "failed", "stage": stage}))
    sys.exit(1)
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).resolve().parents[2],
        env={**os.environ, "CELERY_ENABLED": "True"},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    # Never emit the child stderr: configuration/framework errors may be private.
    assert result.returncode == 0, "Celery registration subprocess failed"
    assert json.loads(result.stdout) == {"status": "passed", "registered_batches": 2}
