# Work 运维/容量证据资产

> 本目录只包含可重复的烟雾脚本与命令，不是生产压测或 DR 演练证明。
>
> 说明：[Work 升级、灾备、SLO 与故障注入 Runbook](../../work-operations-runbook-2026-10-25.md)

## 文件

- `capacity-smoke.py`：当前 `work-ddl-draft` 上的 50 并发预算预留、100 重复提交、10 并发 dispatch CAS 烟雾；需要 Python 3 + `psycopg`。
- 逻辑恢复命令见下方；没有提交 dump 文件。

## 运行

```bash
docker run -d --rm --name work-ops-pg \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=work_ops \
  -p 55439:5432 postgres:16
sleep 2
pip install "psycopg[binary]"
cd docs/plan/assets/work-ops-2026-10-25
python capacity-smoke.py
```

输出示例（2026-10-25，本机 PostgreSQL 16）：

```json
{
  "reservations": {"attempts": 50, "succeeded": 50, "p50_ms": 75.84, "p95_ms": 179.50, "max_ms": 215.38},
  "dedup": {"attempts": 100, "accepted": 1},
  "claim_dispatch": {"attempts": 10, "winners": 1},
  "ledger": {"reserved_cents": 50, "settled_cents": 0}
}
```

## 逻辑恢复烟雾

```bash
docker exec work-ops-pg pg_dump -U postgres -Fc work_ops > /tmp/work_ops.dump
docker exec work-ops-pg createdb -U postgres work_ops_restore
docker exec -i work-ops-pg pg_restore -U postgres -d work_ops_restore < /tmp/work_ops.dump
docker exec work-ops-pg psql -U postgres -d work_ops_restore \
  -c "SELECT count(*) FROM work.task;"
```

2026-10-25 实测：dump 约 440ms、restore 约 2412ms；task=1、operation=50、budget_account=1、artifact_tombstone=1、submission_dedup=1。**不是区域 DR 切换，不证明 RPO/RTO。**

## 边界

- 使用 postgres 超级用户，不验证 RLS/连接池竞态。
- 单机、当前 DDL、无 Temporal/SSE/设备/真实模型/供应商配额。
- 结果只用于容量趋势和回归，不用于生产规格承诺。
