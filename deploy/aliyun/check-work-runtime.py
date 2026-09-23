"""Run via kubectl exec -i ... -- python - [options]; never print credentials.

Default checks are read-only. --probe-storage creates one synthetic private
object, tests signed round-trip and anonymous denial, and removes that object.
"""

import argparse
import json
import os
import sys
import uuid


def storage_probe(storage):
    import boto3
    from botocore import UNSIGNED
    from botocore.config import Config
    from botocore.exceptions import ClientError
    from django.core.files.base import ContentFile
    from work.storage import PrivateMaterialStorage

    if not isinstance(storage, PrivateMaterialStorage):
        return {"ok": False, "code": "private_s3_storage_required"}
    name = f"_deployment-probes/{uuid.uuid4().hex}.txt"
    content = b"we-meet work private storage acceptance fixture\n"
    stored = None
    result = {"ok": False, "code": "storage_probe_failed"}
    anonymous = None
    try:
        stored = storage.save(name, ContentFile(content))
        with storage.open(stored, "rb") as source:
            if source.read(len(content) + 1) != content:
                raise ValueError("roundtrip_failed")
        anonymous = boto3.client(
            "s3", endpoint_url=storage.endpoint_url, region_name=storage.region_name,
            config=Config(signature_version=UNSIGNED, connect_timeout=5, read_timeout=10,
                          retries={"max_attempts": 0},
                          s3={"addressing_style": storage.addressing_style or "auto"}),
        )
        try:
            response = anonymous.get_object(Bucket=storage.bucket_name,
                                            Key=storage._normalize_name(stored), Range="bytes=0-0")
            response["Body"].close()
            result = {"ok": False, "code": "anonymous_read_allowed"}
        except ClientError as exc:
            if exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 403:
                result = {"ok": True, "code": "private_roundtrip_passed"}
            else:
                result = {"ok": False, "code": "anonymous_denial_unconfirmed"}
    except Exception:
        # Provider exception strings can include signed URLs or credentials.
        result = {"ok": False, "code": "storage_probe_failed"}
    finally:
        if anonymous is not None:
            anonymous.close()
        # save() may upload and then lose the response; also clean the intended name.
        try:
            storage.delete(stored or name)
            if storage.exists(stored or name):
                raise ValueError("cleanup_failed")
            result["cleanup"] = True
        except Exception:
            result.update(ok=False, cleanup=False, cleanup_key=stored or name)
    return result


def inspect_runtime(*, probe_storage=False, require_worker=False, require_materials=False):
    from django.conf import settings
    from django.db import connection
    from django.db.migrations.executor import MigrationExecutor
    from meet.celery_app import app
    from work import runs
    from work.storage import material_storage

    executor = MigrationExecutor(connection)
    targets = executor.loader.graph.leaf_nodes("work")
    migrations_ok = bool(targets) and not executor.migration_plan(targets)
    checks = {
        "migrations_ok": migrations_ok,
        "work_enabled": settings.WORK_ENABLED,
        "materials_enabled": settings.WORK_MATERIALS_ENABLED,
        "communication_enabled": settings.WORK_COMMUNICATION_ENABLED,
        "model_configured": bool(settings.WORK_MODEL and settings.WORK_MODEL_BASE_URL and settings.WORK_MODEL_API_KEY),
        "generation_available": runs.enabled(),
        "model": settings.WORK_MODEL,
        "storage_backend": settings.WORK_STORAGE.get("BACKEND"),
    }
    try:
        queues = app.control.inspect(timeout=3).active_queues() or {}
        checks["work_consumers"] = sum(1 for name, items in queues.items()
                                       if name.startswith("work@") and any(q.get("name") == "work" for q in items))
    except Exception:
        checks["work_consumers"] = 0
        checks["worker_check"] = "unavailable"
    if probe_storage:
        checks["storage_probe"] = storage_probe(material_storage())
    checks["ok"] = bool(migrations_ok and (not require_worker or checks["work_consumers"] > 0)
                        and (not require_materials or (settings.WORK_ENABLED and settings.WORK_MATERIALS_ENABLED))
                        and (not probe_storage or checks["storage_probe"]["ok"]))
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe-storage", action="store_true")
    parser.add_argument("--require-worker", action="store_true")
    parser.add_argument("--require-materials", action="store_true")
    args = parser.parse_args()
    try:
        os.environ.setdefault("DJANGO_SETTINGS_MODULE", "meet.settings")
        from configurations.importer import install
        install()
        import django
        django.setup()
        result = inspect_runtime(probe_storage=args.probe_storage, require_worker=args.require_worker, require_materials=args.require_materials)
    except Exception:
        result = {"ok": False, "code": "work_runtime_check_failed"}
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
