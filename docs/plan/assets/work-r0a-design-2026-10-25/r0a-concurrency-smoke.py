#!/usr/bin/env python3
"""R0a concurrency smoke for the admin read / directory / retention paths.

D1's single-transaction smoke proves state machines and permission gates, but it
cannot show what happens when two workers race. This script runs the new paths
against a real PostgreSQL 16 with multiple connections and reports the outcome
of each race, so DR1 can decide on measured behaviour instead of assumptions.

Not a load test: no throughput target, no connection pool, no Temporal, no real
Content Store. Every scenario is a correctness question with a counted answer.

Usage:
  docker run -d --name work-r0a-pg -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=work_r0a -p 55433:5432 postgres:16
  python r0a-concurrency-smoke.py            # writes admin-directory-concurrency.log
Set R0A_DATABASE_URL to point somewhere else (CI uses the postgres service).
A disposable database only: the script drops and recreates the work schema.
It exits non-zero when a race invariant is violated, so the same run is both
evidence and gate.
"""
import concurrent.futures
import json
import os
import random
import threading
import pathlib
import time
import uuid

import psycopg

BASE = pathlib.Path(__file__).resolve().parent
SCHEMA = BASE / "r0a-schema-draft.sql"
LOG = BASE / "admin-directory-concurrency.log"
ADMIN_URL = os.environ.get("R0A_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:55433/work_r0a")
ORG = "org1"
PERIOD = "2026-10"


def connect():
    return psycopg.connect(ADMIN_URL, autocommit=False)


def must_ok(result, label):
    """Fail loudly: a swallowed error here would silently skew a race count."""
    ok, value = result
    if not ok:
        raise RuntimeError(f'{label} failed: {value}')
    return value


def as_dict(value):
    """psycopg adapts jsonb to dict; keep str support so the helper works either way."""
    return value if isinstance(value, dict) else json.loads(value)


def code_of(error):
    text = str(error)
    for token in ("projection_revision_stale", "audit_export_not_claimable", "audit_export_lease_lost",
                  "download_token_invalid", "work_seat_required", "admin_access_denied",
                  "directory_org_context_mismatch", "revision_conflict", "quota_exhausted",
                  "run_cap_exceeded", "owner_access_denied", "provider_not_configured"):
        if token in text:
            return token
    return text.split("\n")[0][:80]


def session(org_id=ORG, role="work_api", subject=None):
    def setup(conn):
        cur = conn.cursor()
        # SET 不接受绑定参数；set_config(..., true) 与 SET LOCAL 等价。
        cur.execute("SELECT set_config('role', %s, true)", (role,))
        cur.execute("SELECT set_config('app.org_id', %s, true)", (org_id,))
        if subject is not None:
            cur.execute("SELECT set_config('app.subject_id', %s, true)", (subject,))
        return cur
    return setup


def call_worker(fn, args, org_id=ORG, role="work_api", subject=None, barrier=None):
    """Run one domain function in its own transaction; return (ok, code_or_value)."""
    with connect() as conn:
        cur = session(org_id, role, subject)(conn)
        if barrier is not None:
            barrier.wait()
        try:
            cur.execute(fn, args)
            row = cur.fetchone()
            conn.commit()
            return True, row[0] if row is not None else None
        except Exception as error:  # noqa: BLE001 - the race outcome is the measurement
            conn.rollback()
            return False, code_of(error)


def scalar(sql, params=None):
    with connect() as conn:
        return conn.execute(sql, params or ()).fetchone()[0]


def reset():
    with connect() as conn:
        conn.autocommit = True
        conn.execute("DROP SCHEMA IF EXISTS work CASCADE")
        conn.execute((BASE / "r0a-schema-draft.sql").read_text(encoding="utf-8"))


def seed():
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("INSERT INTO work.org (id, name, status, execution_enabled, home_region, revision) "
                    "VALUES (%s, '并发测试组织', 'active', true, 'cn-north', 1)", (ORG,))
        cur.execute("INSERT INTO work.member (org_id, subject_id, status, role, work_seat, revision) "
                    "VALUES (%s, 'user1', 'active', 'owner', true, 1)", (ORG,))
        cur.execute("INSERT INTO work.org_policy (org_id, revision, allow_auto_readonly, policy) "
                    "VALUES (%s, 1, true, '{\"schema\":\"r0a-policy-v1\"}'::jsonb)", (ORG,))
        cur.execute("INSERT INTO work.quota_account (org_id, account_key, period_id, limit_tokens, enforcement) "
                    "VALUES (%s, 'default', %s, 100000, 'soft')", (ORG, PERIOD))
        conn.commit()


# ---------------------------------------------------------------------------
# scenarios
# ---------------------------------------------------------------------------
def race_export_claim(workers=10):
    job = call_worker("SELECT work.create_audit_export(%s, %s, %s, now() - interval '5 days', "
                      "now() - interval '1 day', 'csv')", (ORG, 'user1', 'race-claim-0001'), subject='user1')
    export_id = as_dict(must_ok(job, 'export claim'))["id"]
    barrier = threading.Barrier(workers)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(
            lambda i: call_worker("SELECT work.claim_audit_export(%s, %s, 600)",
                               (export_id, 'worker-%d' % i), role='work_worker', barrier=barrier),
            range(workers)))
    wins = [r for r in results if r[0]]
    codes = {}
    for ok, value in results:
        if not ok:
            codes[value] = codes.get(value, 0) + 1
    return {"workers": workers, "winners": len(wins), "loss_codes": codes,
            "db_state": scalar("SELECT status FROM work.audit_export WHERE id = %s", (export_id,))}


def race_lease_takeover():
    job = call_worker("SELECT work.create_audit_export(%s, %s, %s, now() - interval '4 days', "
                      "now() - interval '1 day', 'json')", (ORG, 'user1', 'race-lease-0001'), subject='user1')
    export_id = as_dict(must_ok(job, 'lease takeover'))["id"]
    a = call_worker("SELECT work.claim_audit_export(%s, %s, 600)", (export_id, "worker-a"), role="work_worker")
    with connect() as conn:
        conn.execute("UPDATE work.audit_export SET lease_until = now() - interval '1 second' WHERE id = %s",
                     (export_id,))
        conn.commit()
    b = call_worker("SELECT work.claim_audit_export(%s, %s, 600)", (export_id, "worker-b"), role="work_worker")
    stale = call_worker("SELECT work.complete_audit_export(%s, 'worker-a', 'content://org1/a.json', "
                        "'sha256:aaaaaaaa', 10, 1, 3600)", (export_id,), role="work_worker")
    fresh = call_worker("SELECT work.complete_audit_export(%s, 'worker-b', 'content://org1/b.json', "
                        "'sha256:bbbbbbbb', 10, 1, 3600)", (export_id,), role="work_worker")
    return {"a_claimed": a[0], "b_claimed_after_expiry": b[0],
            "stolder_holder_complete": stale[1] if not stale[0] else "unexpected-success",
            "current_holder_complete": "ok" if fresh[0] else fresh[1],
            "db_state": scalar("SELECT status FROM work.audit_export WHERE id = %s", (export_id,))}


def race_download_token(workers=5):
    job = call_worker("SELECT work.create_audit_export(%s, %s, %s, now() - interval '3 days', "
                      "now() - interval '1 day', 'csv')", (ORG, 'user1', 'race-token-0001'), subject='user1')
    export_id = as_dict(must_ok(job, 'download token'))["id"]
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("SELECT set_config('role', 'work_worker', true)")
        cur.execute("SELECT set_config('app.org_id', %s, true)", (ORG,))
        cur.execute("SELECT work.claim_audit_export(%s, %s, 600)", (export_id, "worker-a"))
        cur.execute("SELECT work.complete_audit_export(%s, 'worker-a', 'content://org1/race.csv', "
                    "'sha256:cccccccc', 64, 3, 86400)", (export_id,))
        conn.commit()
    token = uuid.uuid4().hex + uuid.uuid4().hex[:16]
    issued = call_worker("SELECT work.issue_audit_export_download(%s, %s, %s, encode(sha256(%s::bytea),'hex'), 300)",
                         (ORG, 'user1', export_id, token), subject='user1')
    barrier = threading.Barrier(workers)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda _: call_worker(
            "SELECT work.redeem_audit_export_download(%s, %s, encode(sha256(%s::bytea),'hex'))",
            (ORG, "user1", token), subject="user1", barrier=barrier), range(workers)))
    codes = {}
    for ok, value in results:
        key = "success" if ok else value
        codes[key] = codes.get(key, 0) + 1
    return {"issued": issued[0], "workers": workers, "outcomes": codes,
            "downloaded_at_count": scalar("SELECT count(*) FROM work.audit_export WHERE id = %s AND downloaded_at IS NOT NULL",
                                          (export_id,))}


def burst(fn_for_revision, revisions, role="work_directory", subject=None):
    """Fire one call per revision at the same instant; return (applied, rejected) lists."""
    calls = [(rev,) + fn_for_revision(rev) for rev in revisions]
    random.shuffle(calls)
    barrier = threading.Barrier(len(calls))

    def run(call):
        return call_worker(call[1], call[2], role=role, subject=subject, barrier=barrier)

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(calls)) as pool:
        results = list(pool.map(run, calls))
    applied, rejected = [], {}
    for call, (ok, value) in zip(calls, results):
        if ok:
            applied.append(call[0])
        else:
            rejected[value] = rejected.get(value, 0) + 1
    return applied, rejected


def race_projection():
    """At-least-once directory sync arrives out of order: the projection must never move backwards."""
    org_sql = lambda rev: ("SELECT work.sync_org_projection(%s, %s, 'active', true, 'cn-north', %s)",
                           (ORG, "并发测试组织", rev))
    member_sql = lambda rev: ("SELECT work.sync_member_projection(%s, %s, 'active', 'member', true, %s)",
                              (ORG, "user-race", rev))
    # 同一成员、同一载荷，只有修订号不同：修订号最大者必须成为终态。
    org_applied, org_rejected = burst(org_sql, [2, 3, 4, 5, 6, 7, 8, 9])
    member_applied, member_rejected = burst(member_sql, [2, 3, 4, 5, 6, 7, 8, 9])
    org_rev = scalar("SELECT revision FROM work.org WHERE id = %s", (ORG,))
    member_rev = scalar("SELECT revision FROM work.member WHERE org_id = %s AND subject_id = 'user-race'", (ORG,))
    # 重复投递：目录适配器是 at-least-once，同一修订号并发只允许落地一次。
    dup_applied, dup_rejected = burst(member_sql, [10, 10, 10, 10])
    return {
        "org": {"applied": sorted(org_applied), "rejected": org_rejected,
                "final_revision": org_rev, "lost_update": org_rev != max(org_applied or [0])},
        "member": {"applied": sorted(member_applied), "rejected": member_rejected,
                   "final_revision": member_rev, "lost_update": member_rev != max(member_applied or [0])},
        "duplicate_delivery": {"workers": 4, "applied": len(dup_applied), "rejected": dup_rejected},
    }


def race_expiry_sweep(workers=3):
    """Content purged exactly once: two sweeps must not both skip the shared ref."""
    refs = []
    for n in range(2):
        ref = "content://org1/shared-sweep-%d" % n
        refs.append(ref)
        for subject in ("user1", "user-race"):
            must_ok(call_worker("SELECT work.create_input(%s, %s, %s, %s, 64, 'application/json')",
                                (ORG, subject, ref, 'sha256:' + ref.replace('/', '')),
                                subject=subject), 'seed shared input')
    barrier = threading.Barrier(workers)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda _: call_worker(
            "SELECT work.expire_due_inputs(now() + interval '30 hours')", (),
            role="work_worker", barrier=barrier), range(workers)))
    return {"workers": workers,
            "swept": [r[1] for r in results if r[0]],
            "errors": [r[1] for r in results if not r[0]],
            "expired_inputs": scalar("SELECT count(*) FROM work.input_object WHERE org_id = %s AND status = 'expired'", (ORG,)),
            "shred_rows": scalar("SELECT count(*) FROM work.outbox WHERE org_id = %s AND aggregate_type = 'content' "
                                 "AND payload->>'kind' = 'content_shred'", (ORG,)),
            "distinct_refs": scalar("SELECT count(DISTINCT r) FROM work.outbox o, LATERAL jsonb_array_elements_text(o.payload->'content_refs') r "
                                     "WHERE o.org_id = %s AND o.payload->>'kind' = 'content_shred'", (ORG,))}


def race_submit_after_revocation(workers=6):
    """How many submissions slip through while a revocation commits mid-burst."""
    call_worker("SELECT work.sync_member_projection(%s, %s, 'active', 'member', true, 10)",
                (ORG, "user-slip"), role="work_directory")
    barrier = threading.Barrier(workers + 1)

    def submit(i):
        return call_worker("SELECT work.create_input(%s, %s, %s, %s, 64, 'application/json')",
                           (ORG, "user-slip", "content://org1/slip-%d" % i, "sha256:slip-%d" % i),
                           subject="user-slip", barrier=barrier)

    def revoke():
        barrier.wait()
        return call_worker("SELECT work.sync_member_projection(%s, %s, 'active', 'member', false, 11)",
                           (ORG, "user-slip"), role="work_directory")

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers + 1) as pool:
        futures = [pool.submit(submit, i) for i in range(workers)]
        revoker = pool.submit(revoke)
        results = [f.result() for f in futures]
        revoker.result()
    after = call_worker("SELECT work.create_input(%s, %s, %s, %s, 64, 'application/json')",
                        (ORG, "user-slip", "content://org1/slip-after", "sha256:slip-after"), subject="user-slip")
    codes = {}
    for ok, value in results:
        key = "created" if ok else value
        codes[key] = codes.get(key, 0) + 1
    return {"workers": workers, "outcomes": codes,
            "post_revocation_submit": "created" if after[0] else after[1],
            "final_seat": scalar("SELECT work_seat FROM work.member WHERE org_id = %s AND subject_id = 'user-slip'", (ORG,))}


def race_quota_and_overview(workers=6, reads_per_worker=150):
    """admin_overview token totals must equal the ledger even while settlements land."""
    with connect() as conn:
        cur = session(ORG, "work_api", "user1")(conn)
        task = cur.execute(
            "SELECT work.create_input(%s, %s, %s, %s, 64, 'application/json')",
            (ORG, "user1", "content://org1/budget-race", "sha256:budget-race")).fetchone()[0]
        row = cur.execute(
            """SELECT * FROM work.submit_task(%s,%s,%s,%s,'并发预算','ask_each','sha256:snap-race',
                   '{"template":null}'::jsonb, ARRAY['model_call']::text[], '{"provider":"qwen"}'::jsonb,
                   'wf-race-budget', 'pi-1.4.0')""",
            (ORG, "user1", "race-budget-0001", task)).fetchone()
        conn.commit()
        # submit_task returns (task_id, run_id, ...)
        run_id = row[1]
    with connect() as conn:
        cur = session(ORG, "work_worker")(conn)
        cur.execute("SELECT * FROM work.acquire_run(%s, %s)", (run_id, ORG))
        conn.commit()
    reservations = []
    for i in range(workers):
        with connect() as conn:
            cur = session(ORG, "work_worker")(conn)
            op = cur.execute("SELECT work.create_operation(%s, %s, %s, %s, %s)",
                             (run_id, ORG, "op-race-%d" % i, "model", "sha256:params-%d" % i)).fetchone()[0]
            cur.execute("SELECT work.authorize_operation(%s, %s, 1)", (ORG, op))
            res = cur.execute("SELECT work.reserve_quota(%s, %s, %s, %s, %s)",
                              (ORG, "default", PERIOD, op, 100)).fetchone()[0]
            reservations.append(str(res))
            conn.commit()

    # 结算线程对齐到同一瞬间；读者不等待，直接从提交窗口前后连续读。
    barrier = threading.Barrier(workers)

    def settle(res):
        return call_worker("SELECT work.settle_quota(%s, %s, '{\"completion_tokens\":1}'::jsonb, 1)",
                           (res, 90), role="work_worker", barrier=barrier)

    def read_overview(_):
        # 单个读者连续读，读者与结算提交交错：每次读必须落在已结算分录的前缀和上。
        values = []
        for _ in range(reads_per_worker):
            ok, value = call_worker("SELECT work.admin_overview(%s, %s, %s, %s)",
                                    (ORG, "user1", "default", PERIOD), subject="user1")
            if not ok:
                return False, value
            values.append(int(as_dict(value)["quota"]["settled_tokens"]))
        return True, values

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers * 2) as pool:
        futures = [pool.submit(settle, res) for res in reservations]
        futures += [pool.submit(read_overview, i) for i in range(workers)]
        for f in futures:
            results.append(f.result())
    settle_fail = [r[1] for r in results[:workers] if not r[0]]
    overviews = []
    for ok, value in results[workers:]:
        must_ok((ok, value), "overview read loop")
        overviews.extend(value)
    ledger = scalar("SELECT COALESCE(SUM(amount_tokens),0) FROM work.quota_entry "
                    "WHERE org_id = %s AND kind = 'settle'", (ORG,))
    account = scalar("SELECT row_to_json(b) FROM (SELECT settled_tokens, reserved_tokens "
                     "FROM work.quota_account WHERE org_id = %s AND account_key = 'default' "
                     "AND period_id = %s) b", (ORG, PERIOD))
    # 读到旧值不是缺陷（MVCC 快照），读到不属于任何已提交分录前缀的金额才是。
    observed = sorted(set(overviews))
    legal = {amount * 90 for amount in range(0, len(reservations) + 1)}
    final = as_dict(must_ok(call_worker("SELECT work.admin_overview(%s, %s, %s, %s)",
                                         (ORG, "user1", "default", PERIOD), subject="user1"),
                            "final overview read"))["quota"]
    return {"settled_calls": workers, "settle_errors": settle_fail,
            "ledger_settled_tokens": int(ledger), "account": as_dict(account),
            "overview_reads": len(overviews),
            "observed_settled_tokens": observed,
            "reads_interleaved_with_commits": len(observed) > 1,
            "reads_off_ledger_prefix": sorted(set(overviews) - legal),
            "final_read_matches_ledger": (int(final["settled_tokens"]) == int(ledger)
                                          and int(final["reserved_tokens"])
                                          == int(as_dict(account)["reserved_tokens"]))}


def race_provider_config(workers=6):
    """并发写接入配置：同一个 expected_revision 只能有一个成功，始终只有一条 active。"""
    cred = must_ok(call_worker(
        "SELECT credential_id FROM work.create_provider_credential"
        "(%s, %s, 'aliyun', 'managed_key', NULL, decode('00', 'hex'), NULL, NULL,"
        " 'fp-race-config-0001')",
        (ORG, "user1"), subject="user1"), "credential create")
    must_ok(call_worker(
        "SELECT revision FROM work.set_provider_config"
        "(%s, %s, 'aliyun', 'qwen3.8-flash', 'cn-beijing', 'https://example.invalid',"
        " 'managed_key', %s)",
        (ORG, "user1", cred), subject="user1"), "initial config")
    barrier = threading.Barrier(workers)

    def write(_):
        return call_worker(
            "SELECT revision FROM work.set_provider_config"
            "(%s, %s, 'aliyun', 'qwen3.8-flash', 'cn-beijing', 'https://example.invalid',"
            " 'managed_key', %s, 1)",
            (ORG, "user1", cred), subject="user1", barrier=barrier)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = [f.result() for f in [pool.submit(write, i) for i in range(workers)]]
    successes = [r for r in results if r[0]]
    failures = [r[1] for r in results if not r[0]]
    return {
        "workers": workers,
        "successes": len(successes),
        "success_revisions": sorted(int(r[1]) for r in successes),
        "conflicts": failures,
        "active_rows": int(scalar("SELECT count(*) FROM work.provider_access_config "
                                  "WHERE org_id = %s AND state = 'active'", (ORG,))),
        "max_revision": int(scalar("SELECT COALESCE(MAX(revision), 0) "
                                   "FROM work.provider_access_config WHERE org_id = %s", (ORG,))),
    }


def race_usage_upsert(workers=10):
    """并发累加同一天的用量：每次 +1，最终必须恰好等于次数（不丢更新）。"""
    barrier = threading.Barrier(workers)

    def add(_):
        return call_worker(
            "SELECT 1 FROM (SELECT work.record_usage"
            "(%s, 'user1', gen_random_uuid(), 'aliyun', 'qwen3.8-flash', DATE '2026-10-21', 1, 1, 0, 1)) x",
            (ORG,), role="work_worker", barrier=barrier)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = [f.result() for f in [pool.submit(add, i) for i in range(workers)]]
    total = scalar("SELECT input_tokens FROM work.usage_daily "
                   "WHERE org_id = %s AND subject_id = 'user1' AND usage_date = DATE '2026-10-21'",
                   (ORG,))
    return {"workers": workers,
            "errors": [r[1] for r in results if not r[0]],
            "input_tokens": int(total or 0)}


def verify(report):
    """Turn the measured races into a gate: violations fail the run, numbers still get logged."""
    races = report["export_claim_single_winner"]
    projection = report["projection_revision_race"]
    sweep = report["expiry_sweep_shared_ref"]
    budget = report["admin_overview_vs_settlements"]
    token = report["download_token_single_use"]
    revocation = report["submit_during_revocation"]
    checks = {
        "export_claim_single_winner": races["winners"] == 1 and races["db_state"] == "running",
        "export_lease_takeover": (report["export_lease_takeover"]["stolder_holder_complete"]
                                  == "audit_export_lease_lost"
                                  and report["export_lease_takeover"]["db_state"] == "ready"),
        "download_token_single_use": (token["outcomes"].get("success") == 1
                                      and token["downloaded_at_count"] == 1),
        "projection_monotonic": (not projection["org"]["lost_update"]
                                 and not projection["member"]["lost_update"]
                                 and projection["duplicate_delivery"]["applied"] == 1),
        "expiry_sweep_shreds_once": (sweep["errors"] == [] and sweep["expired_inputs"] == 4
                                     and sweep["shred_rows"] == 2 and sweep["distinct_refs"] == 2),
        "revocation_blocks_new_work": (revocation["post_revocation_submit"] == "work_seat_required"
                                       and revocation["final_seat"] is False),
        "provider_config_one_active": (report["provider_config_revision_race"]["successes"] == 1
                                       and report["provider_config_revision_race"]["active_rows"] == 1
                                       and report["provider_config_revision_race"]["max_revision"] == 2
                                       and all(c == "revision_conflict"
                                               for c in report["provider_config_revision_race"]["conflicts"])),
        "usage_upsert_no_lost_update": (report["usage_upsert_race"]["errors"] == []
                                        and report["usage_upsert_race"]["input_tokens"]
                                        == report["usage_upsert_race"]["workers"]),
        "overview_matches_ledger": (budget["settle_errors"] == []
                                    and budget["reads_off_ledger_prefix"] == []
                                    and budget["final_read_matches_ledger"]
                                    and budget["account"]["reserved_tokens"] == 0),
    }
    violations = [name for name, held in checks.items() if not held]
    return checks, violations


def main():
    started = time.time()
    reset()
    seed()
    report = {
        "database": "postgresql 16 / work_r0a (disposable)",
        "export_claim_single_winner": race_export_claim(),
        "export_lease_takeover": race_lease_takeover(),
        "download_token_single_use": race_download_token(),
        "projection_revision_race": race_projection(),
        "expiry_sweep_shared_ref": race_expiry_sweep(),
        "submit_during_revocation": race_submit_after_revocation(),
        "admin_overview_vs_settlements": race_quota_and_overview(),
        "provider_config_revision_race": race_provider_config(),
        "usage_upsert_race": race_usage_upsert(),
        "wall_seconds": round(time.time() - started, 2),
    }
    checks, violations = verify(report)
    report["gate"] = {"checks": checks, "violations": violations}
    text = json.dumps(report, ensure_ascii=False, indent=2, default=str)
    LOG.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(text)
    if violations:
        raise SystemExit('race invariants violated: ' + ', '.join(violations))


if __name__ == "__main__":
    main()
