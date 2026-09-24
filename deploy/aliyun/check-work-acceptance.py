"""Read-only reconciliation of the five authorized September 24 synthetic runs.

Run through kubectl exec stdin; no model calls, cleanup writes or private content.
The purge receipt is a DB worker acknowledgement, not an independent OSS HEAD.
"""

import json
import os
import sys
from datetime import datetime, timezone

CASES = [
    ("web-conflict", "cbbe063b-896c-48e9-a4be-6e8df805fa78", "59ff8ae3-1633-4289-a8c4-e453a9285eb3", 529, 858,
     ["e0d2c062-950e-4294-9175-3f84da5bc090", "3b726002-2a57-4b7c-a214-787949f5fb96"]),
    ("web-pdf", "b46904d9-583d-4e43-bd3e-e56a12c9d6c7", "e2e75811-a886-4b01-abd5-23b56a9af1df", 323, 315,
     ["f92844f4-92bf-4a22-b394-095774bf5b58"]),
    ("web-docx", "841ff101-6be0-4407-8050-1e9812262720", "070cc8cd-e493-47c7-b84b-fb077dd7eb54", 337, 420,
     ["24afe2fd-3042-4353-89ae-934a33507952"]),
    ("desktop-d08", "7b25601f-a6c2-40d1-8f51-cf03f8720a32", "137c0d54-e089-462f-a258-22032854a6bf", 347, 538,
     ["8840831d-54bd-45cb-8337-4e5d3a2561e6"]),
    ("desktop-d09", "e463170a-804b-471a-8d07-7d880645f805", "7d54ee63-a83a-47f9-8638-2eb2ca419a6b", 344, 455,
     ["d192dde8-69b2-4ee7-908f-b4e685b1bc23"]),
]


def inspect_run(case, run, records):
    label, task_id, run_id, input_tokens, output_tokens, material_ids = case
    checks = {"run_found": run is not None}
    if run is not None:
        task = run.task
        usage = records[0] if len(records) == 1 else None
        checks.update(
            task_matches=str(task.pk) == task_id,
            succeeded=run.status == "succeeded",
            provider_usage_matches=(run.input_tokens, run.output_tokens) == (input_tokens, output_tokens),
            model_matches=run.model == "qwen3.8-flash",
            call_timing_valid=bool(run.call_started_at and run.finished_at and
                                   run.created_at <= run.call_started_at <= run.finished_at),
            source_ids_match=sorted(str(source.get("id")) for source in task.sources) == sorted(material_ids),
            one_ledger_row=len(records) == 1,
            ledger_link_matches=bool(usage and run.usage_record_id == usage.pk),
            ledger_reference_matches=bool(usage and usage.ref_type == "work_run" and usage.ref_id == run_id),
            ledger_owner_matches=bool(usage and usage.user_id == task.owner_id),
            ledger_organization_matches=bool(usage and usage.organization_id == task.organization_id),
            ledger_model_matches=bool(usage and usage.model_code == run.model),
            ledger_tokens_match=bool(usage and (usage.input_tokens, usage.output_tokens) == (input_tokens, output_tokens)),
        )
    return {"case": label, "run_id": run_id, "checks": checks, "ok": all(checks.values())}


def inspect_material(material_id, item, task):
    checks = {"material_found": item is not None, "task_found": task is not None}
    if item is not None:
        checks.update(
            owner_matches=bool(task and item.owner_id == task.owner_id),
            organization_matches=bool(task and item.organization_id == task.organization_id),
            deleted=item.deleted_at is not None,
            purge_acknowledged=bool(item.deleted_at and item.purged_at and item.purged_at >= item.deleted_at),
            storage_key_cleared=item.storage_key == "",
            parsed_content_cleared=item.text == "" and item.locations == [] and item.line_count == 0,
        )
    return {"material_id": material_id, "checks": checks, "ok": all(checks.values())}


def audit():
    from django.db import connection, transaction
    from core.models import AIUsageRecord
    from work.models import WorkMaterial, WorkRun

    results, materials = [], []
    # Refuse accidental writes and keep ledger/material observations consistent.
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        for case in CASES:
            run = WorkRun.objects.select_related("task").filter(pk=case[2]).first()
            # Two suffice to detect duplication without an unbounded result set.
            records = list(AIUsageRecord.objects.filter(ref_type="work_run", ref_id=case[2]).order_by("pk")[:2])
            results.append(inspect_run(case, run, records))
            for material_id in case[5]:
                item = WorkMaterial.objects.filter(pk=material_id).first()
                materials.append(inspect_material(material_id, item, run.task if run else None))
    return {
        "check": "work-acceptance-2026-09-24-v1",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "read_only": True,
        "runs": results,
        "materials": materials,
        "purge_evidence": "worker_database_acknowledgement",
        "independent_object_absence_verified": False,
        "pricing_reconciled": False,
        "ok": all(row["ok"] for row in results + materials),
    }


def main():
    try:
        os.environ.setdefault("DJANGO_SETTINGS_MODULE", "meet.settings")
        from configurations.importer import install
        install()
        import django
        django.setup()
        result = audit()
    except Exception:
        # Do not disclose connection strings, SQL values or customer content.
        result = {"ok": False, "code": "acceptance_audit_failed"}
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
