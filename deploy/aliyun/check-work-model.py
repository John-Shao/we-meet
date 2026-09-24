"""One paid synthetic Work call in the worker, even while generation is disabled.

Uses the deployed CommunicationExecutor and validator. Does not read user data,
create tasks, or write the user usage ledger. Printed provider token counts are
deployment-probe usage, not a complete business acceptance or billing record.
"""

import json
import os
import sys
import time
from types import SimpleNamespace


def probe_model(settings):
    from work.executor import CommunicationExecutor, prompt_for, validate_result
    from work.services import MaterialError

    result = {"ok": False, "probe": "work-communication-v1", "model": settings.WORK_MODEL,
              "usage_scope": "deployment_probe", "business_acceptance": False}
    if not all((settings.WORK_MODEL, settings.WORK_MODEL_BASE_URL, settings.WORK_MODEL_API_KEY)):
        return {**result, "code": "work_model_not_configured"}
    material = SimpleNamespace(
        pk="00000000-0000-4000-8000-000000000001", original_name="合成验收材料.txt",
        text="示例项目计划在周五进行内部演示。\n预算尚未确认，交付日期待双方讨论。",
        line_count=2, locations=[], checksum="synthetic-probe", parser_version="probe-v1",
    )
    task = SimpleNamespace(recipient="示例项目负责人", goal="核对演示准备和待确认事项", background="仅用于部署验收")
    run = SimpleNamespace(model=settings.WORK_MODEL, base_url=settings.WORK_MODEL_BASE_URL,
                          max_output_tokens=min(settings.WORK_MAX_OUTPUT_TOKENS, 1200))
    usage = {}

    def sink(**values):
        for key in ("input_tokens", "output_tokens"):
            value = values.get(key)
            if type(value) is int and value >= 0:
                usage[key] = value

    started = time.monotonic()
    try:
        raw = CommunicationExecutor().generate(run, prompt_for(task, [material]), sink)
        _, citations = validate_result(raw, [material])
        parsed = json.loads(raw)
        result.update(citation_count=len(citations), structure_valid=True)
        if not citations or not all(parsed[key] for key in ("agenda", "questions", "talking_points", "missing_information")):
            result["code"] = "probe_content_incomplete"
        elif not all(usage.get(key, 0) > 0 for key in ("input_tokens", "output_tokens")):
            result["code"] = "provider_usage_missing"
        else:
            result.update(ok=True, code="model_probe_passed")
    except MaterialError as exc:
        code = exc.code if exc.code in ("invalid_model_output", "invalid_citation", "context_too_large") else "model_validation_failed"
        result["code"] = code
    except Exception as exc:
        allowed = {"AuthenticationError", "PermissionDeniedError", "RateLimitError", "APITimeoutError",
                   "APIConnectionError", "BadRequestError", "NotFoundError", "InternalServerError"}
        result.update(code="model_probe_failed", error_type=type(exc).__name__ if type(exc).__name__ in allowed else "OtherError")
    result.update(usage, elapsed_ms=round((time.monotonic() - started) * 1000))
    return result


def main():
    try:
        os.environ.setdefault("DJANGO_SETTINGS_MODULE", "meet.settings")
        from configurations.importer import install
        install()
        import django
        django.setup()
        from django.conf import settings
        result = probe_model(settings)
    except Exception:
        result = {"ok": False, "code": "model_probe_setup_failed"}
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
