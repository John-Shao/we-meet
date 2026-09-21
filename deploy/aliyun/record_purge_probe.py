"""Run inside a backend pod; never enroll or delete application records."""

import argparse
import json
import os
import socket
import sys
import uuid
from urllib.parse import urlsplit, urlunsplit

TASK = "core.tasks.record_purge.purge_requested_records"


class PreflightError(Exception):
    """A fixed diagnostic code that is safe to include in operator output."""


def require(condition, code):
    if not condition:
        raise PreflightError(code)


def storage_canary(storage):
    """Only remove the two fresh, random objects created by this invocation."""
    import requests
    from django.core.files.base import ContentFile
    from core.services.capture_audio_cleanup import _delete_verified
    from core.services.capture_storage import text_storage_error

    require(not text_storage_error(storage), "storage_not_unversioned")
    require(storage.file_overwrite, "canary_requires_exact_object_names")
    run_id = uuid.uuid4().hex
    keys = [
        f"record-uploads/purge-preflight-{run_id}.wav",
        f"capture-audio/{uuid.uuid4()}/{uuid.uuid4()}/{uuid.uuid4()}.wav",
    ]
    results = []
    for key in keys:
        require(not storage.exists(key), "canary_collision")
        # No record references these deliberately tiny, non-media probe bytes.
        # Include attempted writes in cleanup even if PUT's response is lost.
        try:
            saved = storage.save(
                key, ContentFile(b"we-meet permanent deletion preflight\n")
            )
            require(saved == key, "canary_name_changed")
            require(storage.exists(key), "canary_write_unconfirmed")
            url = urlsplit(storage.url(key))
            unsigned = urlunsplit((url.scheme, url.netloc, url.path, "", ""))
            with requests.get(
                unsigned, timeout=(3, 10), allow_redirects=False, stream=True
            ) as response:
                require(response.status_code == 403, "canary_not_confirmed_private")
        finally:
            try:
                error = _delete_verified(storage, key)
            except Exception:
                print(
                    json.dumps(
                        {"orphan_canary": key, "cleanup_error": "storage_exception"}
                    )
                )
                raise PreflightError("canary_cleanup_failed") from None
            if error:
                print(json.dumps({"orphan_canary": key, "cleanup_error": error}))
            require(not error, "canary_cleanup_failed")
        require(not storage.exists(key), "canary_still_exists")
        results.append({"prefix": key.split("/")[0], "private": True, "deleted": True})
    return results


def probe(args):
    from django.conf import settings
    from django.db import connection
    from django.db.migrations.recorder import MigrationRecorder
    from storages.backends.s3 import S3Storage
    from core import models
    from core.services import record_purge
    from core.services.capture_storage import audio_storage, text_storage_error

    require(connection.vendor == "postgresql", "postgresql_required")
    require(
        ("core", "0186_record_purge")
        in MigrationRecorder(connection).applied_migrations(),
        "migration_0186_missing",
    )
    require(
        settings.MEETING_RECORDS_ENABLED and settings.MEETING_RECORD_TRASH_ENABLED,
        "records_or_trash_disabled",
    )
    require(
        settings.CELERY_ENABLED and not settings.CELERY_TASK_ALWAYS_EAGER,
        "celery_not_async",
    )
    require(
        bool(settings.MEETING_RECORD_PURGE_ENABLED) == args.expect_enabled,
        "unexpected_purge_flag",
    )
    require(callable(record_purge.guard_adoption), "upload_fence_missing")
    jobs = models.MeetingRecordPurge.objects.count()
    # First enablement must not unexpectedly resume earlier deletion intents.
    require(args.expect_enabled or jobs == 0, "existing_purge_intents_require_review")
    schedule = settings.CELERY_BEAT_SCHEDULE.get("purge-requested-records", {})
    require(
        schedule.get("task") == TASK and schedule.get("schedule") == 30.0,
        "purge_schedule_missing",
    )
    storage = audio_storage()
    require(isinstance(storage, S3Storage), "expected_s3_storage")
    require(storage.bucket_name == args.bucket, "unexpected_bucket")
    require(not text_storage_error(storage), "storage_not_unversioned")
    require(
        storage.default_acl == "private"
        and storage.object_parameters.get("ACL") == "private",
        "storage_acl_not_private",
    )
    report = {
        "migration_0186": True,
        "purge_enabled": bool(settings.MEETING_RECORD_PURGE_ENABLED),
        "existing_purge_jobs": jobs,
        "bucket": storage.bucket_name,
        "unversioned": True,
        "direct_upload_ttl_seconds": settings.MEETING_FILE_DIRECT_UPLOAD_TTL_SECONDS,
    }
    if args.worker:
        from meet.celery_app import app

        node = f"celery@{socket.gethostname()}"
        inspector = app.control.inspect(destination=[node], timeout=5)
        registered = (inspector.registered() or {}).get(node, [])
        require(TASK in registered, "live_worker_purge_task_missing")
        queues = (inspector.active_queues() or {}).get(node, [])
        route = app.amqp.router.route({}, TASK, args=(), kwargs={})
        queue = route["queue"].name
        require(
            any(item["name"] == queue for item in queues), "live_worker_queue_missing"
        )
        report["live_worker_task_registered"] = True
        report["purge_queue"] = queue
    if args.canary:
        report["canaries"] = storage_canary(storage)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expect-enabled", action="store_true")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--canary", action="store_true")
    parser.add_argument("--bucket", default="we-meet-video")
    args = parser.parse_args()
    try:
        os.environ.setdefault("DJANGO_SETTINGS_MODULE", "meet.settings")
        os.environ.setdefault("DJANGO_CONFIGURATION", "Production")
        import configurations

        configurations.setup()
        report = probe(args)
    except Exception as exc:
        # Provider exceptions can include sensitive URLs/credentials; never print them.
        code = str(exc) if isinstance(exc, PreflightError) else type(exc).__name__
        print(json.dumps({"ok": False, "error": code}))
        return 1
    print(json.dumps({"ok": True, **report}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
