"""Read-only reconciliation of the five authorized September 24 synthetic runs.

Run through kubectl exec stdin; no model calls, cleanup writes or private content.
The purge receipt is a DB worker acknowledgement, not an independent OSS HEAD.
"""

import argparse
import hashlib
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

V6_CASE = ("web-v6", "2bbb4d19-ec1d-496d-b785-c27e40c89e5a", "8c3821d8-c249-4ebe-aebc-610d7cca7eca", 1433, 500,
           ["45e51f89-cf3d-4b8d-a500-6a54b5600fb1"])
V6_SYSTEM_HASH = "296a12bd77e915b66ccc6595c8b3d0a734eb50bd60f641b0fcea11ef0f6f3756"
V6_ARTIFACT_HASHES = ["7d2ae5d438084531bf55ac717d7ec5d4fbd0c08387c104844b5765239f0da56b",
                      "38a02db526717a5778c50d934c7c3114dc0af1f2abcb973a5c280baec52eb76c"]


def inspect_v6_artifacts(run, versions):
    checks = {"executor_version_matches": bool(run and run.executor_version == "communication-v6"),
              "two_artifact_versions": len(versions) == 2}
    for index, expected in enumerate(V6_ARTIFACT_HASHES):
        item = versions[index] if index < len(versions) else None
        checks[f"artifact_v{index + 1}_matches"] = bool(
            item and str(item.run_id) == V6_CASE[2] and item.version == index + 1
            and hashlib.sha256(item.body.encode()).hexdigest() == expected)
    checks["edited_version_adopted"] = bool(len(versions) == 2 and versions[1].adopted_at)
    return checks


def audit_v6(executor_only=False):
    from work.executor import EXECUTOR_VERSION, SYSTEM

    actual_hash = hashlib.sha256(SYSTEM.encode()).hexdigest()
    result = {"check": "work-v6-executor" if executor_only else "work-v6-business",
              "read_only": True, "model_calls": 0, "executor_version": EXECUTOR_VERSION,
              "system_hash": actual_hash,
              "ok": EXECUTOR_VERSION == "communication-v6" and actual_hash == V6_SYSTEM_HASH}
    if executor_only or not result["ok"]:
        return result
    from django.db import connection, transaction
    from core.models import AIUsageRecord
    from work.models import WorkArtifactVersion, WorkRun

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        run = WorkRun.objects.select_related("task").filter(pk=V6_CASE[2]).first()
        records = list(AIUsageRecord.objects.filter(ref_type="work_run", ref_id=V6_CASE[2]).order_by("pk")[:2])
        receipt = inspect_run(V6_CASE, run, records)
        versions = list(WorkArtifactVersion.objects.filter(run_id=V6_CASE[2]).order_by("version")[:3])
        receipt["checks"].update(inspect_v6_artifacts(run, versions))
        receipt["ok"] = all(receipt["checks"].values())
        result.update(run=receipt, ok=receipt["ok"], pricing_reconciled=False)
    return result


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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("audit", "v6", "v6-executor"), default="audit")
    args = parser.parse_args()
    try:
        os.environ.setdefault("DJANGO_SETTINGS_MODULE", "meet.settings")
        from configurations.importer import install
        install()
        import django
        django.setup()
        result = audit() if args.mode == "audit" else audit_v6(executor_only=args.mode == "v6-executor")
    except Exception:
        # Do not disclose connection strings, SQL values or customer content.
        result = {"ok": False, "code": "acceptance_audit_failed"}
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
