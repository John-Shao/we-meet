-- 0012: Reserved checkpoint-candidate slots for the runtime child.
--
-- Authority: D1 §5.5 row "内容代理的引用注册表" (same slot only accepts the
-- same hash replay; a checkpoint slot only accepts candidates bound to a
-- fragment; a tombstone never revives content authorisation) and §5.4;
-- D4 §6.3 ("仅子进程的 bound read、预留候选 slot、候选写入") and §8.1
-- "Canonical 提交点与恢复算法" (a candidate object is not a fact until the
-- head commits; same slot + same hash recovers, different content conflicts).
--
-- The runtime child never holds a database login. The control plane calls
-- these SECURITY DEFINER commands as work_worker with an explicit tenant
-- context. A reserved row is not a fact: resolve only returns committed rows.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- Slot state and writer domain
-- ---------------------------------------------------------------------------

-- Existing rows are committed facts. A reserved row is a candidate slot the
-- runtime child may still upload into; it carries no readable content yet.
ALTER TABLE work.content_reference
  ADD COLUMN slot_state text NOT NULL DEFAULT 'committed';
ALTER TABLE work.content_reference
  ADD CONSTRAINT content_reference_slot_state_check
  CHECK (slot_state IN ('reserved', 'committed'));

-- Content describing the immutable object is absent until commit. The
-- partial table check below makes "nullable" only legal while reserved.
ALTER TABLE work.content_reference
  ALTER COLUMN content_ref DROP NOT NULL,
  ALTER COLUMN content_hash DROP NOT NULL,
  ALTER COLUMN bytes DROP NOT NULL;

-- Recreate the named writer constraints explicitly: runtime_child is a new
-- writer identity, but only for checkpoint candidates. Inputs/templates stay
-- control-plane-only and receipts/answers/rejection evidence stay
-- egress-only; nothing is widened for the existing writers.
ALTER TABLE work.content_reference
  DROP CONSTRAINT content_reference_writer_kind_check;
ALTER TABLE work.content_reference
  ADD CONSTRAINT content_reference_writer_kind_check
  CHECK (writer_kind IN ('control_plane', 'egress', 'runtime_child'));

ALTER TABLE work.content_reference
  DROP CONSTRAINT content_reference_kind_writer;
ALTER TABLE work.content_reference
  ADD CONSTRAINT content_reference_kind_writer CHECK (
    (kind NOT IN ('receipt', 'answer', 'rejection_evidence')
      OR writer_kind = 'egress')
    AND (kind NOT IN ('input', 'template')
      OR writer_kind = 'control_plane')
    AND (writer_kind <> 'runtime_child' OR kind = 'checkpoint_candidate')
  );

ALTER TABLE work.content_reference
  ADD CONSTRAINT content_reference_slot_content CHECK (
    (slot_state = 'reserved'
      AND content_ref IS NULL
      AND content_hash IS NULL
      AND bytes IS NULL)
    OR (slot_state = 'committed'
      AND content_ref IS NOT NULL
      AND content_hash IS NOT NULL
      AND bytes IS NOT NULL)
  );

-- Only the runtime child may hold a reserved slot, and only for a checkpoint
-- candidate. A reserved row can never be an input, answer or receipt.
ALTER TABLE work.content_reference
  ADD CONSTRAINT content_reference_reserved_writer CHECK (
    slot_state = 'committed'
    OR (writer_kind = 'runtime_child' AND kind = 'checkpoint_candidate')
  );

-- ---------------------------------------------------------------------------
-- Immutability and the one-way reserve -> commit transition
-- ---------------------------------------------------------------------------

-- The binding stays immutable. A reserved row may fill content_ref/hash/bytes
-- exactly once when it moves to committed; a committed row may only be
-- tombstoned. Tombstoned rows are final and rows are never deleted.
CREATE OR REPLACE FUNCTION work.content_reference_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF NEW.ref_id IS DISTINCT FROM OLD.ref_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.logical_slot IS DISTINCT FROM OLD.logical_slot
     OR NEW.object_version IS DISTINCT FROM OLD.object_version
     OR NEW.writer_kind IS DISTINCT FROM OLD.writer_kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'content_reference_binding_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.tombstoned_at IS NOT NULL THEN
    -- A tombstoned row is final. It cannot be un-tombstoned, re-tombstoned or
    -- touched again; the audit trail is the only record of later calls.
    RAISE EXCEPTION 'content_reference_tombstone_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.slot_state = 'committed' THEN
    IF NEW.slot_state IS DISTINCT FROM 'committed'
       OR NEW.content_ref IS DISTINCT FROM OLD.content_ref
       OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
       OR NEW.bytes IS DISTINCT FROM OLD.bytes THEN
      RAISE EXCEPTION 'content_reference_binding_immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.tombstoned_at IS NULL THEN
      RAISE EXCEPTION 'content_reference_update_forbidden' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.slot_state = 'reserved' THEN
    IF NEW.slot_state = 'committed' THEN
      -- The candidate object becomes the committed fact; the content pair is
      -- filled for the first time and no tombstone may race the commit.
      IF NEW.tombstoned_at IS NOT NULL THEN
        RAISE EXCEPTION 'content_reference_update_forbidden' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.slot_state = 'reserved' THEN
      -- A reserved slot may only be tombstoned; it cannot accumulate partial
      -- content or flip back from committed.
      IF NEW.content_ref IS DISTINCT FROM OLD.content_ref
         OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
         OR NEW.bytes IS DISTINCT FROM OLD.bytes THEN
        RAISE EXCEPTION 'content_reference_binding_immutable' USING ERRCODE = '23514';
      END IF;
      IF NEW.tombstoned_at IS NULL THEN
        RAISE EXCEPTION 'content_reference_update_forbidden' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'content_reference_invalid_transition' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'content_reference_invalid_state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------

-- Reserve one candidate slot for the runtime child. The slot is the
-- idempotency key:
--   * the exact same (ref_id, execution_id, kind, logical_slot) replay is
--     idempotent while the slot is still reserved;
--   * a different ref_id (or execution) for an occupied slot raises
--     content_slot_conflict;
--   * a tombstoned or committed slot cannot be reserved.
-- Task/run are derived from the execution row, never from the caller, so a
-- candidate is always bound to the fragment that reserved it.
CREATE FUNCTION work.reserve_content_slot(
  p_org_id text,
  p_ref_id uuid,
  p_execution_id uuid,
  p_kind text,
  p_logical_slot text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  existing work.content_reference%ROWTYPE;
  v_task_id uuid;
  v_run_id uuid;
  v_state text;
  v_inserted boolean := false;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF p_ref_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:ref_id' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS DISTINCT FROM 'checkpoint_candidate' THEN
    RAISE EXCEPTION 'invalid_request:kind' USING ERRCODE = '22023';
  END IF;
  IF p_logical_slot IS NULL
     OR length(p_logical_slot) NOT BETWEEN 1 AND 512
     OR p_logical_slot ~ '[^A-Za-z0-9_.:@/-]' THEN
    RAISE EXCEPTION 'invalid_request:logical_slot' USING ERRCODE = '22023';
  END IF;
  IF p_execution_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:execution_id' USING ERRCODE = '22023';
  END IF;

  SELECT e.task_id, e.run_id, e.state
    INTO v_task_id, v_run_id, v_state
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_state NOT IN ('registered', 'active') THEN
    RAISE EXCEPTION 'runtime_execution_not_active' USING ERRCODE = 'P0001';
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
    IF existing.slot_state = 'committed' THEN
      RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001',
        DETAIL = 'committed';
    END IF;
    IF existing.ref_id = p_ref_id
       AND existing.execution_id = p_execution_id
       AND existing.kind = p_kind THEN
      PERFORM work.append_audit(
        p_org_id, NULL, 'content.reference_reserved', 'content_reference',
        existing.ref_id::text,
        jsonb_build_object(
          'outcome', 'idempotent', 'kind', existing.kind,
          'logical_slot', existing.logical_slot,
          'execution_id', existing.execution_id
        )
      );
      RETURN jsonb_build_object(
        'outcome', 'idempotent', 'ref_id', existing.ref_id,
        'slot_state', 'reserved'
      );
    END IF;
    RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    -- The candidate version has no object-store version until upload; the
    -- reserved row uses its own ref_id as the immutable slot version.
    INSERT INTO work.content_reference
      (ref_id, org_id, task_id, run_id, execution_id, kind, logical_slot,
       object_version, content_ref, content_hash, bytes, writer_kind,
       slot_state)
    VALUES
      (p_ref_id, p_org_id, v_task_id, v_run_id, p_execution_id, p_kind,
       p_logical_slot, p_ref_id::text, NULL, NULL, NULL, 'runtime_child',
       'reserved');
    v_inserted := true;
  EXCEPTION WHEN unique_violation THEN
    -- Either another transaction won the slot or ref_id is already bound to
    -- a different slot. Both are resolved from the authoritative row below.
    v_inserted := false;
  END;
  IF v_inserted THEN
    PERFORM work.append_audit(
      p_org_id, NULL, 'content.reference_reserved', 'content_reference',
      p_ref_id::text,
      jsonb_build_object(
        'outcome', 'reserved', 'kind', p_kind,
        'logical_slot', p_logical_slot, 'execution_id', p_execution_id
      )
    );
    RETURN jsonb_build_object(
      'outcome', 'reserved', 'ref_id', p_ref_id, 'slot_state', 'reserved'
    );
  END IF;

  SELECT * INTO existing
  FROM work.content_reference cr
  WHERE cr.org_id = p_org_id AND cr.logical_slot = p_logical_slot
  FOR UPDATE;
  IF FOUND THEN
    IF existing.tombstoned_at IS NULL
       AND existing.slot_state = 'reserved'
       AND existing.ref_id = p_ref_id
       AND existing.execution_id = p_execution_id
       AND existing.kind = p_kind THEN
      PERFORM work.append_audit(
        p_org_id, NULL, 'content.reference_reserved', 'content_reference',
        existing.ref_id::text,
        jsonb_build_object(
          'outcome', 'idempotent', 'kind', existing.kind,
          'logical_slot', existing.logical_slot,
          'execution_id', existing.execution_id
        )
      );
      RETURN jsonb_build_object(
        'outcome', 'idempotent', 'ref_id', existing.ref_id,
        'slot_state', 'reserved'
      );
    END IF;
    -- The slot is occupied by a different reservation or a fact.
    RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001';
  END IF;
  -- A ref_id may only ever name one logical slot.
  IF EXISTS (
    SELECT 1 FROM work.content_reference cr
    WHERE cr.org_id = p_org_id AND cr.ref_id = p_ref_id
  ) THEN
    RAISE EXCEPTION 'content_reference_conflict' USING ERRCODE = 'P0001';
  END IF;
  RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001';
END;
$$;

-- Commit one reserved candidate. Only reserved -> committed is legal:
--   * the writer must still be the runtime child and the execution binding
--     must still name this org/task/run;
--   * a same-content replay is idempotent, different content or hash raises
--     content_slot_conflict;
--   * a tombstoned slot can never commit;
--   * a registered control-plane/egress row is not a reserved candidate.
CREATE FUNCTION work.commit_content_slot(
  p_org_id text,
  p_ref_id uuid,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  reference_row work.content_reference%ROWTYPE;
  v_task_id uuid;
  v_run_id uuid;
  v_updated integer;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF p_ref_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:ref_id' USING ERRCODE = '22023';
  END IF;
  PERFORM work.assert_content_ref('content_ref', p_content_ref);
  PERFORM work.assert_document_hash('content_hash', p_content_hash);
  IF p_bytes IS NULL OR p_bytes < 0 THEN
    RAISE EXCEPTION 'invalid_request:bytes' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO reference_row
  FROM work.content_reference cr
  WHERE cr.org_id = p_org_id AND cr.ref_id = p_ref_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'content_reference_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF reference_row.tombstoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001',
      DETAIL = 'tombstoned';
  END IF;
  IF reference_row.writer_kind <> 'runtime_child' THEN
    RAISE EXCEPTION 'content_reference_writer_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  IF reference_row.slot_state = 'committed' THEN
    IF reference_row.content_ref = p_content_ref
       AND reference_row.content_hash = p_content_hash
       AND reference_row.bytes = p_bytes THEN
      PERFORM work.append_audit(
        p_org_id, NULL, 'content.reference_committed', 'content_reference',
        p_ref_id::text,
        jsonb_build_object(
          'outcome', 'idempotent', 'kind', reference_row.kind,
          'logical_slot', reference_row.logical_slot,
          'execution_id', reference_row.execution_id
        )
      );
      RETURN jsonb_build_object(
        'outcome', 'idempotent', 'ref_id', p_ref_id,
        'slot_state', 'committed'
      );
    END IF;
    RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001';
  END IF;

  -- The reservation is only valid while the execution still binds the same
  -- tenant/task/run. A terminal execution may still finish an in-flight
  -- candidate commit; head promotion is a separate command.
  SELECT e.task_id, e.run_id
    INTO v_task_id, v_run_id
  FROM work.runtime_execution e
  WHERE e.execution_id = reference_row.execution_id AND e.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_task_id IS DISTINCT FROM reference_row.task_id
     OR v_run_id IS DISTINCT FROM reference_row.run_id THEN
    RAISE EXCEPTION 'content_reference_binding_mismatch' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.content_reference
  SET content_ref = p_content_ref,
      content_hash = p_content_hash,
      bytes = p_bytes,
      slot_state = 'committed',
      updated_at = now()
  WHERE org_id = p_org_id
    AND ref_id = p_ref_id
    AND slot_state = 'reserved'
    AND tombstoned_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE = 'P0001';
  END IF;

  PERFORM work.append_audit(
    p_org_id, NULL, 'content.reference_committed', 'content_reference',
    p_ref_id::text,
    jsonb_build_object(
      'outcome', 'committed', 'kind', reference_row.kind,
      'logical_slot', reference_row.logical_slot,
      'execution_id', reference_row.execution_id
    )
  );
  RETURN jsonb_build_object(
    'outcome', 'committed', 'ref_id', p_ref_id, 'slot_state', 'committed'
  );
END;
$$;

-- Resolve replacement: a reserved candidate is not a fact. Only committed,
-- non-tombstoned rows may authorise a read. Same signature as 0011.
CREATE OR REPLACE FUNCTION work.resolve_content_reference(
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
  WHERE cr.org_id = p_org_id
    AND cr.ref_id = p_ref_id
    AND cr.slot_state = 'committed';
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
    'writer_kind', reference_row.writer_kind,
    'slot_state', reference_row.slot_state
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: work_worker only. No table-level DML for anyone; no EXECUTE for
-- work_api/work_directory. Reserved rows are not readable through resolve.
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE work.content_reference FROM PUBLIC;
REVOKE ALL ON TABLE work.content_reference FROM work_api, work_worker,
  work_directory, work_ledger, work_ops;

REVOKE ALL ON FUNCTION work.reserve_content_slot(
  text, uuid, uuid, text, text
) FROM PUBLIC, work_api, work_directory, work_ledger, work_ops;
REVOKE ALL ON FUNCTION work.commit_content_slot(
  text, uuid, text, text, bigint
) FROM PUBLIC, work_api, work_directory, work_ledger, work_ops;
REVOKE ALL ON FUNCTION work.resolve_content_reference(text, uuid)
  FROM PUBLIC, work_api, work_directory, work_ledger, work_ops;
REVOKE ALL ON FUNCTION work.register_content_reference(
  text, uuid, uuid, uuid, uuid, text, text, text, text, text, bigint, text
) FROM PUBLIC, work_api, work_directory, work_ledger, work_ops;
REVOKE ALL ON FUNCTION work.tombstone_content_reference(text, uuid, text)
  FROM PUBLIC, work_api, work_directory, work_ledger, work_ops;

GRANT EXECUTE ON FUNCTION work.reserve_content_slot(
  text, uuid, uuid, text, text
) TO work_worker;
GRANT EXECUTE ON FUNCTION work.commit_content_slot(
  text, uuid, text, text, bigint
) TO work_worker;
GRANT EXECUTE ON FUNCTION work.resolve_content_reference(text, uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.register_content_reference(
  text, uuid, uuid, uuid, uuid, text, text, text, text, text, bigint, text
) TO work_worker;
GRANT EXECUTE ON FUNCTION work.tombstone_content_reference(text, uuid, text) TO work_worker;

RESET ROLE;
