"""Import the real Celery registry in a fresh process, without inline fallbacks."""

import os
import subprocess
import sys


def test_worker_can_resolve_every_scheduled_task():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from meet.celery_app import app; "
            "app.loader.import_default_modules(); "
            "from django.conf import settings; "
            "assert settings.CELERY_ENABLED; "
            "expected = {item['task'] for item in settings.CELERY_BEAT_SCHEDULE.values()}; "
            "expected.update({'core.tasks.summary.generate_meeting_summary', "
            "'core.tasks.embeddings.embed_meeting_transcripts'}); "
            "missing = expected.difference(app.tasks); "
            "assert not missing, sorted(missing); "
            "assert app.tasks['work.tasks.tick_runs'].queue == 'work'",
        ],
        env={**os.environ, "CELERY_ENABLED": "True"},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr
