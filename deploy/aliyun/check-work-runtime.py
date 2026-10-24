"""Run via kubectl exec -i ... -- python - [options]; never print credentials.

Read-only checks for migrations, feature switches and the Work queue consumer.
"""

import argparse
import json
import os
import sys


def inspect_runtime(*, require_worker=False, require_enabled=False, require_disabled=False):
    from django.conf import settings
    from django.db import connection
    from django.db.migrations.executor import MigrationExecutor
    from meet.celery_app import app

    executor = MigrationExecutor(connection)
    targets = executor.loader.graph.leaf_nodes("work")
    migrations_ok = bool(targets) and not executor.migration_plan(targets)
    checks = {
        "migrations_ok": migrations_ok,
        "work_enabled": settings.WORK_ENABLED,
        "agent_enabled": settings.WORK_AGENT_ENABLED,
        "agent_configured": bool(settings.WORK_AGENT_URL and settings.WORK_AGENT_TOKEN),
        "local_agent_enabled": settings.WORK_LOCAL_AGENT_ENABLED,
        "remote_agent_enabled": settings.WORK_REMOTE_AGENT_ENABLED,
        "review_enabled": settings.WORK_REVIEW_ENABLED,
        "review_configured": bool(settings.WORK_REVIEW_URL and settings.WORK_REVIEW_TOKEN),
        "rollout_mode": settings.WORK_AGENT_ROLLOUT_MODE,
    }
    try:
        queues = app.control.inspect(timeout=3).active_queues() or {}
        checks["work_consumers"] = sum(
            1
            for name, items in queues.items()
            if name.startswith("work@") and any(q.get("name") == "work" for q in items)
        )
    except Exception:
        checks["work_consumers"] = 0
        checks["worker_check"] = "unavailable"
    enabled_ok = (
        (not require_enabled or settings.WORK_ENABLED)
        and (not require_disabled or not settings.WORK_ENABLED)
    )
    checks["ok"] = bool(
        migrations_ok
        and enabled_ok
        and (not require_worker or checks["work_consumers"] > 0)
    )
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-worker", action="store_true")
    parser.add_argument("--require-enabled", action="store_true")
    parser.add_argument("--require-disabled", action="store_true")
    args = parser.parse_args()
    try:
        os.environ.setdefault("DJANGO_SETTINGS_MODULE", "meet.settings")
        from configurations.importer import install

        install()
        import django

        django.setup()
        result = inspect_runtime(
            require_worker=args.require_worker,
            require_enabled=args.require_enabled,
            require_disabled=args.require_disabled,
        )
    except Exception as exc:
        # Provider messages and URLs are never logged.
        result = {
            "ok": False,
            "code": "work_runtime_check_failed",
            "error": type(exc).__name__,
        }
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
