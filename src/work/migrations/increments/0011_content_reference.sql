-- 0011: Content-reference registry for the trusted content proxy.
--
-- Authority: D1 §5.5 row "内容代理的引用注册表" (ref_id -> org/task/run, kind,
-- logical_slot, immutable object_version, hash/bytes, writer identity and
-- tombstone; body never stored in PG; same slot only accepts the same hash
-- replay; receipt slots are written only by the trusted egress; checkpoint
-- slots only accept candidates bound to a fragment; a tombstone never revives
-- content authorisation) and D1 §5.4 "回执与用量的原子收尾" (trusted external
-- evidence is registered before settlement; late receipts attach as evidence
-- only). D4 §8.1 "可信回执的持久性与迟到处理" fixes the receipt slot to the
-- consumed gate and forbids Node self-reporting; D4 §6.3 keeps object-store
-- access in the control plane and separates the child content listener from
-- the privileged receipt path.
--
-- Node/egress never hold a database login. The control plane calls these
-- SECURITY DEFINER commands as work_worker with an explicit tenant context.
-- work_api gets no EXECUTE and no table DML; no role gets table DML. The table
-- holds metadata only: there is no body column and there never will be.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- Persistent object
-- ---------------------------------------------------------------------------

-- One immutable content reference per logical slot per organization. The
-- binding columns are immutable; tombstoning is a one-way timestamp and rows
-- are never deleted. content_ref/content_hash/bytes describe the object-store
-- object, not the bytes themselves.
CREATE TABLE work.content_reference (
  ref_id uuid PRIMARY KEY,
  org_id text NOT NULL,
  task_id uuid,
  run_id uuid,
  execution_id uuid,
  kind text NOT NULL CHECK (kind IN (
    'input', 'template', 'checkpoint_candidate', 'answer', 'receipt',
    'rejection_evidence'
  )),
  logical_slot text NOT NULL CHECK (
    length(logical_slot) BETWEEN 1 AND 512
    AND logical_slot !~ '[^A-Za-z0-9_.:@/-]'
  ),
  object_version text NOT NULL CHECK (
    length(object_version) BETWEEN 1 AND 256
    AND object_version !~ '[^A-Za-z0-9_.:@+/=-]'
  ),
  content_ref text NOT NULL CHECK (
    length(btrim(content_ref)) > 0 AND length(content_ref) <= 512
  ),
  content_hash text NOT NULL CHECK (
    content_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  writer_kind text NOT NULL CHECK (writer_kind IN ('control_plane', 'egress')),
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_reference_org_ref_unique UNIQUE (org_id, ref_id),
  CONSTRAINT content_reference_slot_unique UNIQUE (org_id, logical_slot),
  FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id),
  FOREIGN KEY (run_id, task_id, org_id) REFERENCES work.run(id, task_id, org_id),
  FOREIGN KEY (execution_id, org_id)
    REFERENCES work.runtime_execution(execution_id, org_id),
  -- A fragment-bound reference carries its whole binding. The command layer
  -- additionally verifies that execution -> task/run holds; the composite FKs
  -- keep every non-null edge inside the same tenant.
  CONSTRAINT content_reference_binding CHECK (
    (run_id IS NULL OR task_id IS NOT NULL)
    AND (execution_id IS NULL OR (task_id IS NOT NULL AND run_id IS NOT NULL))
  ),
  -- A receipt, public answer and rejection evidence are trusted external
  -- evidence: only the egress path may write them. Inputs and templates are
  -- control-plane reads: only the control plane may publish them. The stricter
  -- reading also refuses an egress-written input or template, so a compromised
  -- egress cannot mint reader authorisation.
  CONSTRAINT content_reference_kind_writer CHECK (
    (kind NOT IN ('receipt', 'answer', 'rejection_evidence') OR writer_kind = 'egress')
    AND (kind NOT IN ('input', 'template') OR writer_kind = 'control_plane')
  ),
  -- Candidates and receipts belong to one fragment; an unbound slot can never
  -- be attached to a head or a gate later.
  CONSTRAINT content_reference_execution_required CHECK (
    kind NOT IN ('checkpoint_candidate', 'receipt') OR execution_id IS NOT NULL
  )
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE work.content_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.content_reference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.content_reference
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---------------------------------------------------------------------------
-- Immutability, tombstone direction, no delete
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.content_reference_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  -- Everything that makes the reference unique or describes the authorised
  -- object is immutable. Only tombstoned_at may ever move, once, from NULL to
  -- a timestamp.
  IF NEW.ref_id IS DISTINCT FROM OLD.ref_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.logical_slot IS DISTINCT FROM OLD.logical_slot
     OR NEW.object_version IS DISTINCT FROM OLD.object_version
     OR NEW.content_ref IS DISTINCT FROM OLD.content_ref
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.writer_kind IS DISTINCT FROM OLD.writer_kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'content_reference_binding_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.tombstoned_at IS NOT NULL THEN
    -- A tombstoned row is final. It cannot be un-tombstoned, re-tombstoned or
    -- touched again; the audit trail is the only record of later calls.
    RAISE EXCEPTION 'content_reference_tombstone_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.tombstoned_at IS NULL THEN
    RAISE EXCEPTION 'content_reference_update_forbidden' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_reference_guard BEFORE UPDATE ON work.content_reference
  FOR EACH ROW EXECUTE FUNCTION work.content_reference_guard();
-- References are never deleted: a tombstone is the terminal state and keeps
-- the minimal binding/hash evidence for ledger replay.
CREATE TRIGGER content_reference_no_delete BEFORE DELETE ON work.content_reference
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

-- ---------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------

-- Register one immutable reference. The slot is the idempotency key:
--   * the exact same binding (ref_id, kind, task/run/execution, object_version,
--     content_ref, content_hash, bytes, writer_kind) returns idempotent;
--   * any other replay of a live slot raises content_slot_conflict;
--   * a tombstoned slot cannot be re-registered at all.
-- The stricter reading treats ref_id and object_version as binding: a caller
-- cannot reuse a slot to alias a second reference or object version.
CREATE FUNCTION work.register_content_reference(
  p_org_id text,
  p_ref_id uuid,
  p_task_id uuid,
  p_run_id uuid,
  p_execution_id uuid,
  p_kind text,
  p_logical_slot text,
  p_object_version text,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint,
  p_writer_kind text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  existing work.content_reference%ROWTYPE;
  v_exec_task_id uuid;
  v_exec_run_id uuid;
  v_run_task_id uuid;
  v_inserted uuid;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF p_ref_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:ref_id' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN (
    'input', 'template', 'checkpoint_candidate', 'answer', 'receipt',
    'rejection_evidence'
  ) THEN
    RAISE EXCEPTION 'invalid_request:kind' USING ERRCODE = '22023';
  END IF;
  IF p_logical_slot IS NULL
     OR length(p_logical_slot) NOT BETWEEN 1 AND 512
     OR p_logical_slot ~ '[^A-Za-z0-9_.:@/-]' THEN
    RAISE EXCEPTION 'invalid_request:logical_slot' USING ERRCODE = '22023';
  END IF;
  IF p_object_version IS NULL
     OR length(p_object_version) NOT BETWEEN 1 AND 256
     OR p_object_version ~ '[^A-Za-z0-9_.:@+/=-]' THEN
    RAISE EXCEPTION 'invalid_request:object_version' USING ERRCODE = '22023';
  END IF;
  PERFORM work.assert_content_ref('content_ref', p_content_ref);
  PERFORM work.assert_document_hash('content_hash', p_content_hash);
  IF p_bytes IS NULL OR p_bytes < 0 THEN
    RAISE EXCEPTION 'invalid_request:bytes' USING ERRCODE = '22023';
  END IF;
  IF p_writer_kind IS NULL OR p_writer_kind NOT IN ('control_plane', 'egress') THEN
    RAISE EXCEPTION 'invalid_request:writer_kind' USING ERRCODE = '22023';
  END IF;

  IF p_run_id IS NOT NULL AND p_task_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:binding' USING ERRCODE = '22023';
  END IF;
  IF p_execution_id IS NOT NULL AND (p_task_id IS NULL OR p_run_id IS NULL) THEN
    RAISE EXCEPTION 'invalid_request:binding' USING ERRCODE = '22023';
  END IF;
  IF p_kind IN ('receipt', 'answer', 'rejection_evidence')
     AND p_writer_kind <> 'egress' THEN
    RAISE EXCEPTION 'content_reference_writer_not_allowed' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind IN ('input', 'template') AND p_writer_kind <> 'control_plane' THEN
    RAISE EXCEPTION 'content_reference_writer_not_allowed' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind IN ('checkpoint_candidate', 'receipt') AND p_execution_id IS NULL THEN
    RAISE EXCEPTION 'content_reference_execution_required' USING ERRCODE = 'P0001';
  END IF;

  IF p_task_id IS NOT NULL THEN
    PERFORM 1 FROM work.task t
    WHERE t.id = p_task_id AND t.org_id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF p_run_id IS NOT NULL THEN
    SELECT r.task_id INTO v_run_task_id
    FROM work.run r
    WHERE r.id = p_run_id AND r.org_id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_run_task_id IS DISTINCT FROM p_task_id THEN
      RAISE EXCEPTION 'content_reference_binding_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF p_execution_id IS NOT NULL THEN
    SELECT e.task_id, e.run_id INTO v_exec_task_id, v_exec_run_id
    FROM work.runtime_execution e
    WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
    END IF;
    -- Late receipts/candidates are allowed for a revoked or expired fragment,
    -- but the fragment must still be the one named by task/run.
    IF v_exec_task_id IS DISTINCT FROM p_task_id
       OR v_exec_run_id IS DISTINCT FROM p_run_id THEN
      RAISE EXCEPTION 'content_reference_binding_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT * INTO existing
  FROM work.content_reference cr
  WHERE cr.org_id = p_org_id AND cr.logical_slot = p_logical_slot
  FOR UPDATE;
  IF FOUND THEN
    IF existing.tombstoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001',
        DETAIL = 'tombstoned';
    END IF;
    IF existing.ref_id = p_ref_id
       AND existing.kind = p_kind
       AND existing.task_id IS NOT DISTINCT FROM p_task_id
       AND existing.run_id IS NOT DISTINCT FROM p_run_id
       AND existing.execution_id IS NOT DISTINCT FROM p_execution_id
       AND existing.object_version = p_object_version
       AND existing.content_ref = p_content_ref
       AND existing.content_hash = p_content_hash
       AND existing.bytes = p_bytes
       AND existing.writer_kind = p_writer_kind THEN
      RETURN jsonb_build_object('outcome', 'idempotent', 'ref_id', existing.ref_id);
    END IF;
    RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO work.content_reference
      (ref_id, org_id, task_id, run_id, execution_id, kind, logical_slot,
       object_version, content_ref, content_hash, bytes, writer_kind)
    VALUES
      (p_ref_id, p_org_id, p_task_id, p_run_id, p_execution_id, p_kind,
       p_logical_slot, p_object_version, p_content_ref, p_content_hash,
       p_bytes, p_writer_kind)
    ON CONFLICT ON CONSTRAINT content_reference_slot_unique DO NOTHING
    RETURNING ref_id INTO v_inserted;
  EXCEPTION WHEN unique_violation THEN
    -- The only unhandled unique key left is ref_id: never let a replay alias a
    -- different logical slot onto an existing reference id.
    RAISE EXCEPTION 'content_reference_conflict' USING ERRCODE = 'P0001';
  END;
  IF v_inserted IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'registered', 'ref_id', v_inserted);
  END IF;

  -- Another transaction won the slot while this one was inserting. It must be
  -- the exact same binding to count as an idempotent replay.
  SELECT * INTO existing
  FROM work.content_reference cr
  WHERE cr.org_id = p_org_id AND cr.logical_slot = p_logical_slot
  FOR UPDATE;
  IF FOUND
     AND existing.tombstoned_at IS NULL
     AND existing.ref_id = p_ref_id
     AND existing.kind = p_kind
     AND existing.task_id IS NOT DISTINCT FROM p_task_id
     AND existing.run_id IS NOT DISTINCT FROM p_run_id
     AND existing.execution_id IS NOT DISTINCT FROM p_execution_id
     AND existing.object_version = p_object_version
     AND existing.content_ref = p_content_ref
     AND existing.content_hash = p_content_hash
     AND existing.bytes = p_bytes
     AND existing.writer_kind = p_writer_kind THEN
    RETURN jsonb_build_object('outcome', 'idempotent', 'ref_id', existing.ref_id);
  END IF;
  RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001';
END;
$$;

-- Resolve one live reference and its complete binding. A tombstoned reference
-- is indistinguishable from a missing one: its old content authorisation must
-- never resurrect. The response carries metadata only, never body bytes.
CREATE FUNCTION work.resolve_content_reference(
  p_org_id text,
  p_ref_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  reference_row work.content_reference%ROWTYPE;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF p_ref_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:ref_id' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO reference_row
  FROM work.content_reference cr
  WHERE cr.org_id = p_org_id AND cr.ref_id = p_ref_id;
  IF NOT FOUND OR reference_row.tombstoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'content_reference_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object(
    'ref_id', reference_row.ref_id,
    'org_id', reference_row.org_id,
    'task_id', reference_row.task_id,
    'run_id', reference_row.run_id,
    'execution_id', reference_row.execution_id,
    'kind', reference_row.kind,
    'logical_slot', reference_row.logical_slot,
    'object_version', reference_row.object_version,
    'content_ref', reference_row.content_ref,
    'content_hash', reference_row.content_hash,
    'bytes', reference_row.bytes,
    'writer_kind', reference_row.writer_kind
  );
END;
$$;

-- Tombstone one reference. Idempotent: the first call returns true, later
-- calls return false. Every call is audited, so an operator can distinguish a
-- replay from an absent request. The row is never deleted.
CREATE FUNCTION work.tombstone_content_reference(
  p_org_id text,
  p_ref_id uuid,
  p_reason text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  reference_row work.content_reference%ROWTYPE;
  v_changed boolean := false;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF p_ref_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:ref_id' USING ERRCODE = '22023';
  END IF;
  PERFORM work.reason_code(p_reason);
  IF p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_request:reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO reference_row
  FROM work.content_reference cr
  WHERE cr.org_id = p_org_id AND cr.ref_id = p_ref_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'content_reference_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF reference_row.tombstoned_at IS NULL THEN
    UPDATE work.content_reference
    SET tombstoned_at = clock_timestamp(), updated_at = now()
    WHERE org_id = p_org_id AND ref_id = p_ref_id;
    v_changed := true;
  END IF;
  PERFORM work.append_audit(
    p_org_id, NULL, 'content.reference_tombstoned', 'content_reference',
    p_ref_id::text,
    jsonb_build_object(
      'reason', p_reason, 'changed', v_changed, 'kind', reference_row.kind
    )
  );
  RETURN v_changed;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: work_worker only (the control plane's content-proxy module). No
-- table-level DML for anyone, no EXECUTE for work_api/work_directory.
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE work.content_reference FROM PUBLIC;
REVOKE ALL ON TABLE work.content_reference FROM work_api, work_worker,
  work_directory, work_ledger, work_ops;

REVOKE ALL ON FUNCTION work.content_reference_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.register_content_reference(
  text, uuid, uuid, uuid, uuid, text, text, text, text, text, bigint, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.resolve_content_reference(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.tombstone_content_reference(text, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION work.register_content_reference(
  text, uuid, uuid, uuid, uuid, text, text, text, text, text, bigint, text
) TO work_worker;
GRANT EXECUTE ON FUNCTION work.resolve_content_reference(text, uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.tombstone_content_reference(text, uuid, text) TO work_worker;

RESET ROLE;
