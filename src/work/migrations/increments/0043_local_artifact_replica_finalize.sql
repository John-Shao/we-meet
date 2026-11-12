-- 0043: the local artifact replica, the artifact classification floor (B), the two
--       local publish paths, and the nonce consumption rebind_run_workspace owed.
--
-- Authority: work-r0b-m1a-device-migration-design-2026-11-12.md §17 (batch four),
-- which is the shape deliverable for §9's batch-four row and the fourth and last
-- member of the O-12 = jia set (19/19 shapes delivered). Control design §7.1 (both
-- publish paths and their thresholds), §4.1's artifact_replica row (E=B: only the
-- location=local branch survives this round), §4.2 tenth round R10A-1 ((A) and (B)
-- share the comparator and never the input set), §9 rows for content_on_original_device
-- and local_proof_expired. Device design §7.1 steps 1-5 and §7.5.
--
-- Four rulings, all by the sole signatory on 2026-11-12 and recorded in §17.1:
--   O-7  = jia: artifact_replica.state is the single value 'published'. No pending or
--          failed state is invented, because finalize is the only writer and it inserts
--          inside the publish transaction. Restoring the cloud branch later needs a new
--          increment that DROPs and re-ADDs both CHECKs - a CHECK cannot be
--          CREATE OR REPLACE'd, which is how 0042 handled operation_supersede_reason_check.
--   O-8  = jia: work_run_classification is NOT created here. Neither its writer nor its
--          reader is in M1a (it belongs to the R0a provider-probe line), and a table that
--          registers with no workload-reachable writer is exactly what
--          function_privilege_sweep_pg_test.go:147 exists to refuse.
--   O-17 = yi: a general one-shot nonce table, work.consumed_possession_nonce, and a
--          restatement of rebind_run_workspace that consumes the proof nonce. Both values
--          of its purpose closed set have a writer inside this increment, so neither is
--          an orphan state. The restatement changes nothing else about that command.
--   O-18 = bing: finalize gates on THIS Run's blocking operations only, reusing batch
--          three's predicate and its refusal code run_has_unreconciled_operation. No
--          task-level gate, and no new refusal code for the quiescence half.
--
-- Two existing objects are touched rather than only added to:
--   O-17: rebind_run_workspace, restated verbatim from 0041 plus the consumption block.
--   §17.8: the error catalogue gains one public code (local_proof_expired, control §9's
--          row copied field by field) with its Chinese copy, and four db_exception_map
--          entries. Nothing is registered that no body raises - input_limit_exceeded
--          stays out, per §9's own "register it when the first endpoint returns it".
--
-- Signature verification stays in the Go/gateway layer exactly as 0021/0040/0041/0042 do:
-- plpgsql cannot verify ES256, so these bodies format-check, bind proof to scalars, and
-- enforce single use through the nonce table.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- O-17 = yi: the single-use nonce carrier for possession proofs.
--
-- §12.12 step 4 has always said "验签＋原子消费 nonce", and 0041's shipped rebind only
-- checked that the nonce was PRESENT and copied it into the audit metadata. There was no
-- column and no table anywhere that could hold it, so a rebind replayed under a fresh
-- client_request_id was accepted. approval_decision.nonce (0042) is the same trick in one
-- domain only; three signature frames share this one, so the carrier is its own table.
--
-- Primary key is (org_id, nonce), NOT (org_id, purpose, nonce): single use is decided per
-- organization, the same shape as work_approval_decision_nonce_once. purpose is evidence
-- and alerting only. The cost of that choice is written down: one random nonce used once
-- in each of two signature frames is refused on the second use. That is wanted behaviour,
-- and "不复用其他签名域" (control §1.2) is carried by purpose plus two separate verify
-- frames, not by the key.
--
-- There is deliberately no shape CHECK on nonce. 0041 only required it to be non-null, so
-- adding ^[A-Za-z0-9_-]{8,128}$ here would refuse a rebind that succeeds today, which is
-- a behaviour change O-17 did not authorise - it authorised consuming, not tightening.
-- M1b owns the joint change: define the shape once, then change rebind and the user path
-- in the same increment.
-- ---------------------------------------------------------------------------
CREATE TABLE work.consumed_possession_nonce (
  org_id text NOT NULL,
  purpose text NOT NULL,
  nonce text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, nonce),
  CONSTRAINT consumed_possession_nonce_purpose_check
    CHECK (purpose IN ('user_version', 'workspace_rebind')),
  CONSTRAINT consumed_possession_nonce_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.consumed_possession_nonce ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.consumed_possession_nonce FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.consumed_possession_nonce
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Append-only, and never swept: deleting a consumed nonce is the same as allowing that
-- nonce to be replayed. This is why §17.10's "retention does not clean these two tables"
-- is a rule rather than an omission.
CREATE TRIGGER consumed_possession_nonce_append_only
  BEFORE UPDATE OR DELETE ON work.consumed_possession_nonce
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

-- ---------------------------------------------------------------------------
-- artifact_replica, the local branch only (§5.E2, control §4.1 with E=B).
--
-- Columns, names and order are copied from §5.E2: no rename, no addition, no removal.
-- The two closed sets each hold one value this round - location because the cloud branch
-- moved out with the sync chain (finalize_cloud_replica is not in M1a), state per O-7.
--
-- hash/bytes rather than content_hash/format because that is what control §4.1's row
-- says. The version table spells them content_hash/bytes/media_type (0002:399-401), so
-- the guard below must map the names and must not assume they match.
-- ---------------------------------------------------------------------------
CREATE TABLE work.artifact_replica (
  org_id text NOT NULL,
  version_id uuid NOT NULL,
  location text NOT NULL,
  replica_id uuid NOT NULL DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  content_ref text,
  local_ref text NOT NULL,
  hash text NOT NULL,
  bytes bigint NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, version_id, location, replica_id),
  CONSTRAINT artifact_replica_location_check CHECK (location IN ('local')),
  CONSTRAINT artifact_replica_state_check CHECK (state IN ('published')),
  CONSTRAINT artifact_replica_hash_shape CHECK (hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT artifact_replica_bytes_nonneg CHECK (bytes >= 0),
  CONSTRAINT artifact_replica_local_ref_shape CHECK (local_ref <> ''),
  -- §5.E2's implication form, kept as an implication even though location can only be
  -- 'local' today: widening that closed set with the cloud branch must not silently turn
  -- this into a condition that only ever describes local rows.
  CONSTRAINT artifact_replica_local_shape CHECK (
    location <> 'local'
    OR (content_ref IS NULL AND local_ref IS NOT NULL AND device_id IS NOT NULL)
  ),
  -- The version edge points at version_id, not at an id column: work.artifact_version
  -- has no id, its primary key is (artifact_id, version_no) (0002:406), and version_id is
  -- the 0017:151 column whose uniqueness comes from work_artifact_version_version_id
  -- (0017:216-217). That index already exists, so no new key is needed here, and the
  -- reversed column order against a unique index is the shape 15 landed FKs already use
  -- against work.device's (org_id, id) primary key.
  CONSTRAINT artifact_replica_version_fkey
    FOREIGN KEY (version_id, org_id) REFERENCES work.artifact_version(version_id, org_id),
  CONSTRAINT artifact_replica_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT artifact_replica_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.artifact_replica ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.artifact_replica FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.artifact_replica
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- "版本hash/bytes与原版一致，不能换内容" (§4.1) is the reason this table exists, so the
-- consistency check is not optional. It reads the version row rather than trusting the
-- caller: a replica row that does not describe the version it points at is a false record
-- about bytes the server never saw.
--
-- No SECURITY DEFINER: this fires inside finalize_local_artifact's own definer context,
-- the same arrangement as workspace_grant_succession_same_root (0040:762), which also
-- reads another table from a trigger. Adding a definer here would create a second path
-- around the table grants for no extra check.
CREATE FUNCTION work.artifact_replica_matches_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_version work.artifact_version%ROWTYPE;
BEGIN
  SELECT * INTO v_version FROM work.artifact_version
    WHERE org_id = NEW.org_id AND version_id = NEW.version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NEW.hash IS DISTINCT FROM v_version.content_hash
     OR NEW.bytes IS DISTINCT FROM v_version.bytes THEN
    RAISE EXCEPTION 'artifact_replica_content_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER artifact_replica_matches_version
  BEFORE INSERT ON work.artifact_replica
  FOR EACH ROW EXECUTE FUNCTION work.artifact_replica_matches_version();

CREATE TRIGGER artifact_replica_append_only
  BEFORE UPDATE OR DELETE ON work.artifact_replica
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

-- ---------------------------------------------------------------------------
-- Validators. Both are called from inside definer bodies only, so both are revoked from
-- PUBLIC and granted to nobody, exactly like the seven helpers in 0042.
--
-- plpgsql rather than sql because the value shapes need casts, and a cast that throws has
-- to become false rather than an error - the same reason binding_grant_set_valid (0040:97)
-- is written this way.
-- ---------------------------------------------------------------------------

-- §6.6's ten keys, verbatim. No content_ref: the bytes never leave the device.
--
-- classification_claimed is only checked to be a non-empty string here. Whether it is in
-- the closed set is what classification_unknown exists to refuse, and refusing it with
-- invalid_request instead would take away the one branch §17.4 gives that code.
--
-- receipt_ref is 'journal_epoch:seq' - see O-20 in §10. That is the device_receipt primary
-- key the device itself already holds (it sends receipt_seq and owns journal_epoch), so no
-- new cross-side hash formula is invented.
CREATE FUNCTION work.local_artifact_version_payload_valid(p_version jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_uuid uuid;
  v_bigint bigint;
BEGIN
  IF p_version IS NULL OR jsonb_typeof(p_version) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_version)) <> 10
     OR NOT p_version ?& ARRAY['version_id', 'artifact_id', 'logical_name', 'format',
       'content_hash', 'byte_count', 'local_ref', 'device_id', 'classification_claimed',
       'receipt_ref']::text[] THEN
    RETURN false;
  END IF;
  IF p_version ->> 'logical_name' IS NULL OR p_version ->> 'logical_name' = ''
     OR p_version ->> 'format' IS NULL OR p_version ->> 'format' = ''
     OR p_version ->> 'local_ref' IS NULL OR p_version ->> 'local_ref' = ''
     OR p_version ->> 'classification_claimed' IS NULL
     OR p_version ->> 'classification_claimed' = ''
     OR COALESCE(p_version ->> 'content_hash', '') !~ '^[0-9a-f]{64}$'
     OR p_version ->> 'receipt_ref'
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]*$'
     -- artifact_id is the only optional-valued key: JSON null means "merge by
     -- logical_name" and a uuid string is §17.5 step 8's target branch, so the refusal has
     -- to be about the JSON type. Presence-based tests cannot work here - `(->>) IS NOT
     -- NULL AND (->) IS NOT NULL` is true for every uuid string, which would make the
     -- target branch unreachable and refuse calls the shape accepts. A malformed string
     -- still fails, on the cast below.
     OR ((p_version ->> 'artifact_id') IS NOT NULL
         AND jsonb_typeof(p_version -> 'artifact_id') <> 'string') THEN
    RETURN false;
  END IF;
  BEGIN
    v_uuid := (p_version ->> 'version_id')::uuid;
    v_uuid := (p_version ->> 'device_id')::uuid;
    IF (p_version ->> 'artifact_id') IS NOT NULL THEN
      v_uuid := (p_version ->> 'artifact_id')::uuid;
    END IF;
    v_bigint := (p_version ->> 'byte_count')::bigint;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF v_uuid IS NULL OR v_bigint IS NULL OR v_bigint < 0 THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- UserVersionProof: the 21 keys of control §1.2:31 copied literally, and nothing else.
--
-- Two things this deliberately does NOT do.
--   * No 'signature' key. That frame is signed in the HTTP header, so a signature inside
--     the payload would be a 22nd key the closed set does not have. The 20-key
--     ApprovalDecisionProof helper (0042:600) does include one - copying that shape here
--     would break this contract.
--   * No value check on 'v' beyond presence, because no shipped command checks it
--     (0040/0041/0042 all leave the frame version to the caller).
--
-- clipboard_source_version_ids may be an empty array; it must still be an array of uuid
-- strings, and each element has to be individually parseable, so that the source-version
-- lookup in the save path is total.
CREATE FUNCTION work.user_version_proof_valid(p_proof jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  elem text;
  v_uuid uuid;
  v_ts timestamptz;
  v_bigint bigint;
  v_int int;
BEGIN
  IF p_proof IS NULL OR jsonb_typeof(p_proof) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_proof)) <> 21
     OR NOT p_proof ?& ARRAY[
       'v', 'org_id', 'subject_id', 'auth_plane', 'auth_epoch', 'device_id', 'session_id',
       'task_id', 'artifact_id', 'base_version_no', 'base_hash', 'version_id', 'format',
       'content_hash', 'bytes', 'classification', 'clipboard_derived',
       'clipboard_source_version_ids', 'client_request_id', 'nonce', 'expires_at']::text[]
     OR COALESCE(p_proof ->> 'content_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_proof ->> 'base_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_proof ->> 'nonce', '') !~ '^[A-Za-z0-9_-]{8,128}$'
     OR p_proof ->> 'format' IS NULL OR p_proof ->> 'format' = ''
     OR p_proof ->> 'classification' IS NULL OR p_proof ->> 'classification' = ''
     OR jsonb_typeof(p_proof -> 'clipboard_source_version_ids') <> 'array'
     OR jsonb_typeof(p_proof -> 'clipboard_derived') <> 'boolean'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p_proof -> 'clipboard_source_version_ids') e
       WHERE e !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RETURN false;
  END IF;
  BEGIN
    v_uuid := (p_proof ->> 'device_id')::uuid;
    v_uuid := (p_proof ->> 'session_id')::uuid;
    v_uuid := (p_proof ->> 'task_id')::uuid;
    v_uuid := (p_proof ->> 'artifact_id')::uuid;
    v_uuid := (p_proof ->> 'version_id')::uuid;
    v_int := (p_proof ->> 'base_version_no')::int;
    v_bigint := (p_proof ->> 'auth_epoch')::bigint;
    v_bigint := (p_proof ->> 'bytes')::bigint;
    v_ts := (p_proof ->> 'expires_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF v_uuid IS NULL OR v_ts IS NULL OR v_int IS NULL OR v_int < 1
     OR v_bigint IS NULL OR v_bigint < 0 THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- finalize_local_artifact (control §7.1 first sentence + §4.2; design §6.6, §17.5).
--
-- Judgment order is the signed one and is not rearranged: org context, payload, task/run
-- lock, run state, operation, receipt binding, this-Run blocking gate, (B) derivation and
-- cross-check, target artifact, idempotency, then the write set.
--
-- Two boundaries this body keeps because the signed text keeps them:
--   * no device_receipt.state / .outcome gate and no output byte limit (§17.10 item 6).
--     Neither appears in §6.6 or §4.2, and adding one would refuse calls the design
--     accepts on a judgment nobody ruled.
--   * (B) is not (A). The input sets differ on purpose - (B) is the whole Run with no
--     action_kind filter and reads succession structurally - and control §4.2 tenth round
--     R10A-1 says explicitly that the two must not be merged into one derivation function.
--     Only work.classification_rank is shared.
--
-- version_no is computed server-side (MAX + 1, exactly publish_artifact's shape), so
-- version_conflict has no reachable branch here. §6.6 keeps that name for the user save
-- path, where R0a already uses it; the mapping entry stays.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.finalize_local_artifact(
  p_org_id text,
  p_run_id uuid,
  p_operation_id uuid,
  p_version jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_task work.task%ROWTYPE;
  v_run work.run%ROWTYPE;
  v_operation work.operation%ROWTYPE;
  v_receipt work.device_receipt%ROWTYPE;
  v_artifact work.artifact%ROWTYPE;
  v_existing work.artifact_version%ROWTYPE;
  v_inputs jsonb;
  v_derivation jsonb;
  v_task_id uuid;
  v_artifact_id uuid;
  v_version_id uuid;
  v_logical_name text;
  v_format text;
  v_content_hash text;
  v_bytes bigint;
  v_local_ref text;
  v_device_id uuid;
  v_receipt_ref text;
  v_claimed text;
  v_output_root text;
  v_result text;
  v_epoch uuid;
  v_seq bigint;
  v_next_no int;
  v_publish_ack text;
  v_artifact_found boolean;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF NOT work.local_artifact_version_payload_valid(p_version) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_version_id := (p_version ->> 'version_id')::uuid;
  v_logical_name := p_version ->> 'logical_name';
  v_format := p_version ->> 'format';
  v_content_hash := p_version ->> 'content_hash';
  v_bytes := (p_version ->> 'byte_count')::bigint;
  v_local_ref := p_version ->> 'local_ref';
  v_device_id := (p_version ->> 'device_id')::uuid;
  v_receipt_ref := p_version ->> 'receipt_ref';
  v_claimed := p_version ->> 'classification_claimed';
  IF (p_version ->> 'artifact_id') IS NOT NULL THEN
    v_artifact_id := (p_version ->> 'artifact_id')::uuid;
  END IF;

  -- Lock order per publish_artifact (0002:1677-1686) and control §4.3: Task and Run in one
  -- statement, Operation next, then the artifact.
  SELECT t.id INTO v_task_id
  FROM work.task t
  JOIN work.run r ON r.task_id = t.id AND r.org_id = t.org_id
  WHERE r.id = p_run_id AND r.org_id = p_org_id AND t.deleted_at IS NULL
  FOR UPDATE OF t, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task WHERE id = v_task_id AND org_id = p_org_id;
  SELECT * INTO v_run FROM work.run WHERE id = p_run_id AND org_id = p_org_id;

  IF v_run.state NOT IN ('active', 'waiting') THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_operation FROM work.operation
    WHERE org_id = p_org_id AND id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Receipt binding. receipt_ref is 'journal_epoch:seq', which is the device_receipt
  -- primary key without its device component; the operation filter supplies that, and
  -- work_device_receipt_operation (org_id, operation_id, seq) covers the lookup.
  v_epoch := split_part(v_receipt_ref, ':', 1)::uuid;
  v_seq := split_part(v_receipt_ref, ':', 2)::bigint;
  SELECT * INTO v_receipt FROM work.device_receipt
    WHERE org_id = p_org_id AND operation_id = p_operation_id
      AND journal_epoch = v_epoch AND seq = v_seq;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_receipt.local_result_ref IS NOT NULL AND v_receipt.local_result_ref <> v_local_ref THEN
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
  END IF;
  IF v_receipt.device_id IS DISTINCT FROM v_device_id THEN
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
  END IF;

  -- Invariant 3 for THIS Run (O-18 = bing): the same predicate and the same code as
  -- 0042's two enforcement points. task_has_blocking_operation is deliberately not
  -- consulted here - control §6.4 item 4 keeps that Task-level gate for new-Run admission
  -- and the acceptance threshold only.
  IF EXISTS (
    SELECT 1 FROM work.operation o
    WHERE o.org_id = p_org_id AND o.run_id = p_run_id
      AND o.state IN ('unknown', 'unresolved')
  ) THEN
    RAISE EXCEPTION 'run_has_unreconciled_operation' USING ERRCODE = 'P0001';
  END IF;

  -- (B): every local_action row of the Run with no action_kind filter (the classification
  -- column is the snapshot prepare wrote, so a grant that has since changed or lapsed
  -- cannot launder content that was already read), plus every succession new grant - which
  -- has no local_action row until the next action appears - plus the output root.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'grant_id', i.grant_id, 'grant_revision', i.grant_revision,
           'classification', i.classification, 'source', i.source)
         ORDER BY i.source, i.grant_id::text), '[]'::jsonb)
    INTO v_inputs
  FROM (
    SELECT la.grant_id, la.grant_revision, la.classification, 'action'::text AS source
    FROM work.local_action la
    JOIN work.operation o ON o.id = la.operation_id AND o.org_id = la.org_id
    WHERE la.org_id = p_org_id AND o.run_id = p_run_id
    UNION ALL
    SELECT gs.new_grant_id, g.grant_revision, g.classification, 'succession'::text
    FROM work.workspace_grant_succession gs
    JOIN work.workspace_grant g ON g.id = gs.new_grant_id AND g.org_id = gs.org_id
    WHERE gs.org_id = p_org_id AND gs.run_id = p_run_id
    UNION ALL
    SELECT ra.grant_id, ra.grant_revision, ra.classification, 'output_root'::text
    FROM work.local_action ra
    WHERE ra.org_id = p_org_id AND ra.operation_id = p_operation_id
      AND ra.action_kind = 'artifact.write'
  ) i;

  -- An artifact.write operation with retries has one local_action row per attempt; the
  -- root reported for evidence is the latest attempt. The derivation is unaffected, since
  -- the first UNION arm already covers every attempt of the Run.
  SELECT (e ->> 'classification') INTO v_output_root
  FROM jsonb_array_elements(v_inputs) e
  WHERE e ->> 'source' = 'output_root'
  ORDER BY e ->> 'grant_revision' DESC, e ->> 'grant_id' DESC LIMIT 1;

  -- classification_unknown's only branch (§17.4): a value outside the closed set, from
  -- either side. Checking it here is also what makes the DESC below safe - past this
  -- point rank is never NULL, so a non-classification can never sort to the top.
  IF v_claimed NOT IN ('local_only', 'remote_excerpt_allowed')
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_inputs) e
       WHERE e ->> 'classification' NOT IN ('local_only', 'remote_excerpt_allowed')) THEN
    RAISE EXCEPTION 'classification_unknown' USING ERRCODE = 'P0001';
  END IF;

  -- An empty input set means local_only, which is a floor rather than a guess: nothing in
  -- the Run is evidence that this content may leave the device, and J19's default is
  -- local_only anyway.
  SELECT COALESCE((array_agg(e ->> 'classification'
           ORDER BY work.classification_rank(e ->> 'classification') DESC))[1], 'local_only')
    INTO v_result
  FROM jsonb_array_elements(v_inputs) e;

  IF work.classification_rank(v_claimed) < work.classification_rank(v_result) THEN
    -- Only the refusal is landed. §17.4 also asks for an artifact_classification_floor
    -- audit row here, but an audit insert in this transaction is rolled back by the raise
    -- in the next statement, so writing one would claim evidence that never reaches the
    -- table. The success path below is the only persisted classification_derivation, and
    -- §17.10 records the asymmetry.
    RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
  END IF;

  v_derivation := jsonb_build_object(
    'inputs', v_inputs,
    'output_root_classification', v_output_root,
    'result', v_result);

  -- Target artifact. An explicit id must belong to this Task and carry this logical_name;
  -- without one, merge by logical_name exactly like publish_artifact. A missing artifact
  -- gets its draft row only after the idempotency checks below have passed, because an
  -- insert before an early return would leave an artifact with no versions behind it.
  IF v_artifact_id IS NOT NULL THEN
    SELECT * INTO v_artifact FROM work.artifact
      WHERE org_id = p_org_id AND id = v_artifact_id AND task_id = v_task_id
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF v_artifact.logical_name <> v_logical_name THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    v_artifact_found := true;
  ELSE
    SELECT * INTO v_artifact FROM work.artifact
      WHERE org_id = p_org_id AND task_id = v_task_id AND logical_name = v_logical_name
      FOR UPDATE;
    v_artifact_found := FOUND;
    IF v_artifact_found THEN
      v_artifact_id := v_artifact.id;
    ELSE
      v_artifact_id := gen_random_uuid();
    END IF;
  END IF;
  IF v_artifact_found AND v_artifact.state = 'deleted' THEN
    RAISE EXCEPTION 'artifact_deleted' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotency per publish_artifact (0002:1697-1700): same artifact, same hash, same
  -- source Run. The container of version_no is the artifact, so the same bytes written
  -- under two logical_names of one Run get two versions (§17.10 item 7).
  IF v_artifact_found THEN
    SELECT av.* INTO v_existing FROM work.artifact_version av
      WHERE av.artifact_id = v_artifact_id AND av.org_id = p_org_id
        AND av.content_hash = v_content_hash
        AND av.provenance ->> 'run_id' = p_run_id::text
      ORDER BY av.version_no DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'version_id', v_existing.version_id, 'artifact_id', v_artifact_id,
        'version_no', v_existing.version_no, 'location', v_existing.location,
        'classification', v_existing.classification,
        'classification_derivation', v_derivation,
        'hash', v_existing.content_hash, 'bytes', v_existing.bytes,
        'format', v_existing.media_type, 'local_ref', v_existing.local_ref,
        'publish_ack', 'sha256:' || work.sha256_text('local_publish_ack|'
          || v_existing.version_id::text || '|' || v_existing.content_hash),
        'replayed', true);
    END IF;
  END IF;

  -- version_id is the caller's own identity for the version, so occupying it with other
  -- content is a conflict rather than a new version. work_artifact_version_version_id is
  -- the unique index that backs this check too.
  IF EXISTS (SELECT 1 FROM work.artifact_version
             WHERE org_id = p_org_id AND version_id = v_version_id) THEN
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(av.version_no), 0) + 1 INTO v_next_no FROM work.artifact_version av
    WHERE av.artifact_id = v_artifact_id AND av.org_id = p_org_id;

  IF NOT v_artifact_found THEN
    INSERT INTO work.artifact (id, org_id, task_id, logical_name, state)
      VALUES (v_artifact_id, p_org_id, v_task_id, v_logical_name, 'draft');
  END IF;

  -- content_ref stays NULL and location is local_only: the bytes never left the device,
  -- and artifact_version_location_shape refuses any other combination. classification
  -- carries the (B) result, not the claimed value.
  INSERT INTO work.artifact_version
    (artifact_id, org_id, version_no, content_hash, bytes, media_type, state, provenance,
     published_at, version_id, location, local_ref, device_id, classification)
  VALUES
    (v_artifact_id, p_org_id, v_next_no, v_content_hash, v_bytes, v_format, 'published',
     jsonb_build_object('source', 'run', 'run_id', p_run_id,
                        'operation_id', p_operation_id),
     now(), v_version_id, 'local_only', v_local_ref, v_device_id, v_result);

  -- The replica row is what makes the version readable on the original device, and
  -- artifact_replica_matches_version refuses here if the hash or byte count handed to the
  -- replica differs from the version row written one statement earlier.
  INSERT INTO work.artifact_replica
    (org_id, version_id, location, device_id, local_ref, hash, bytes, state)
  VALUES
    (p_org_id, v_version_id, 'local', v_device_id, v_local_ref, v_content_hash, v_bytes,
     'published');

  UPDATE work.artifact a
    SET state = 'published', revision = a.revision + 1, updated_at = now()
    WHERE a.id = v_artifact_id AND a.org_id = p_org_id;
  UPDATE work.task t
    SET revision = t.revision + 1, updated_at = now()
    WHERE t.id = v_task_id AND t.org_id = p_org_id;

  -- append_task_event writes the outbox row itself (0002:1346), so no new outbox kind.
  PERFORM work.append_task_event(
    p_org_id, v_task_id, 'artifact.published',
    jsonb_build_object(
      'artifact_id', v_artifact_id, 'version_no', v_next_no, 'version_id', v_version_id,
      'source', 'run', 'run_id', p_run_id, 'operation_id', p_operation_id,
      'location', 'local_only', 'content_hash', v_content_hash, 'bytes', v_bytes,
      'media_type', v_format, 'classification', v_result));

  PERFORM work.append_audit(
    p_org_id, NULL, 'artifact.local_finalize', 'artifact', v_artifact_id::text,
    jsonb_build_object(
      'run_id', p_run_id, 'operation_id', p_operation_id, 'version_id', v_version_id,
      'version_no', v_next_no, 'receipt_ref', v_receipt_ref,
      'request_digest', work.sha256_text(p_version::text),
      'classification_derivation', v_derivation));

  -- Temporary ack formula, same caliber as 0042's server_signature (0042:2097). ES256 and
  -- the Bearer plane are M1b/I4 (§17.10 item 9).
  v_publish_ack := 'sha256:' || work.sha256_text('local_publish_ack|'
    || v_version_id::text || '|' || v_content_hash);

  RETURN jsonb_build_object(
    'version_id', v_version_id, 'artifact_id', v_artifact_id, 'version_no', v_next_no,
    'location', 'local_only', 'classification', v_result,
    'classification_derivation', v_derivation,
    'hash', v_content_hash, 'bytes', v_bytes, 'format', v_format,
    'local_ref', v_local_ref, 'publish_ack', v_publish_ack, 'replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- create_local_user_artifact_version (control §7.1 four steps; design §17.6).
--
-- The order below is the signed order, including the two parts of it that are easy to
-- lose: the dedupe probe runs BEFORE any proof judgment - so a replay of the same
-- client_request_id neither re-checks expiry nor consumes the nonce a second time - and
-- the nonce is consumed before any business write, so a call that later refuses cannot
-- leave a spent nonce behind (the rollback takes it with it).
--
-- Division of labor kept as it is in 0040/0041/0042: access_restriction and organization
-- suspension are not evaluated here. All twenty-one shipped commands leave those to the
-- API/Host layer; this increment does not start a third arrangement.
--
-- local_ref has no place inside the signed frame - the UserVersionProof's 21 keys were
-- read one by one - so it arrives as an unsigned scalar (O-19) and is folded into the
-- request hash, which means moving the pointer changes the dedupe identity instead of
-- silently re-pointing a stored version. The server cannot verify it refers to a real
-- file; that asymmetry is recorded in §10 and is not dressed up as verification.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.create_local_user_artifact_version(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_device_id uuid,
  p_session_id uuid,
  p_artifact_id uuid,
  p_client_request_id text,
  p_local_ref text,
  p_proof jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_task work.task%ROWTYPE;
  v_artifact work.artifact%ROWTYPE;
  v_base work.artifact_version%ROWTYPE;
  v_version work.artifact_version%ROWTYPE;
  v_dedup work.submission_dedup%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_clip jsonb;
  v_task_id uuid;
  v_version_id uuid;
  v_base_no int;
  v_base_hash text;
  v_content_hash text;
  v_format text;
  v_bytes bigint;
  v_classification text;
  v_nonce text;
  v_request_hash text;
  v_gate text;
  v_limit bigint;
  v_missing bigint;
  v_floor integer;
  v_next_no int;
  v_publish_ack text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF p_auth_plane IS DISTINCT FROM 'bearer' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- client_request_id shape is not re-checked here: work.lock_request_key below is the
  -- shipped owner of that range and raises invalid_client_request_id itself.
  IF NOT work.user_version_proof_valid(p_proof)
     OR p_artifact_id IS NULL
     OR p_local_ref IS NULL OR p_local_ref = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_version_id := (p_proof ->> 'version_id')::uuid;
  v_base_no := (p_proof ->> 'base_version_no')::int;
  v_base_hash := p_proof ->> 'base_hash';
  v_content_hash := p_proof ->> 'content_hash';
  v_format := p_proof ->> 'format';
  v_bytes := (p_proof ->> 'bytes')::bigint;
  v_classification := p_proof ->> 'classification';
  v_clip := p_proof -> 'clipboard_source_version_ids';
  v_nonce := p_proof ->> 'nonce';

  -- §7.1's tuple is fixed as (org, subject, 'artifact.version', client_request_id) - the
  -- same operation_type as the R0a cloud save, not a new '.local' domain.
  PERFORM work.lock_request_key(p_org_id, p_actor_subject_id, 'artifact.version',
    p_client_request_id);
  -- §17.6 writes this as COALESCE(p_local_ref, ''); the empty local_ref is already
  -- refused above, so the COALESCE would be unreachable.
  v_request_hash := work.sha256_text('artifact.version.local|' || p_artifact_id::text
    || '|' || v_base_no::text || '|' || v_content_hash || '|' || p_local_ref
    || '|' || p_proof::text);
  SELECT * INTO v_dedup FROM work.submission_dedup
    WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
      AND operation_type = 'artifact.version' AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_dedup.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_version FROM work.artifact_version
      WHERE org_id = p_org_id AND version_id = v_dedup.result_ref::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
    END IF;
    RETURN jsonb_build_object(
      'version_id', v_version.version_id, 'artifact_id', v_version.artifact_id,
      'version_no', v_version.version_no, 'location', v_version.location,
      'classification', v_version.classification, 'hash', v_version.content_hash,
      'bytes', v_version.bytes, 'format', v_version.media_type,
      'local_ref', v_version.local_ref,
      'publish_ack', 'sha256:' || work.sha256_text('local_publish_ack|'
        || v_version.version_id::text || '|' || v_version.content_hash),
      'replayed', true);
  END IF;

  -- Every scalar the caller sent must equal the signed copy inside the proof. task_id has
  -- no HTTP scalar counterpart, so it is compared against the Task this artifact belongs
  -- to a few statements later - the only server fact it can be checked against.
  IF p_proof ->> 'org_id' IS DISTINCT FROM p_org_id
     OR p_proof ->> 'subject_id' IS DISTINCT FROM p_actor_subject_id
     OR p_proof ->> 'auth_plane' IS DISTINCT FROM p_auth_plane
     OR (p_proof ->> 'auth_epoch')::bigint IS DISTINCT FROM p_auth_epoch
     OR (p_proof ->> 'device_id')::uuid IS DISTINCT FROM p_device_id
     OR (p_proof ->> 'session_id')::uuid IS DISTINCT FROM p_session_id
     OR (p_proof ->> 'artifact_id')::uuid IS DISTINCT FROM p_artifact_id
     OR p_proof ->> 'client_request_id' IS DISTINCT FROM p_client_request_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id;
  IF NOT FOUND OR v_device.owner_subject_id <> p_actor_subject_id
     OR v_device.status <> 'active' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id;
  IF NOT FOUND OR v_session.state <> 'active' OR v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_session.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM p_auth_epoch
     OR v_session.device_id IS DISTINCT FROM p_device_id
     OR v_session.owner_subject_id IS DISTINCT FROM p_actor_subject_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id AND m.subject_id = p_actor_subject_id
      AND m.status = 'active' AND m.role <> 'viewer') THEN
    RAISE EXCEPTION 'work_seat_required' USING ERRCODE = 'P0001';
  END IF;

  IF (p_proof ->> 'expires_at')::timestamptz <= now() THEN
    RAISE EXCEPTION 'local_proof_expired' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM work.consumed_possession_nonce
             WHERE org_id = p_org_id AND nonce = v_nonce) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO work.consumed_possession_nonce (org_id, purpose, nonce)
    VALUES (p_org_id, 'user_version', v_nonce);

  -- Lock order per create_user_artifact_version (0002:3703-3712): Task, then artifact.
  SELECT a.task_id INTO v_task_id FROM work.artifact a
    WHERE a.id = p_artifact_id AND a.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task t
    WHERE t.id = v_task_id AND t.org_id = p_org_id AND t.deleted_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_artifact FROM work.artifact a
    WHERE a.id = p_artifact_id AND a.org_id = p_org_id AND a.deleted_at IS NULL
    FOR UPDATE;
  IF NOT FOUND OR v_task.owner_subject_id <> p_actor_subject_id THEN
    RAISE EXCEPTION 'artifact_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF (p_proof ->> 'task_id')::uuid IS DISTINCT FROM v_task_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_task.state NOT IN ('open', 'awaiting_acceptance') THEN
    RAISE EXCEPTION 'artifact_read_only' USING ERRCODE = 'P0001';
  END IF;
  IF v_task.active_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = 'P0001';
  END IF;

  -- The base is the latest published version of this artifact, and proof.base_version_no
  -- has to name it. A UserVersionProof always carries base_version_no >= 1, so an
  -- artifact with no published version at all cannot be the base of one and lands on
  -- version_conflict: this command appends to an artifact, it does not start one.
  SELECT * INTO v_base FROM work.artifact_version av
    WHERE av.artifact_id = p_artifact_id AND av.org_id = p_org_id
      AND av.state = 'published'
    ORDER BY av.version_no DESC LIMIT 1;
  IF v_base.version_no IS DISTINCT FROM v_base_no THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001',
      DETAIL = COALESCE(v_base.version_no, 0)::text;
  END IF;

  -- J17: the predecessor was "the latest Run is not failed/canceled", which froze an
  -- already-written local result forever after one wrongly clicked reject. The
  -- replacement is this line: the base version's OWN Run must be reconciled. A base with
  -- no run_id in provenance is a user-saved version, so there is nothing to reconcile and
  -- the check passes vacuously - that is not evidence of quiescence.
  IF v_base.provenance ->> 'run_id' IS NOT NULL AND EXISTS (
    SELECT 1 FROM work.operation o
    WHERE o.org_id = p_org_id AND o.run_id = (v_base.provenance ->> 'run_id')::uuid
      AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching',
                      'unknown', 'unresolved')
  ) THEN
    RAISE EXCEPTION 'run_not_quiescent' USING ERRCODE = 'P0001';
  END IF;

  IF v_base.location <> 'local_only' OR v_base.device_id IS DISTINCT FROM p_device_id
     OR v_base.content_hash <> v_base_hash THEN
    RAISE EXCEPTION 'content_on_original_device' USING ERRCODE = 'P0001';
  END IF;

  IF v_classification NOT IN ('local_only', 'remote_excerpt_allowed') THEN
    RAISE EXCEPTION 'classification_unknown' USING ERRCODE = 'P0001';
  END IF;
  IF work.classification_rank(v_classification)
     < work.classification_rank(v_base.classification) THEN
    RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
  END IF;

  IF (p_proof ->> 'clipboard_derived')::boolean THEN
    -- A cloud source version has device_id NULL, so it fails this join the way §7.1 wants:
    -- a clipboard source has to be on the same (org, subject, device).
    SELECT count(*) INTO v_missing
    FROM jsonb_array_elements_text(v_clip) e(id)
    LEFT JOIN work.artifact_version av
      ON av.version_id = e.id::uuid AND av.org_id = p_org_id
    LEFT JOIN work.artifact sa ON sa.id = av.artifact_id AND sa.org_id = p_org_id
    LEFT JOIN work.task st ON st.id = sa.task_id AND st.org_id = p_org_id
    WHERE av.version_id IS NULL
       OR av.device_id IS DISTINCT FROM p_device_id
       OR st.owner_subject_id IS DISTINCT FROM p_actor_subject_id;
    IF v_missing > 0 THEN
      RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(MAX(work.classification_rank(av.classification)), 0) INTO v_floor
    FROM jsonb_array_elements_text(v_clip) e(id)
    JOIN work.artifact_version av
      ON av.version_id = e.id::uuid AND av.org_id = p_org_id;
    IF work.classification_rank(v_classification)
       < GREATEST(work.classification_rank(v_base.classification), v_floor) THEN
      RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- §7.1 step 4. Literal codes, not a formatted one: the raise-coverage gate only sees a
  -- lowercase literal (the 0040:1860 precedent).
  v_gate := work.local_policy_gate(p_org_id);
  IF v_gate <> 'ready' THEN
    IF v_gate = 'local_policy_incomplete' THEN
      RAISE EXCEPTION 'local_policy_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'local_policy_not_configured' USING ERRCODE = 'P0001';
  END IF;
  SELECT output_limit_bytes INTO v_limit FROM work.local_execution_policy
    WHERE org_id = p_org_id;
  IF v_bytes > v_limit THEN
    RAISE EXCEPTION 'artifact_too_large' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM work.artifact_version
             WHERE org_id = p_org_id AND version_id = v_version_id) THEN
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
  END IF;

  v_next_no := v_base.version_no + 1;

  -- No artifact_replica row here (§17.2): this path carries no server-verifiable device
  -- evidence, and recording one of its pointers as a replica fact would mint authority
  -- over an unverifiable claim.
  INSERT INTO work.artifact_version
    (artifact_id, org_id, version_no, content_hash, bytes, media_type, state, provenance,
     published_at, version_id, location, local_ref, device_id, classification)
  VALUES
    (p_artifact_id, p_org_id, v_next_no, v_content_hash, v_bytes, v_format, 'published',
     jsonb_build_object('source', 'user', 'base_version_no', v_base_no,
                        'device_id', p_device_id, 'session_id', p_session_id),
     now(), v_version_id, 'local_only', p_local_ref, p_device_id, v_classification);

  UPDATE work.artifact a
    SET revision = a.revision + 1, updated_at = now()
    WHERE a.id = p_artifact_id AND a.org_id = p_org_id;
  UPDATE work.task t
    SET revision = t.revision + 1, updated_at = now()
    WHERE t.id = v_task_id AND t.org_id = p_org_id;

  PERFORM work.append_task_event(
    p_org_id, v_task_id, 'artifact.published',
    jsonb_build_object(
      'artifact_id', p_artifact_id, 'version_no', v_next_no, 'version_id', v_version_id,
      'source', 'user', 'location', 'local_only', 'content_hash', v_content_hash,
      'bytes', v_bytes, 'media_type', v_format, 'classification', v_classification,
      'device_id', p_device_id));

  INSERT INTO work.submission_dedup
    (org_id, subject_id, operation_type, client_request_id, request_hash, task_id,
     result_state, result_ref)
  VALUES
    (p_org_id, p_actor_subject_id, 'artifact.version', p_client_request_id,
     v_request_hash, v_task_id, 'published', v_version_id::text);

  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'artifact.local_version_create', 'artifact',
    p_artifact_id::text,
    jsonb_build_object(
      'task_id', v_task_id, 'version_id', v_version_id, 'version_no', v_next_no,
      'base_version_no', v_base_no, 'request_hash', v_request_hash, 'nonce', v_nonce,
      'proof_digest', work.sha256_text(p_proof::text)));

  v_publish_ack := 'sha256:' || work.sha256_text('local_publish_ack|'
    || v_version_id::text || '|' || v_content_hash);

  RETURN jsonb_build_object(
    'version_id', v_version_id, 'artifact_id', p_artifact_id, 'version_no', v_next_no,
    'location', 'local_only', 'classification', v_classification,
    'hash', v_content_hash, 'bytes', v_bytes, 'format', v_format,
    'local_ref', p_local_ref, 'publish_ack', v_publish_ack, 'replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- rebind_run_workspace, restated (O-17 = yi, the "also repair batch one" half).
--
-- The body below is 0041:658-833 copied verbatim except for one inserted block: the
-- nonce consumption above §17.3, tagged purpose='workspace_rebind'. Nothing else is
-- rearranged - same checks, same lock order, same audit-receipt replay branch,
-- same succession write, same offer_expiry, same audit row.
--
-- The consumption predicate is written inline rather than shared with the user save
-- path, per §17.3: it is one EXISTS plus one INSERT, and hiding the purpose value
-- behind a common helper would remove the only place that names which signer spent
-- which nonce.
--
-- #87: CREATE OR REPLACE inherits neither SECURITY DEFINER nor search_path, so both
-- are restated in this same statement, and the EXECUTE grant is restated in the
-- privilege tail below so the ACL is readable from this increment alone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work.rebind_run_workspace(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_run_id uuid,
  p_client_request_id text,
  p_old_grant_id uuid,
  p_new_grant_id uuid,
  p_proof jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_old work.workspace_grant%ROWTYPE;
  v_new work.workspace_grant%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_revision bigint;
  v_nonce uuid;
  v_grant_set jsonb;
  v_invalidated int;
  v_cp_seq bigint;
  v_cp_hash text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  v_request_hash := work.sha256_text('run.workspace_rebind|' || p_run_id::text
    || '|' || p_old_grant_id::text || '|' || p_new_grant_id::text
    || '|' || COALESCE(p_proof::text, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'run.workspace_rebind'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_old_grant_id IS NULL OR p_new_grant_id IS NULL
     OR p_old_grant_id = p_new_grant_id
     OR p_proof IS NULL OR jsonb_typeof(p_proof) <> 'object'
     OR (p_proof ->> 'signature') IS NULL
     OR (p_proof ->> 'signature') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_proof ->> 'nonce') IS NULL
     OR (p_proof ->> 'root_identity_hash') IS NULL
     OR (p_proof ->> 'root_identity_hash') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF (p_proof ->> 'old_grant_id')::uuid IS DISTINCT FROM p_old_grant_id
     OR (p_proof ->> 'new_grant_id')::uuid IS DISTINCT FROM p_new_grant_id
     OR (p_proof ->> 'run_id')::uuid IS DISTINCT FROM p_run_id
     OR p_proof ->> 'auth_plane' IS DISTINCT FROM p_auth_plane
     OR (p_proof ->> 'auth_epoch')::bigint IS DISTINCT FROM p_auth_epoch THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- O-17 = yi: the nonce inside the possession proof is spent here, once per
  -- organization. §12.12 step 4 has always read "verify the signature and
  -- atomically consume the nonce", while the 0041 body only tested that the field
  -- was present and copied its value into the audit metadata - the consumption half
  -- of that signed step had no carrier until this table existed.
  --
  -- Position: after the audit-receipt replay branch (so a retry with the same
  -- client_request_id never reaches it) and after every proof-vs-scalar comparison,
  -- but before any business write - which is also why a rebind that refuses further
  -- down cannot leave a spent nonce behind: the rollback takes this insert with it.
  IF EXISTS (SELECT 1 FROM work.consumed_possession_nonce
             WHERE org_id = p_org_id AND nonce = (p_proof ->> 'nonce')) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO work.consumed_possession_nonce (org_id, purpose, nonce)
    VALUES (p_org_id, 'workspace_rebind', p_proof ->> 'nonce');


  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  IF v_task.owner_subject_id IS DISTINCT FROM p_actor_subject_id
     OR v_task.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.state <> 'waiting' OR v_run.wait_reason IS DISTINCT FROM 'input' THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id
    ORDER BY binding_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_binding.grant_set) e
                  WHERE (e ->> 'grant_id')::uuid = p_old_grant_id) THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_old FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = p_old_grant_id FOR UPDATE;
  SELECT * INTO v_new FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = p_new_grant_id FOR UPDATE;
  IF NOT FOUND OR v_new.state <> 'active' THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_new.owner_subject_id IS DISTINCT FROM p_actor_subject_id
     OR v_new.device_id IS DISTINCT FROM v_binding.device_id THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;
  IF v_new.root_identity_hash IS DISTINCT FROM v_old.root_identity_hash
     OR v_new.root_identity_hash IS DISTINCT FROM (p_proof ->> 'root_identity_hash') THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;

  -- The recovery baseline: newest recorded checkpoint for THIS Run, no fence filter.
  -- NULL only when the Run has no recorded checkpoint at all, which is legitimate for
  -- a rebind that happens before any action ran.
  SELECT checkpoint_seq, checkpoint_hash INTO v_cp_seq, v_cp_hash
    FROM work.device_checkpoint
    WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'recorded'
    ORDER BY checkpoint_seq DESC LIMIT 1;

  v_revision := v_binding.binding_revision + 1;
  v_nonce := gen_random_uuid();
  SELECT jsonb_agg(
           CASE WHEN (e ->> 'grant_id')::uuid = p_old_grant_id
                THEN jsonb_build_object('grant_id', p_new_grant_id,
                                        'grant_revision', v_new.grant_revision)
                ELSE e END)
    INTO v_grant_set
    FROM jsonb_array_elements(v_binding.grant_set) e;

  INSERT INTO work.workspace_grant_succession
    (org_id, run_id, old_grant_id, new_grant_id, proof_hash, binding_revision,
     client_request_id, request_hash)
  VALUES
    (p_org_id, p_run_id, p_old_grant_id, p_new_grant_id,
     work.sha256_text(p_proof::text), v_revision, p_client_request_id, v_request_hash);

  UPDATE work.workspace_grant
    SET state = 'succeeded', succeeded_by = p_new_grant_id, updated_at = now(),
        revision = revision + 1
    WHERE org_id = p_org_id AND id = p_old_grant_id AND state = 'active';

  UPDATE work.readonly_approval_grant
    SET status = 'invalidated', updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND workspace_grant_id = p_old_grant_id AND status = 'active';
  GET DIAGNOSTICS v_invalidated = ROW_COUNT;

  INSERT INTO work.device_run_binding
    (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
     input_hash, snapshot_descriptor_ref, snapshot_hash, profile_id, profile_revision,
     runtime_digest, tool_manifest_hash, model_version, grant_set,
     expected_checkpoint_seq, expected_checkpoint_hash, start_nonce, offer_expiry, state)
  VALUES
    (p_org_id, p_run_id, v_revision, v_binding.task_id, v_binding.device_id,
     v_new.session_id, v_binding.input_ref, v_binding.input_hash,
     v_binding.snapshot_descriptor_ref, v_binding.snapshot_hash, v_binding.profile_id,
     v_binding.profile_revision, v_binding.runtime_digest, v_binding.tool_manifest_hash,
     v_binding.model_version, v_grant_set, v_cp_seq, v_cp_hash, v_nonce,
     now() + interval '120 seconds', 'offered');

  UPDATE work.run
    SET control_revision = control_revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_run_id;

  v_response := jsonb_build_object('run_id', p_run_id, 'old_grant_id', p_old_grant_id,
    'new_grant_id', p_new_grant_id, 'binding_revision', v_revision,
    'expected_checkpoint_seq', v_cp_seq, 'expected_checkpoint_hash', v_cp_hash,
    'offer_expiry', now() + interval '120 seconds', 'state', 'offered',
    'invalidated_readonly_grants', v_invalidated);
  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'run.workspace_rebind',
    'run', p_run_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'nonce', p_proof ->> 'nonce', 'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;


-- ---------------------------------------------------------------------------
-- Privileges. No table privilege is granted to any runtime role (0042 precedent): the
-- only way in is a definer command. Every new function is revoked from PUBLIC - the
-- trigger function included, since PostgreSQL hands EXECUTE to PUBLIC to every new
-- function and aclexplode(NULL) shows nothing in the catalog until a grant exists - and
-- only the commands a runtime role actually calls get an EXECUTE grant. The two
-- validators are revoked and granted to nobody, exactly like the seven helpers in 0042.
--
-- rebind_run_workspace is restated here even though CREATE OR REPLACE preserves its ACL:
-- the grant is part of what this increment changed about that command, and the tail is
-- the place a reader looks for the authority surface. Same reasoning as 0042's
-- issue_operation_resolution line.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION work.artifact_replica_matches_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.local_artifact_version_payload_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.user_version_proof_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.finalize_local_artifact(text, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.create_local_user_artifact_version(
  text, text, text, bigint, uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.rebind_run_workspace(
  text, text, text, bigint, uuid, text, uuid, uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION work.finalize_local_artifact(text, uuid, uuid, jsonb)
  TO work_worker;
GRANT EXECUTE ON FUNCTION work.create_local_user_artifact_version(
  text, text, text, bigint, uuid, uuid, uuid, text, text, jsonb) TO work_api;
GRANT EXECUTE ON FUNCTION work.rebind_run_workspace(
  text, text, text, bigint, uuid, text, uuid, uuid, jsonb) TO work_api;

REVOKE ALL ON TABLE work.artifact_replica FROM PUBLIC;
REVOKE ALL ON TABLE work.artifact_replica FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.consumed_possession_nonce FROM PUBLIC;
REVOKE ALL ON TABLE work.consumed_possession_nonce FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;

RESET ROLE;
