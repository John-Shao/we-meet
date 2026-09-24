"""Run via kubectl exec -i ... -- python - [options]; never print credentials.

Default checks are read-only. --probe-storage creates one synthetic private
object, tests signed round-trip and anonymous denial, and removes that object.
"""

import argparse
import json
import os
import re
import sys
import uuid


def safe_error(exc):
    """Only emit known identifiers; provider messages and URLs are never logged."""
    from botocore.exceptions import ClientError

    allowed_types = {
        "ClientError", "NoCredentialsError", "PartialCredentialsError",
        "EndpointConnectionError", "ConnectTimeoutError", "ReadTimeoutError",
        "SSLError", "ProxyConnectionError", "ParamValidationError",
        "ImproperlyConfigured", "ValueError", "AttributeError", "TypeError",
        "S3UploadFailedError", "FlexibleChecksumError",
    }
    kind = type(exc).__name__
    result = {"type": kind if kind in allowed_types else "OtherError"}
    if isinstance(exc, ClientError):
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if type(status) is int and 100 <= status <= 599:
            result["http_status"] = status
        code = exc.response.get("Error", {}).get("Code")
        allowed_codes = {
            "AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch",
            "NoSuchBucket", "NoSuchKey", "InvalidBucketName", "InvalidArgument",
            "InvalidRequest", "NotImplemented", "AuthorizationHeaderMalformed",
            "RequestTimeTooSkewed", "RequestExpired", "ExpiredToken",
            "InvalidToken", "InvalidSecurity", "PermanentRedirect",
            "InvalidDigest", "BadDigest", "RequestTimeout", "SlowDown",
            "403", "404", "400", "500", "503",
        }
        result["provider_code"] = code if code in allowed_codes else "OtherCode"
    return result


def cleanup_probe(storage, name):
    # A caller can only delete an exact synthetic probe, never a material/prefix.
    if not re.fullmatch(r"_deployment-probes/[0-9a-f]{32}(?:_[A-Za-z0-9]{7})?\.txt", name):
        return {"ok": False, "code": "invalid_probe_key"}
    stage = "delete"
    try:
        storage.delete(name)
        stage = "verify_absent"
        if storage.exists(name):
            return {"ok": False, "stage": stage, "code": "probe_still_exists", "cleanup_key": name}
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "stage": stage, "error": safe_error(exc), "cleanup_key": name}


def storage_config(storage, deployment_config):
    config = storage.client_config
    fields = ("signature_version", "s3", "request_checksum_calculation", "response_checksum_validation")
    return {
        "bucket_configured": bool(storage.bucket_name),
        "endpoint_configured": bool(storage.endpoint_url),
        "static_credentials_configured": bool(storage.access_key and storage.secret_key),
        "deployment_config_differences": [field for field in fields
            if deployment_config is not None and getattr(config, field, None) != getattr(deployment_config, field, None)],
    }


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
    stage = "save"
    try:
        stored = storage.save(name, ContentFile(content))
        stage = "authenticated_read"
        with storage.open(stored, "rb") as source:
            if source.read(len(content) + 1) != content:
                raise ValueError("roundtrip_failed")
        stage = "anonymous_client"
        anonymous = boto3.client(
            "s3", endpoint_url=storage.endpoint_url, region_name=storage.region_name,
            config=Config(signature_version=UNSIGNED, connect_timeout=5, read_timeout=10,
                          retries={"max_attempts": 0},
                          s3={"addressing_style": storage.addressing_style or "auto"}),
        )
        try:
            stage = "anonymous_read"
            response = anonymous.get_object(Bucket=storage.bucket_name,
                                            Key=storage._normalize_name(stored), Range="bytes=0-0")
            response["Body"].close()
            result = {"ok": False, "code": "anonymous_read_allowed"}
        except ClientError as exc:
            if exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 403:
                result = {"ok": True, "code": "private_roundtrip_passed"}
            else:
                result = {"ok": False, "code": "anonymous_denial_unconfirmed", "stage": stage, "error": safe_error(exc)}
    except Exception as exc:
        # Provider exception strings can include signed URLs or credentials.
        result = {"ok": False, "code": "storage_probe_failed", "stage": stage, "error": safe_error(exc)}
    finally:
        if anonymous is not None:
            try:
                anonymous.close()
            except Exception:
                pass
        # save() may upload and then lose the response; also clean the intended name.
        cleanup = cleanup_probe(storage, stored or name)
        result["cleanup"] = cleanup["ok"]
        if not cleanup["ok"]:
            result.update(ok=False, cleanup_key=stored or name, cleanup_detail=cleanup)
    return result


def inspect_runtime(*, probe_storage=False, require_worker=False, require_materials=False,
                    require_model=False, require_communication=False, cleanup_key=None):
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
    storage = material_storage()
    checks["storage_config"] = storage_config(storage, getattr(settings, "AWS_S3_CLIENT_CONFIG", None))
    if cleanup_key:
        checks["probe_cleanup"] = cleanup_probe(storage, cleanup_key)
    if probe_storage:
        checks["storage_probe"] = storage_probe(storage)
    checks["ok"] = bool(migrations_ok and (not require_worker or checks["work_consumers"] > 0)
                        and (not require_materials or (settings.WORK_ENABLED and settings.WORK_MATERIALS_ENABLED))
                        and (not require_model or checks["model_configured"])
                        and (not require_communication or checks["generation_available"])
                        and (not probe_storage or checks["storage_probe"]["ok"])
                        and (not cleanup_key or checks["probe_cleanup"]["ok"]))
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe-storage", action="store_true")
    parser.add_argument("--require-worker", action="store_true")
    parser.add_argument("--require-materials", action="store_true")
    parser.add_argument("--require-model", action="store_true")
    parser.add_argument("--require-communication", action="store_true")
    parser.add_argument("--cleanup-probe", metavar="KEY", help="Delete only the exact synthetic probe key previously reported")
    args = parser.parse_args()
    try:
        os.environ.setdefault("DJANGO_SETTINGS_MODULE", "meet.settings")
        from configurations.importer import install
        install()
        import django
        django.setup()
        result = inspect_runtime(probe_storage=args.probe_storage, require_worker=args.require_worker,
                                 require_materials=args.require_materials, require_model=args.require_model,
                                 require_communication=args.require_communication, cleanup_key=args.cleanup_probe)
    except Exception as exc:
        result = {"ok": False, "code": "work_runtime_check_failed", "error": safe_error(exc)}
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
