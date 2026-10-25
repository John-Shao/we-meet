"""Assemble the R0a schema draft from the full Work DDL draft.

The R0a subset reuses the reviewed table/function bodies for core entities,
drops R0b/R1/R2/R3 tables, and adds input objects, task metadata, approval
commands, outbox delivery, and the least-privilege role/RLS model.
"""

from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "work-ddl-draft-2026-10-25.sql"
OUT = HERE / "r0a-schema-draft.sql"

text = SRC.read_text(encoding="utf-8")


def table(name: str) -> str:
    start = text.find(f"CREATE TABLE work.{name} (")
    if start < 0:
        raise SystemExit(f"missing table: {name}")
    end = text.find("\n);", start)
    if end < 0:
        raise SystemExit(f"unterminated table: {name}")
    return text[start:end + 3]


def block(start_marker: str, end_marker: str) -> str:
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"missing block: {start_marker}")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"unterminated block: {start_marker}")
    return text[start:end].rstrip() + "\n"


tables = {name: table(name) for name in [
    "org", "member", "org_policy", "capability_snapshot",
    "task", "run", "operation", "approval", "approval_operation",
    "approval_decision", "submission_dedup", "budget_account",
    "budget_reservation", "budget_entry", "artifact", "artifact_version",
    "upload_session", "acceptance", "artifact_tombstone",
    "task_event", "audit_event", "outbox",
]}

state = block(
    "CREATE TABLE work.state_transition (",
    "CREATE FUNCTION work.enforce_state_transition()",
)

functions = block(
    "CREATE FUNCTION work.enforce_state_transition()",
    "-- ---------------------------------------------------------------------------\n-- RLS",
)
functions = functions.replace(
    """  IF run_row.state NOT IN ('active', 'waiting') THEN
    RAISE EXCEPTION 'run_not_accepting_operations' USING ERRCODE = 'P0001';
  END IF;""",
    """  IF run_row.state NOT IN ('active', 'waiting') THEN
    RAISE EXCEPTION 'run_not_accepting_operations' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind NOT IN ('model', 'tool', 'artifact') THEN
    RAISE EXCEPTION 'scope_unavailable:operation_kind' USING ERRCODE = 'P0001';
  END IF;""",
)

extra = (HERE / "r0a-extra.sql").read_text(encoding="utf-8").rstrip() + "\n"
_marker = "ALTER TABLE work.task ADD COLUMN input_id"
if _marker not in extra:
    raise SystemExit("extra task marker missing")
extra_before_task, extra_after_task = extra.split(_marker, 1)
extra_after_task = _marker + extra_after_task
new_functions = (HERE / "r0a-new-functions.sql").read_text(encoding="utf-8").rstrip() + "\n"
rls = (HERE / "r0a-rls-grants.sql").read_text(encoding="utf-8").rstrip() + "\n"

header = """-- Work R0a 领域模型可执行草案
-- 目标：PostgreSQL 16；schema: work
-- 状态：D1 详细设计草案，未应用生产。用于验证 R0a 表裁剪、角色/RLS、SECURITY DEFINER 与核心领域命令。
-- 约定：
--   * 在一次性数据库执行；脚本会 DROP SCHEMA work 与相关角色。
--   * 正文/检查点不进入本库；input_object/artifact_version 只存 Content Store 引用与哈希。
--   * 应用角色 work_api/work_worker 只有 SELECT 与受限函数 EXECUTE，没有直接 DML。
--   * RLS 以 current_setting('app.org_id', true) 为租户上下文；FORCE RLS 覆盖表 owner。
--   * work_owner 为 NOLOGIN；work_api/work_worker/work_ledger 也是 NOLOGIN，部署时由服务身份承载。
BEGIN;

DROP SCHEMA IF EXISTS work CASCADE;
DROP ROLE IF EXISTS work_api;
DROP ROLE IF EXISTS work_worker;
DROP ROLE IF EXISTS work_ledger;
DROP ROLE IF EXISTS work_migrator;
DROP ROLE IF EXISTS work_ops;
DROP ROLE IF EXISTS work_owner;

CREATE ROLE work_owner NOLOGIN;
CREATE ROLE work_api NOLOGIN;
CREATE ROLE work_worker NOLOGIN;
CREATE ROLE work_ledger NOLOGIN;
CREATE ROLE work_migrator NOLOGIN;
CREATE ROLE work_ops NOLOGIN;

CREATE SCHEMA work AUTHORIZATION work_owner;
SET LOCAL ROLE work_owner;
"""

indexes_task_run = """
-- Task/Run 复合外键与唯一开放 Run
ALTER TABLE work.task
  ADD CONSTRAINT fk_task_active_run
  FOREIGN KEY (active_run_id, id, org_id)
  REFERENCES work.run(id, task_id, org_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work.task
  ADD CONSTRAINT fk_task_latest_run
  FOREIGN KEY (latest_run_id, id, org_id)
  REFERENCES work.run(id, task_id, org_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work.capability_snapshot
  ADD CONSTRAINT fk_snapshot_task
  FOREIGN KEY (task_id, org_id)
  REFERENCES work.task(id, org_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX work_run_one_open_per_task
  ON work.run(task_id)
  WHERE state IN ('queued', 'active', 'waiting', 'cancel_requested');
CREATE INDEX work_run_task_state ON work.run(org_id, task_id, state);
CREATE INDEX work_task_owner_state ON work.task(org_id, owner_subject_id, state);
"""

indexes_operation = """
CREATE INDEX work_operation_run_state ON work.operation(org_id, run_id, state);
CREATE INDEX work_operation_reconcile ON work.operation(org_id, state)
  WHERE state IN ('dispatching', 'unknown');
"""

indexes_budget = """
CREATE UNIQUE INDEX work_budget_one_active_reservation
  ON work.budget_reservation(operation_id)
  WHERE state IN ('held', 'unknown');
CREATE UNIQUE INDEX work_budget_settlement_unique
  ON work.budget_entry(operation_id, settlement_revision)
  WHERE kind IN ('settle', 'adjust') AND settlement_revision > 0;
"""

indexes_outbox = """
CREATE INDEX work_outbox_pending ON work.outbox(available_at)
  WHERE delivered_at IS NULL;
"""

parts = [header]
parts.append("\n-- 组织与成员\n")
parts.append(tables["org"] + "\n\n")
parts.append(tables["member"] + "\n\n")
parts.append(tables["org_policy"] + "\n\n")
parts.append("-- 执行快照、输入、任务\n")
parts.append(tables["capability_snapshot"] + "\n\n")
parts.append(extra_before_task + "\n")
parts.append(tables["task"] + "\n\n")
parts.append(extra_after_task + "\n")
parts.append(tables["run"] + "\n\n")
parts.append(indexes_task_run + "\n")
parts.append(tables["operation"] + "\n\n")
parts.append(indexes_operation + "\n")
parts.append("-- 审批\n")
parts.append(tables["approval"] + "\n\n")
parts.append(tables["approval_operation"] + "\n\n")
parts.append(tables["approval_decision"] + "\n\n")
parts.append("-- 提交去重与预算\n")
parts.append(tables["submission_dedup"] + "\n\n")
parts.append(tables["budget_account"] + "\n\n")
parts.append(tables["budget_reservation"] + "\n\n")
parts.append(tables["budget_entry"] + "\n\n")
parts.append(indexes_budget + "\n")
parts.append("-- 成果\n")
parts.append(tables["artifact"] + "\n\n")
parts.append(tables["artifact_version"] + "\n\n")
parts.append(tables["upload_session"] + "\n\n")
parts.append(tables["acceptance"] + "\n\n")
parts.append(tables["artifact_tombstone"] + "\n\n")
parts.append("-- 事件、审计、Outbox、状态迁移\n")
parts.append(tables["task_event"] + "\n\n")
parts.append(tables["audit_event"] + "\n\n")
parts.append(tables["outbox"] + "\n\n")
parts.append(indexes_outbox + "\n")
parts.append(state + "\n")
parts.append("""
-- D3 reconciliation: an unresolved Operation can be resolved later.
INSERT INTO work.state_transition (entity, from_state, to_state) VALUES
  ('operation', 'unresolved', 'reconciled')
ON CONFLICT DO NOTHING;
""")
parts.append(functions + "\n")
parts.append(new_functions + "\n")
parts.append(rls + "\n")
parts.append("RESET ROLE;\nCOMMIT;\n")

OUT.write_text("".join(parts), encoding="utf-8", newline="\n")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
