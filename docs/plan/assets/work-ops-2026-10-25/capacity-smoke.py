#!/usr/bin/env python3
"""Small capacity/contention smoke against the current Work DDL.

This is not a production load test and does not cover model/connector quotas,
SSE/device connections, or multi-region behavior. It measures:
  * 50 concurrent budget reservations (one per Operation)
  * 100 concurrent duplicate submission deliveries
  * 10 concurrent claim_dispatch attempts on one Operation

Requires psycopg 3 and a dedicated PostgreSQL 16 database.
"""
import concurrent.futures
import json
import os
import statistics
import time
import uuid
from pathlib import Path

import psycopg

BASE = Path(__file__).resolve().parent
DDL = BASE.parent / "work-ddl-draft-2026-10-25.sql"
ADMIN_URL = os.environ.get(
    "ADMIN_DATABASE_URL",
    "postgresql://postgres:test@127.0.0.1:55439/work_ops",
)
ORG = "org-capacity"
SUBJECT = "capacity-user"
PERIOD = "2026-10"
N_RESERVATIONS = 50
N_DEDUP = 100
N_CLAIM = 10


def connect(autocommit=False):
    return psycopg.connect(ADMIN_URL, autocommit=autocommit)


def create_fixture():
    ddl = DDL.read_text(encoding="utf-8")
    with connect(autocommit=True) as conn:
        conn.execute("DROP SCHEMA IF EXISTS work CASCADE")
        conn.execute(ddl)
        conn.execute(
            "INSERT INTO work.org (id,status,execution_enabled,home_region) VALUES (%s,'active',true,'cn-north')",
            (ORG,),
        )
        conn.execute(
            "INSERT INTO work.member (org_id,subject_id,status,role,work_seat) VALUES (%s,%s,'active','owner',true)",
            (ORG, SUBJECT),
        )
        conn.execute(
            "INSERT INTO work.org_policy (org_id,revision) VALUES (%s,1)",
            (ORG,),
        )
        conn.execute(
            "INSERT INTO work.budget_account (org_id,account_key,period_id,currency,limit_cents) VALUES (%s,'default',%s,'CNY',1000)",
            (ORG, PERIOD),
        )
        task_id = str(uuid.uuid4())
        snapshot_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO work.task (id,org_id,owner_subject_id,state,permission_mode) VALUES (%s,%s,%s,'open','ask_each')",
            (task_id, ORG, SUBJECT),
        )
        conn.execute(
            """INSERT INTO work.capability_snapshot
               (id,org_id,task_id,resolver_version,snapshot_hash,tool_allowlist,
                model_route,scope_caps,price_version,manifest)
               VALUES (%s,%s,%s,'capacity-v1','cap-snapshot',
                       ARRAY['model.text']::text[], '{}'::jsonb, '{}'::jsonb,
                       'price-v1','{}'::jsonb)""",
            (snapshot_id, ORG, task_id),
        )
        conn.execute(
            "UPDATE work.task SET snapshot_id=%s WHERE id=%s AND org_id=%s",
            (snapshot_id, task_id, ORG),
        )
        run_id = conn.execute(
            "SELECT work.create_run(%s,%s,%s,'capacity-run','capacity-runtime') AS id",
            (task_id, ORG, snapshot_id),
        ).fetchone()[0]
        conn.execute(
            "SELECT * FROM work.acquire_run(%s,%s)",
            (run_id, ORG),
        ).fetchone()
        fence = conn.execute(
            "SELECT fence FROM work.run WHERE id=%s AND org_id=%s",
            (run_id, ORG),
        ).fetchone()[0]
        operation_ids = []
        for index in range(N_RESERVATIONS):
            operation_id = conn.execute(
                "SELECT work.create_operation(%s,%s,%s,'model',%s) AS id",
                (run_id, ORG, f"capacity:{index}", f"hash:{index}"),
            ).fetchone()[0]
            operation_ids.append(str(operation_id))
    return run_id, fence, operation_ids


def reserve_one(operation_id):
    started = time.perf_counter()
    try:
        with connect() as conn:
            conn.execute(
                "SELECT work.reserve_budget(%s,'default',%s,%s,1)",
                (ORG, PERIOD, operation_id),
            )
            conn.commit()
        return (time.perf_counter() - started) * 1000, True
    except Exception as exc:  # noqa: BLE001 - smoke reports failures as data
        return (time.perf_counter() - started) * 1000, False


def dedup_one():
    client_request_id = "capacity-dedup-key"
    with connect() as conn:
        row = conn.execute(
            """INSERT INTO work.submission_dedup
               (org_id,subject_id,operation_type,client_request_id,request_hash,task_id)
               VALUES (%s,%s,'task_submit',%s,'hash',NULL)
               ON CONFLICT DO NOTHING RETURNING client_request_id""",
            (ORG, SUBJECT, client_request_id),
        ).fetchone()
        conn.commit()
        return row is not None


def claim_one(operation_id, fence):
    with connect() as conn:
        row = conn.execute(
            "SELECT work.claim_dispatch(%s,%s,'capacity-consumer',%s) AS attempt",
            (operation_id, ORG, fence),
        ).fetchone()
        conn.commit()
        return row[0] is not None


def main():
    run_id, fence, operation_ids = create_fixture()
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
        reserve_results = list(executor.map(reserve_one, operation_ids))
        dedup_results = list(executor.map(lambda _: dedup_one(), range(N_DEDUP)))
        # Make one operation authorized, then race the dispatch CAS.
        with connect() as conn:
            conn.execute(
                "UPDATE work.operation SET state='authorized', revision=revision+1 WHERE id=%s AND org_id=%s AND state='prepared'",
                (operation_ids[0], ORG),
            )
            conn.commit()
        claim_results = list(
            executor.map(lambda _: claim_one(operation_ids[0], fence), range(N_CLAIM))
        )

    latencies = sorted(ms for ms, _ in reserve_results)
    p50 = statistics.median(latencies)
    p95 = latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))]
    result = {
        "package": "capacity-smoke",
        "schema": "current work-ddl-draft",
        "reservations": {
            "attempts": N_RESERVATIONS,
            "succeeded": sum(ok for _, ok in reserve_results),
            "p50_ms": round(p50, 2),
            "p95_ms": round(p95, 2),
            "max_ms": round(max(latencies), 2),
        },
        "dedup": {
            "attempts": N_DEDUP,
            "accepted": sum(dedup_results),
        },
        "claim_dispatch": {
            "attempts": N_CLAIM,
            "winners": sum(claim_results),
        },
        "not_executed": [
            "§19 three traffic tiers",
            "model token quota/provider rate limits",
            "SSE/device-gateway connection scale",
            "multi-region/DR",
        ],
    }
    with connect() as conn:
        budget = conn.execute(
            "SELECT reserved_cents,settled_cents FROM work.budget_account WHERE org_id=%s AND account_key='default'",
            (ORG,),
        ).fetchone()
        result["ledger"] = {"reserved_cents": budget[0], "settled_cents": budget[1]}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    assert result["reservations"]["succeeded"] == N_RESERVATIONS
    assert result["ledger"]["reserved_cents"] == N_RESERVATIONS
    assert result["dedup"]["accepted"] == 1
    assert result["claim_dispatch"]["winners"] == 1
    print("CAPACITY_OK")


if __name__ == "__main__":
    main()
