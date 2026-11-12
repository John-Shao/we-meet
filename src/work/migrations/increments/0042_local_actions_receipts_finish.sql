-- 0042: the local action ledger, dispatch permits, device receipts and Run finish,
--       plus the device-side approval decision and its readonly grant lifecycle.
--
-- Authority: work-r0b-m1a-device-migration-design-2026-11-12.md §15 (card I = I1,
-- O-12 = jia). Control design §4.2 (prepare_local_operation / consume_device_permit /
-- record_device_receipt / decide_local_approval / revoke_readonly_grant /
-- consume_device_ack), §6.4 (finish_local_run and its dedicated terminal writer),
-- §5 (readonly grant), device design §3.1 / §3.3 / §3.4 / §3.5 / §4.3.
--
-- Four tables: local_action, device_dispatch, device_receipt, device_run_finish.
-- readonly_approval_grant already landed in 0040 (card T); this increment gives it
-- its remaining two writers (decide_local_approval inserts, revoke_readonly_grant
-- revokes) and its read face.
--
-- Prerequisites ruled before landing, all by the sole signatory on 2026-11-12:
--   O-5  = jia: device_dispatch.execution_id stays as a column with no writer.
--   O-6  = jia: device_run_finish.reason_code lists only the seven device-side values;
--               cancellation reasons live in work.run.terminal_reason.
--   O-9  = jia: no prepare_id column on operation; the idempotency authority stays
--               (org_id, run_id, logical_key) + request_hash.
--   O-10 = jia: issue_operation_resolution is restated below - two attestation keys
--               become table reads, journal_unavailable stays an attestation,
--               seal_checked is deleted (device_run_seal was moved out by card E=B).
--   carrier = bing: work.local_action is new, so (A) the destination gate and (B) the
--               artifact classification floor finally have a per-action input set.
--   O-14 = jia: prepare_local_operation does NOT reserve quota. The signed
--               action_prepare key set carries no account_key/period_id and the cloud
--               path takes them from deployment config (runflow/activities.go:929/953),
--               which a SQL definer cannot read. The caller reserves through the
--               existing ensure_quota_account + reserve_quota path; consume_device_permit
--               only re-verifies a reservation that already exists. M1b/I4 owns that
--               caller - the obligation is recorded in the design doc, not implied here.
--   O-15 = jia: the ApprovalDecisionProof nonce is consumed atomically by a new nullable
--               approval_decision.nonce column plus a partial unique index. The R0a
--               decide_approval path leaves it NULL and is unchanged.
--   O-16 = jia: final_operation_set_hash gets an explicit ordered formula, defined in
--               work.local_operation_set_hash below and propagated to the device and
--               control design docs in the same batch. It is a cross-side contract:
--               the M3 agent must compute the same value.
--
-- Two existing objects are revised here rather than in a separate increment:
--   debt 2: operation_supersede_reason_check four values -> six. Without this the two
--           active-bucket reasons cannot be inserted at all (23514).
--   O-10:   issue_operation_resolution, restated with every other 0021 check kept.
--
-- Signature verification stays in the Go/gateway layer, exactly as 0021/0040/0041 do:
-- plpgsql cannot verify ES256, so these bodies format-check, bind and CAS.
-- No new public error code is registered; every new RAISE code gets a db_exception_map
-- entry in src/work/contracts/error-codes.json.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- O-15: the single-use nonce carrier for ApprovalDecisionProof.
--
-- Device design §4.3: "服务端对HTTP字段逐项与proof比较并原子消费nonce". approval_decision
-- had seven columns and no nonce, and no one-shot nonce table existed anywhere in the
-- schema. Adding a nullable column keeps the single-use authority in the same row and
-- the same transaction as the decision it authorises. decide_approval (R0a) never
-- writes it, so its behaviour is unchanged; the partial index only covers non-NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE work.approval_decision ADD COLUMN nonce text;

ALTER TABLE work.approval_decision
  ADD CONSTRAINT approval_decision_nonce_shape
  CHECK (nonce IS NULL OR nonce ~ '^[A-Za-z0-9_-]{8,128}$');

CREATE UNIQUE INDEX work_approval_decision_nonce_once
  ON work.approval_decision(org_id, nonce) WHERE nonce IS NOT NULL;

-- ---------------------------------------------------------------------------
-- debt 2: the supersede reason closed set, four values -> six.
--
-- Control §4.2 prepare_local_operation: "扩闭集与两桶计数随 I3 的
-- prepare_local_operation 一起落". The two active-bucket names were fixed in the
-- nineteenth round (workspace_rebound / tool_params_changed); "改目的地" was deleted
-- because a supersede may not change the destination. A CHECK cannot be CREATE OR
-- REPLACE'd, so this is DROP + ADD. NULL still passes, exactly as before.
-- ---------------------------------------------------------------------------
ALTER TABLE work.operation DROP CONSTRAINT operation_supersede_reason_check;

ALTER TABLE work.operation
  ADD CONSTRAINT operation_supersede_reason_check
  CHECK (supersede_reason IN ('reauthorized', 'approval_expired', 'source_changed',
                              'resend_undelivered', 'workspace_rebound',
                              'tool_params_changed'));

-- ---------------------------------------------------------------------------
-- local_action (carrier ruling = bing).
--
-- One row per prepared action attempt. This is the input set for both predicates:
--   (A) destination gate  - grants referenced by workspace.read / workspace.search
--                           plus artifact.write output roots (workspace.list excluded)
--   (B) artifact floor    - every referenced grant plus output roots
-- (B) is a superset of (A); they share the comparator (work.classification_rank) and
-- never share the input set, per control §4.2 consume_device_permit (tenth round
-- R10A-1: "不得顺手合并成一个推导函数").
--
-- The ruling listed the minimum columns. Four more are added here because control
-- §4.2's supersede invariants are comparisons against the OLD action ("action_kind/
-- tool_schema/destination不变、classification不降、上界不升") and operation carries
-- none of them - request_hash is a hash of the whole canonical Action and cannot be
-- decomposed. Without these columns the supersede checks would have no server-side
-- operand. They are written once at prepare and never updated.
--
-- No run_id column: the Run is reached through operation_id -> operation.run_id, so
-- the same fact cannot have two sources (same reasoning as device_dispatch, §5.D1).
-- ---------------------------------------------------------------------------
CREATE TABLE work.local_action (
  org_id text NOT NULL,
  operation_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  action_kind text NOT NULL,
  grant_id uuid NOT NULL,
  grant_revision bigint NOT NULL,
  resource_selector_hash text NOT NULL,
  classification text NOT NULL,
  local_payload_ref text NOT NULL,
  request_hash text NOT NULL,
  tool_schema text NOT NULL,
  destination_id text,
  byte_upper_bound bigint NOT NULL,
  token_upper_bound bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, operation_id, attempt_id),
  CONSTRAINT local_action_kind_check
    CHECK (action_kind IN ('workspace.list', 'workspace.read', 'workspace.search',
                           'artifact.write', 'model.send_remote',
                           'model.send_device_local')),
  CONSTRAINT local_action_grant_revision_positive CHECK (grant_revision >= 1),
  CONSTRAINT local_action_selector_hash_shape
    CHECK (resource_selector_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT local_action_classification_check
    CHECK (classification IN ('local_only', 'remote_excerpt_allowed')),
  CONSTRAINT local_action_payload_ref_shape CHECK (local_payload_ref <> ''),
  CONSTRAINT local_action_request_hash_shape CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT local_action_tool_schema_shape CHECK (tool_schema <> ''),
  CONSTRAINT local_action_destination_check
    CHECK (destination_id IS NULL
           OR destination_id IN ('device_local', 'org_private', 'org_remote')),
  -- Only model actions have a destination; a tool or artifact action that claims one
  -- is claiming a disclosure path it does not have.
  CONSTRAINT local_action_destination_shape
    CHECK ((action_kind IN ('model.send_remote', 'model.send_device_local'))
           = (destination_id IS NOT NULL)),
  CONSTRAINT local_action_bounds_nonneg
    CHECK (byte_upper_bound >= 0 AND token_upper_bound >= 0),
  CONSTRAINT local_action_operation_fkey
    FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id),
  CONSTRAINT local_action_grant_fkey
    FOREIGN KEY (grant_id, org_id) REFERENCES work.workspace_grant(id, org_id),
  CONSTRAINT local_action_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.local_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.local_action FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.local_action
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE INDEX work_local_action_run_kind
  ON work.local_action(org_id, operation_id, action_kind);

-- Append-only: prepare writes the row, both predicates only read it. No writer needs
-- to change a recorded action, and letting one rewrite classification after the fact
-- would erase the very fact (A) and (B) are computed from.
CREATE TRIGGER local_action_no_mutation
  BEFORE UPDATE OR DELETE ON work.local_action
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

-- ---------------------------------------------------------------------------
-- device_dispatch (§5.D1).
--
-- One row per dispatch attempt. The two UNIQUE keys are the enforcement point for
-- offset 3: SignedPermit is a stateless token, so command_id and permit_jti uniqueness
-- here is what makes a permit single-use. A second permit table would create a second
-- single-use authority.
--
-- execution_id stays with no writer (O-5 = jia) and delivery_state keeps all five
-- signed values, but only not_applicable and superseded have writers this phase:
-- pending/delivered/undelivered belong to the egress branch card E=B moved out.
-- ---------------------------------------------------------------------------
CREATE TABLE work.device_dispatch (
  org_id text NOT NULL,
  operation_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid NOT NULL,
  journal_epoch uuid NOT NULL,
  command_id uuid NOT NULL,
  permit_jti uuid NOT NULL,
  request_hash text NOT NULL,
  fence bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  execution_id uuid,
  delivery_state text NOT NULL DEFAULT 'not_applicable',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, operation_id, attempt_id),
  CONSTRAINT device_dispatch_command_unique UNIQUE (org_id, command_id),
  CONSTRAINT device_dispatch_jti_unique UNIQUE (org_id, permit_jti),
  CONSTRAINT device_dispatch_fence_positive CHECK (fence >= 1),
  CONSTRAINT device_dispatch_request_hash_shape CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_dispatch_delivery_state_check
    CHECK (delivery_state IN ('not_applicable', 'pending', 'delivered', 'undelivered',
                              'superseded')),
  CONSTRAINT device_dispatch_operation_fkey
    FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id),
  CONSTRAINT device_dispatch_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT device_dispatch_session_fkey
    FOREIGN KEY (session_id, org_id) REFERENCES work.device_session(id, org_id),
  CONSTRAINT device_dispatch_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.device_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.device_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.device_dispatch
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- §6.4 step 4's finish gate reads this index: unresolved dispatches of a Run block a
-- completed finish. The Run is reached through operation_id, not a second run_id column.
CREATE INDEX work_device_dispatch_unresolved
  ON work.device_dispatch(org_id, operation_id)
  WHERE delivery_state IN ('pending', 'undelivered');

CREATE FUNCTION work.device_dispatch_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.journal_epoch IS DISTINCT FROM OLD.journal_epoch
     OR NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.permit_jti IS DISTINCT FROM OLD.permit_jti
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.fence IS DISTINCT FROM OLD.fence
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'device_dispatch_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_dispatch_guard
  BEFORE UPDATE ON work.device_dispatch
  FOR EACH ROW EXECUTE FUNCTION work.device_dispatch_guard();

-- Third column-name variant of the whitelist trigger. The baseline reads OLD.state,
-- 0040 added OLD.status because device/readonly_approval_grant use that signed column
-- name, and device_dispatch uses delivery_state. The column names are signed, so the
-- variant is the price of keeping them; the whitelist itself stays the single authority.
CREATE FUNCTION work.enforce_delivery_state_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entity_name text := TG_ARGV[0];
BEGIN
  IF OLD.delivery_state = NEW.delivery_state THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.state_transition
    WHERE entity = entity_name AND from_state = OLD.delivery_state
      AND to_state = NEW.delivery_state
  ) THEN
    RAISE EXCEPTION 'invalid_transition:%:%->%', entity_name, OLD.delivery_state,
      NEW.delivery_state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_dispatch_transition
  BEFORE UPDATE OF delivery_state ON work.device_dispatch
  FOR EACH ROW EXECUTE FUNCTION work.enforce_delivery_state_transition('device_dispatch');

CREATE TRIGGER device_dispatch_no_delete
  BEFORE DELETE ON work.device_dispatch
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

-- ---------------------------------------------------------------------------
-- device_receipt (§5.D2).
--
-- Append-only evidence, same retention class as audit_event (never swept). started and
-- completed are two rows at two different seq values, not one row changing state, so
-- this table has no whitelist edges. The partial unique index is what makes
-- "operation final 唯一，不接受 started 覆盖 final" a database fact.
--
-- usage_source keeps exactly the three signed values. device_adapter belongs to I5
-- (card Q-a), so device_local model usage is NOT metered in M1a and EV114 is not in
-- this batch's evidence gate. Widening that closed set here would also require the
-- matching widening of operation_resolution.usage_source (debt 3) - both are deferred
-- together, not one without the other.
-- ---------------------------------------------------------------------------
CREATE TABLE work.device_receipt (
  org_id text NOT NULL,
  device_id uuid NOT NULL,
  journal_epoch uuid NOT NULL,
  seq bigint NOT NULL,
  operation_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  request_hash text NOT NULL,
  fence bigint NOT NULL,
  state text NOT NULL,
  outcome text,
  signed_payload_hash text NOT NULL,
  result_hash text,
  local_result_ref text,
  gateway_receipt_hash text,
  resolution_source text NOT NULL DEFAULT 'device',
  server_only boolean NOT NULL DEFAULT false,
  error_code text,
  usage_source text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, device_id, journal_epoch, seq),
  CONSTRAINT device_receipt_seq_positive CHECK (seq >= 1),
  CONSTRAINT device_receipt_fence_positive CHECK (fence >= 1),
  CONSTRAINT device_receipt_request_hash_shape CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_receipt_signed_hash_shape
    CHECK (signed_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_receipt_result_hash_shape
    CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_receipt_gateway_hash_shape
    CHECK (gateway_receipt_hash IS NULL OR gateway_receipt_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_receipt_state_check CHECK (state IN ('started', 'completed', 'unknown')),
  CONSTRAINT device_receipt_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'rejected_not_executed')),
  CONSTRAINT device_receipt_outcome_shape CHECK ((state = 'completed') = (outcome IS NOT NULL)),
  CONSTRAINT device_receipt_source_check
    CHECK (resolution_source IN ('device', 'gateway', 'ops')),
  -- server_only is a boolean column, not a value of resolution_source (control §4.1,
  -- eighth round P2). The two must agree: a device-signed receipt is never server-only,
  -- and a gateway/ops verdict always is.
  CONSTRAINT device_receipt_provenance_shape
    CHECK ((resolution_source = 'device' AND server_only = false)
           OR (resolution_source IN ('gateway', 'ops') AND server_only = true)),
  CONSTRAINT device_receipt_usage_source_check
    CHECK (usage_source IS NULL
           OR usage_source IN ('provider', 'gateway_estimate', 'unavailable')),
  CONSTRAINT device_receipt_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT device_receipt_operation_fkey
    FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id),
  CONSTRAINT device_receipt_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.device_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.device_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.device_receipt
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE UNIQUE INDEX work_device_receipt_one_final
  ON work.device_receipt(org_id, operation_id) WHERE state = 'completed';

CREATE INDEX work_device_receipt_operation
  ON work.device_receipt(org_id, operation_id, seq);

CREATE TRIGGER device_receipt_append_only
  BEFORE UPDATE OR DELETE ON work.device_receipt
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

-- ---------------------------------------------------------------------------
-- device_run_finish (§5.D3).
--
-- The verdict and the row are written in one transaction: control §6.4 step 5 requires
-- every refusal code to be decided before the terminal write, inside the same function,
-- so there is no proposed->accepted row transition and this table is append-only too.
--
-- reason_code lists only the seven device-side values (O-6 = jia). Cancellation-path
-- vocabulary such as approval_rejected stays in work.run.terminal_reason; widening this
-- closed set would mean widening device §3.4, control §9 and the EV list together.
--
-- The accepted row is one of the two drivers of the device's journal tombstone watermark
-- (B03 carrier §3.2). Deleting it would delete the device's only cleanup credential,
-- which is why retention here is "never sweep".
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.deliverable_versions_valid(p_versions jsonb, p_outcome text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  elem jsonb;
  seen uuid[] := ARRAY[]::uuid[];
  vid uuid;
BEGIN
  IF p_versions IS NULL OR jsonb_typeof(p_versions) <> 'array' THEN
    RETURN false;
  END IF;
  -- A completed Run must hand over at least one deliverable; a failed or canceled one
  -- must hand over none, so a stale list cannot be read as a partial success.
  IF p_outcome = 'completed' THEN
    IF jsonb_array_length(p_versions) = 0 THEN
      RETURN false;
    END IF;
  ELSIF jsonb_array_length(p_versions) <> 0 THEN
    RETURN false;
  END IF;
  FOR elem IN SELECT * FROM jsonb_array_elements(p_versions) LOOP
    IF jsonb_typeof(elem) <> 'string' THEN
      RETURN false;
    END IF;
    BEGIN
      vid := elem #>> '{}';
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    IF vid IS NULL OR vid = ANY(seen) THEN
      RETURN false;
    END IF;
    seen := seen || vid;
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE work.device_run_finish (
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  finish_id uuid NOT NULL,
  binding_revision bigint NOT NULL,
  fence bigint NOT NULL,
  lease_id uuid NOT NULL,
  outcome text NOT NULL,
  reason_code text,
  final_checkpoint_seq bigint NOT NULL,
  final_checkpoint_hash text NOT NULL,
  receipt_through_seq bigint NOT NULL,
  final_operation_set_hash text NOT NULL,
  deliverable_versions jsonb NOT NULL,
  signed_payload_hash text NOT NULL,
  state text NOT NULL,
  reject_code text,
  terminal_run_revision bigint,
  server_signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, run_id, finish_id),
  CONSTRAINT device_run_finish_binding_positive CHECK (binding_revision >= 1),
  CONSTRAINT device_run_finish_fence_positive CHECK (fence >= 1),
  CONSTRAINT device_run_finish_outcome_check
    CHECK (outcome IN ('completed', 'failed', 'canceled')),
  CONSTRAINT device_run_finish_reason_check
    CHECK (reason_code IS NULL OR reason_code IN ('no_deliverable', 'model_error',
      'tool_limit', 'runtime_limit_exceeded', 'runtime_unresumable', 'checkpoint_lost',
      'input_missing')),
  CONSTRAINT device_run_finish_reason_shape
    CHECK (outcome <> 'completed' OR reason_code IS NULL),
  CONSTRAINT device_run_finish_checkpoint_seq_nonneg CHECK (final_checkpoint_seq >= 0),
  CONSTRAINT device_run_finish_checkpoint_hash_shape
    CHECK (final_checkpoint_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_run_finish_receipt_seq_nonneg CHECK (receipt_through_seq >= 0),
  CONSTRAINT device_run_finish_set_hash_shape
    CHECK (final_operation_set_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_run_finish_deliverable_shape
    CHECK (work.deliverable_versions_valid(deliverable_versions, outcome)),
  CONSTRAINT device_run_finish_signed_hash_shape
    CHECK (signed_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_run_finish_state_check CHECK (state IN ('accepted', 'rejected')),
  CONSTRAINT device_run_finish_reject_code_check
    CHECK (reject_code IS NULL OR reject_code IN ('run_cancel_requested', 'stale_fence',
      'finish_state_mismatch', 'finish_precondition_failed')),
  CONSTRAINT device_run_finish_verdict_shape
    CHECK ((state = 'accepted' AND terminal_run_revision IS NOT NULL AND reject_code IS NULL)
           OR (state = 'rejected' AND reject_code IS NOT NULL
               AND terminal_run_revision IS NULL)),
  CONSTRAINT device_run_finish_revision_nonneg
    CHECK (terminal_run_revision IS NULL OR terminal_run_revision >= 0),
  CONSTRAINT device_run_finish_signature_shape
    CHECK (server_signature ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT device_run_finish_run_fkey
    FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id),
  CONSTRAINT device_run_finish_lease_fkey
    FOREIGN KEY (lease_id, org_id) REFERENCES work.execution_lease(id, org_id),
  CONSTRAINT device_run_finish_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.device_run_finish ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.device_run_finish FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.device_run_finish
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE UNIQUE INDEX work_device_run_finish_one_accepted
  ON work.device_run_finish(org_id, run_id) WHERE state = 'accepted';

CREATE TRIGGER device_run_finish_append_only
  BEFORE UPDATE OR DELETE ON work.device_run_finish
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

-- ---------------------------------------------------------------------------
-- Whitelist edges for the one new table that has a state column with a writer.
-- Only not_applicable -> superseded is registered: the other three delivery_state
-- values are signed reserved members whose writers belong to the egress branch, and
-- registering edges nobody can walk would create exactly the isolated-state rows the
-- house rules forbid. local_action / device_receipt / device_run_finish are append-only
-- and therefore have no edges at all.
-- ---------------------------------------------------------------------------
INSERT INTO work.state_transition (entity, from_state, to_state) VALUES
  ('device_dispatch', 'not_applicable', 'superseded');

-- ---------------------------------------------------------------------------
-- Closed key-set validators.
--
-- Control §1.1 (twenty-third round ruling 4): a payload key that is not listed is
-- invalid_request, so "additionalProperties=false" has to be enforced by counting keys
-- AND requiring every listed one, not by reading the fields one by one. Each validator
-- is IMMUTABLE and reads no table, so it can also sit in a CHECK if a later increment
-- wants it there.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.local_action_prepare_valid(p_action jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_action IS NOT NULL
     AND jsonb_typeof(p_action) = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys(p_action)) = 20
     AND p_action ?& ARRAY[
       'prepare_id', 'step_key', 'supersede_no', 'logical_key',
       'supersedes_operation_id', 'supersede_reason', 'supersede_assertion',
       'checkpoint_hash', 'request_hash', 'action_kind', 'tool_schema',
       'local_payload_ref', 'grant_id', 'grant_revision', 'resource_selector_hash',
       'classification', 'destination_id', 'byte_upper_bound', 'token_upper_bound',
       'device_signature'];
$$;

CREATE FUNCTION work.device_permit_valid(p_permit jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_permit IS NOT NULL
     AND jsonb_typeof(p_permit) = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys(p_permit)) = 28
     AND p_permit ?& ARRAY[
       'v', 'aud', 'kid', 'jti', 'org_id', 'subject_id', 'device_id', 'session_id',
       'agent_instance_id', 'boot_id', 'generation', 'run_id', 'operation_id',
       'dispatch_attempt_id', 'request_hash', 'fence', 'policy_epoch', 'access_epoch',
       'grant_id', 'grant_revision', 'approval_id', 'decision_revision', 'scope_hash',
       'destination_id', 'max_bytes', 'issued_at', 'expires_at', 'signature'];
$$;

CREATE FUNCTION work.device_receipt_element_valid(p_receipt jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_receipt IS NOT NULL
     AND jsonb_typeof(p_receipt) = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys(p_receipt)) = 11
     AND p_receipt ?& ARRAY[
       'receipt_seq', 'original_execution', 'request_hash', 'state', 'outcome',
       'result_hash', 'local_result_ref', 'error_code', 'usage', 'usage_source',
       'signature']
     AND jsonb_typeof(p_receipt -> 'original_execution') = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys(p_receipt -> 'original_execution')) = 11
     AND (p_receipt -> 'original_execution') ?& ARRAY[
       'org_id', 'subject_id', 'device_id', 'session_id', 'agent_instance_id', 'boot_id',
       'generation', 'run_id', 'operation_id', 'attempt_id', 'fence'];
$$;

CREATE FUNCTION work.device_receipt_batch_valid(p_receipts jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_receipts IS NOT NULL
     AND jsonb_typeof(p_receipts) = 'array'
     AND jsonb_array_length(p_receipts) BETWEEN 1 AND 100
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_receipts) e
       WHERE NOT work.device_receipt_element_valid(e));
$$;

CREATE FUNCTION work.local_run_finish_valid(p_finish jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_finish IS NOT NULL
     AND jsonb_typeof(p_finish) = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys(p_finish)) = 8
     AND p_finish ?& ARRAY[
       'outcome', 'reason_code', 'final_checkpoint_seq', 'final_checkpoint_hash',
       'receipt_through_seq', 'final_operation_set_hash', 'deliverable_versions',
       'device_signature'];
$$;

-- Device design §4.3 signs twenty fields: the nineteen listed there plus signature.
-- The design doc §15.2 abbreviated the list to thirteen because org/subject/auth_plane/
-- auth_epoch arrive as scalars; they are still IN the proof, because "服务端对HTTP字段
-- 逐项与proof比较" is only possible if the proof carries its own copy of each one.
-- The signed external text wins over the abbreviation; §15.2 gets a dated correction.
CREATE FUNCTION work.approval_decision_proof_valid(p_decision jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_decision IS NOT NULL
     AND jsonb_typeof(p_decision) = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys(p_decision)) = 20
     AND p_decision ?& ARRAY[
       'v', 'org_id', 'subject_id', 'auth_plane', 'auth_epoch', 'device_id', 'session_id',
       'approval_id', 'operation_id', 'params_hash', 'expected_revision', 'decision',
       'remember_readonly', 'readonly_scope', 'readonly_expires_at', 'policy_epoch',
       'access_epoch', 'nonce', 'expires_at', 'signature']
     AND (p_decision -> 'readonly_scope' IS NULL
          OR jsonb_typeof(p_decision -> 'readonly_scope') = 'null'
          OR (jsonb_typeof(p_decision -> 'readonly_scope') = 'object'
              AND (SELECT count(*)
                   FROM jsonb_object_keys(p_decision -> 'readonly_scope')) = 4
              AND (p_decision -> 'readonly_scope') ?& ARRAY[
                'tool_set', 'resource_selector_hash', 'grant_id', 'grant_revision']));
$$;

-- ---------------------------------------------------------------------------
-- O-16: the canonical operation-set hash, defined here for the first time.
--
-- Control §6.4 step 3 only says "等于服务端按本 Run 的 Operation id/state/result hash
-- 重算的值"; no formula existed anywhere, and device_checkpoint.pending_operation_set_hash
-- is device-reported and only format-checked by 0041. This is a cross-side contract:
-- the M3 agent must produce the same bytes, so the rule is written out rather than
-- left to whatever string_agg happens to do.
--
--   input  = EVERY operation of the Run (superseded ones included - the set is the
--            Run's ledger, not the still-actionable subset; the actionable subset is
--            what step 4's blocking gate computes, and the two must not be conflated)
--   order  = operation_id ascending, compared as uuid text
--   element= {"operation_id":"<uuid>","state":"<state>","result_hash":"<hex or empty>"}
--            with exactly that key order and no whitespace
--   result = work.sha256_text('[' || join(elements, ',') || ']')
--   result_hash = the result_hash of that operation's newest completed device_receipt,
--            empty string when there is none (an operation that never produced a
--            result still occupies a slot, so the set cannot silently shrink)
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.local_operation_set_hash(p_org_id text, p_run_id uuid) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_body text;
BEGIN
  SELECT COALESCE(string_agg(
           '{"operation_id":"' || o.id::text || '","state":"' || o.state
             || '","result_hash":"' || COALESCE((
                  SELECT r.result_hash FROM work.device_receipt r
                  WHERE r.org_id = p_org_id AND r.operation_id = o.id
                    AND r.state = 'completed'
                  ORDER BY r.seq DESC LIMIT 1), '') || '"}',
           ',' ORDER BY o.id::text), '')
    INTO v_body
  FROM work.operation o
  WHERE o.org_id = p_org_id AND o.run_id = p_run_id;
  RETURN work.sha256_text('[' || v_body || ']');
END;
$$;

-- ---------------------------------------------------------------------------
-- prepare_local_operation (control §4.2, design §6.1).
--
-- Judgment order is the signed one and is not rearranged: identity/session/lease/fence/
-- checkpoint, then the local policy gate, then the (A) destination gate, then the
-- unknown block, then the readonly branch, then the supersede branch, then the write.
-- Putting the unknown block after the write would make invariant 3 unenforceable, and
-- putting (A) after the Operation insert would violate "不建 Operation、不起审批、
-- 不预留配额".
--
-- Two house facts this body has to work around rather than widen:
--   * work.wait_run refuses 'approval' (its own closed set is quota/provider/reconcile),
--     so the waiting(approval) placement that control §6.2 assigns to this path is
--     written here directly, in wait_run's shape. The R0a guard is not widened.
--   * quota is NOT reserved here (O-14 = jia). The caller owns ensure_quota_account +
--     reserve_quota, exactly as the cloud runflow path does.
--
-- No new outbox kind: every event goes through work.append_task_event, which writes
-- outbox with kind='task_event' - the kind the relay already consumes. 0040 established
-- that a new kind would be a non-retryable unknown_outbox_kind.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.prepare_local_operation(
  p_org_id text,
  p_run_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_lease_id uuid,
  p_fence bigint,
  p_checkpoint_seq bigint,
  p_action jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_checkpoint work.device_checkpoint%ROWTYPE;
  v_grant work.workspace_grant%ROWTYPE;
  v_policy work.local_execution_policy%ROWTYPE;
  v_old work.operation%ROWTYPE;
  v_old_action work.local_action%ROWTYPE;
  v_existing work.operation%ROWTYPE;
  v_existing_action work.local_action%ROWTYPE;
  v_readonly work.readonly_approval_grant%ROWTYPE;
  v_operation_id uuid;
  v_attempt_id uuid;
  v_approval_id uuid;
  v_kind text;
  v_classification text;
  v_gate text;
  v_taint integer;
  v_max_seq bigint;
  v_step_key text;
  v_supersede_no integer;
  v_reason text;
  v_assertion jsonb;
  v_changed text[];
  v_bucket_count integer;
  v_auto boolean := false;
  v_is_supersede boolean;
  v_succession boolean;
  v_response jsonb;
  v_action_kind text;
  v_destination text;
  v_reservation_id uuid;
  v_final_state text;
  v_final_revision bigint;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF NOT work.local_action_prepare_valid(p_action) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_action_kind := p_action ->> 'action_kind';
  v_destination := p_action ->> 'destination_id';
  v_step_key := p_action ->> 'step_key';
  IF COALESCE(v_step_key, '') = ''
     OR COALESCE(p_action ->> 'logical_key', '') = ''
     OR COALESCE(p_action ->> 'local_payload_ref', '') = ''
     OR COALESCE(p_action ->> 'tool_schema', '') = ''
     OR COALESCE(p_action ->> 'checkpoint_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_action ->> 'request_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_action ->> 'resource_selector_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_action ->> 'device_signature', '') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_action ->> 'prepare_id', '') !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_action ->> 'grant_id', '') !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_action ->> 'supersede_no', '') !~ '^[0-9]+$'
     OR COALESCE(p_action ->> 'grant_revision', '') !~ '^[0-9]+$'
     OR COALESCE(p_action ->> 'byte_upper_bound', '') !~ '^[0-9]+$'
     OR COALESCE(p_action ->> 'token_upper_bound', '') !~ '^[0-9]+$'
     OR v_action_kind NOT IN ('workspace.list', 'workspace.read', 'workspace.search',
                              'artifact.write', 'model.send_remote',
                              'model.send_device_local')
     OR COALESCE(p_action ->> 'classification', '') NOT IN
        ('local_only', 'remote_excerpt_allowed') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_supersede_no := (p_action ->> 'supersede_no')::integer;
  IF (p_action ->> 'logical_key') <> v_step_key || '#' || v_supersede_no THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_is_supersede := (p_action ->> 'supersedes_operation_id') IS NOT NULL;
  IF v_is_supersede <> ((p_action ->> 'supersede_reason') IS NOT NULL)
     OR v_is_supersede <> ((p_action ->> 'supersede_assertion') IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_is_supersede AND v_supersede_no < 1 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF NOT v_is_supersede AND v_supersede_no <> 0 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- A model action carries a destination; nothing else may claim one.
  IF (v_action_kind IN ('model.send_remote', 'model.send_device_local'))
     <> (v_destination IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_destination IS NOT NULL
     AND v_destination NOT IN ('device_local', 'org_private', 'org_remote') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  -- Lock order per control §4.3: Task, Run, Operation, lease.
  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF v_run.task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE id = v_run.task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;

  -- Idempotency authority is the operation key, not prepare_id (O-9 = jia). A replay
  -- returns the original row and the original attempt, so the device can re-read the
  -- attempt_id it needs for consume_device_permit without a second dispatch.
  SELECT * INTO v_existing FROM work.operation
    WHERE org_id = p_org_id AND run_id = p_run_id
      AND logical_key = p_action ->> 'logical_key';
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM (p_action ->> 'request_hash') THEN
      RAISE EXCEPTION 'operation_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_existing_action FROM work.local_action
      WHERE org_id = p_org_id AND operation_id = v_existing.id
      ORDER BY created_at LIMIT 1;
    SELECT ao.approval_id INTO v_approval_id FROM work.approval_operation ao
      WHERE ao.org_id = p_org_id AND ao.operation_id = v_existing.id;
    v_response := jsonb_build_object(
      'operation_id', v_existing.id, 'logical_key', v_existing.logical_key,
      'step_key', v_existing.step_key, 'supersede_no', v_existing.supersede_no,
      'state', v_existing.state, 'revision', v_existing.revision,
      'approval_id', v_approval_id,
      'auto_approved', v_approval_id IS NULL AND v_existing.state = 'authorized',
      'request_hash', v_existing.request_hash,
      'attempt_id', v_existing_action.attempt_id,
      'checkpoint_seq', p_checkpoint_seq,
      'classification', v_existing_action.classification,
      'destination_id', v_existing_action.destination_id);
    RETURN v_response || jsonb_build_object('replayed', true);
  END IF;

  -- 1. identity / session / lease / fence / binding_revision / checkpoint.
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_device.status = 'revoked' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.device_id <> p_device_id
     OR v_session.state <> 'active' OR v_session.expires_at <= now()
     OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_lease FROM work.execution_lease
    WHERE org_id = p_org_id AND id = p_lease_id FOR UPDATE;
  IF NOT FOUND OR v_lease.run_id <> p_run_id OR v_lease.device_id <> p_device_id
     OR v_lease.session_id <> p_session_id OR v_lease.purpose <> 'execute'
     OR v_lease.state <> 'active' OR v_lease.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.fence IS DISTINCT FROM p_fence OR v_lease.fence IS DISTINCT FROM p_fence THEN
    RAISE EXCEPTION 'stale_fence' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id
      AND binding_revision = v_lease.binding_revision FOR UPDATE;
  IF NOT FOUND OR v_binding.state <> 'active'
     OR v_binding.device_id <> p_device_id OR v_binding.session_id <> p_session_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(MAX(checkpoint_seq), -1) INTO v_max_seq FROM work.device_checkpoint
    WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'recorded';
  IF p_checkpoint_seq IS DISTINCT FROM v_max_seq THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_checkpoint FROM work.device_checkpoint
    WHERE org_id = p_org_id AND run_id = p_run_id AND checkpoint_seq = p_checkpoint_seq;
  IF v_checkpoint.checkpoint_hash IS DISTINCT FROM (p_action ->> 'checkpoint_hash') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- 0041's fail-closed rule, restated on the action path: a resume offer that points at
  -- a baseline may not prepare against a different one.
  IF v_binding.expected_checkpoint_seq IS NOT NULL
     AND (v_binding.expected_checkpoint_seq IS DISTINCT FROM p_checkpoint_seq
          OR v_binding.expected_checkpoint_hash IS DISTINCT FROM
             (p_action ->> 'checkpoint_hash')) THEN
    RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
  END IF;

  -- 2. the local policy gate, with zero side effects on refusal. Literal branches, not
  -- a dynamic RAISE: the apierr coverage gate only recognises literal codes (0040).
  v_gate := work.local_policy_gate(p_org_id);
  IF v_gate = 'local_policy_incomplete' THEN
    RAISE EXCEPTION 'local_policy_incomplete' USING ERRCODE = 'P0001';
  END IF;
  IF v_gate <> 'ready' THEN
    RAISE EXCEPTION 'local_policy_not_configured' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_policy FROM work.local_execution_policy WHERE org_id = p_org_id;

  SELECT * INTO v_grant FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = (p_action ->> 'grant_id')::uuid FOR UPDATE;
  IF NOT FOUND OR v_grant.device_id <> p_device_id OR v_grant.state <> 'active'
     OR v_grant.expires_at <= now()
     OR v_grant.grant_revision IS DISTINCT FROM
        (p_action ->> 'grant_revision')::bigint THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  -- The grant's tool whitelist is a closed set of the four workspace/artifact kinds;
  -- model actions reference a grant for its classification, not for a tool permission.
  IF v_action_kind IN ('workspace.list', 'workspace.read', 'workspace.search',
                       'artifact.write')
     AND NOT (v_action_kind = ANY(v_grant.allowed_tools)) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  -- Card U = jia: the device reports the rule index it matched, the server lands the
  -- value. The grant's classification is already server-derived (0040), so it is the
  -- authority here; a device claim that is LESS strict is refused, never accepted.
  v_classification := v_grant.classification;
  IF work.classification_rank(p_action ->> 'classification')
     < work.classification_rank(v_classification) THEN
    RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
  END IF;

  -- 3. (A) the destination gate. Input set = grants referenced by content-taking
  -- actions of this Run (workspace.read / workspace.search / artifact.write output
  -- roots), including succession. workspace.list is excluded (J11). The refusal only
  -- fires for a model action whose destination is outside the device; with card E=B
  -- the only reachable destination is device_local, so this branch is unreachable in
  -- production today - it is implemented, not deleted and not relaxed.
  IF v_action_kind IN ('model.send_remote', 'model.send_device_local')
     AND v_destination <> 'device_local' THEN
    SELECT COALESCE(MAX(work.classification_rank(g.classification)), 0) INTO v_taint
    FROM work.local_action la
    JOIN work.operation o ON o.id = la.operation_id AND o.org_id = la.org_id
    JOIN work.workspace_grant g ON g.id = la.grant_id AND g.org_id = la.org_id
    WHERE la.org_id = p_org_id AND o.run_id = p_run_id
      AND la.action_kind IN ('workspace.read', 'workspace.search', 'artifact.write');
    IF v_taint >= work.classification_rank('local_only') THEN
      RAISE EXCEPTION 'destination_not_allowed_for_local_only' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 4. invariant 3, first enforcement point. The code is run_has_unreconciled_operation,
  -- NOT execution_unknown: the refused action has no Operation to reconcile.
  IF EXISTS (
    SELECT 1 FROM work.operation o
    WHERE o.org_id = p_org_id AND o.run_id = p_run_id
      AND o.state IN ('unknown', 'unresolved')
  ) THEN
    RAISE EXCEPTION 'run_has_unreconciled_operation' USING ERRCODE = 'P0001';
  END IF;

  -- 6. supersede validation, before any write. (Step 5's readonly branch is evaluated
  -- after it because a supersede that must be re-approved may not hit the grant.)
  v_reason := p_action ->> 'supersede_reason';
  IF v_is_supersede THEN
    IF v_reason NOT IN ('reauthorized', 'approval_expired', 'source_changed',
                        'resend_undelivered', 'workspace_rebound',
                        'tool_params_changed') THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_old FROM work.operation
      WHERE org_id = p_org_id
        AND id = (p_action ->> 'supersedes_operation_id')::uuid FOR UPDATE;
    IF NOT FOUND OR v_old.run_id <> p_run_id OR v_old.step_key IS DISTINCT FROM v_step_key
       OR v_old.supersede_no + 1 <> v_supersede_no THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    -- One old Operation may be superseded at most once.
    IF EXISTS (SELECT 1 FROM work.operation o
               WHERE o.org_id = p_org_id
                 AND o.supersedes_operation_id = v_old.id) THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_old_action FROM work.local_action
      WHERE org_id = p_org_id AND operation_id = v_old.id
      ORDER BY created_at LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    -- The invariants that make a supersede the same action rather than a new one.
    IF v_old_action.action_kind IS DISTINCT FROM v_action_kind
       OR v_old_action.tool_schema IS DISTINCT FROM (p_action ->> 'tool_schema')
       OR v_old_action.destination_id IS DISTINCT FROM v_destination
       OR work.classification_rank(v_classification)
          < work.classification_rank(v_old_action.classification)
       OR (p_action ->> 'byte_upper_bound')::bigint > v_old_action.byte_upper_bound
       OR (p_action ->> 'token_upper_bound')::bigint > v_old_action.token_upper_bound THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    v_assertion := p_action -> 'supersede_assertion';
    IF jsonb_typeof(v_assertion) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_assertion)) <> 14
       OR NOT v_assertion ?& ARRAY[
         'v', 'run_id', 'old_operation_id', 'new_operation_id', 'old_request_hash',
         'new_request_hash', 'reason', 'changed_fields', 'device_id', 'session_id',
         'auth_plane', 'auth_epoch', 'nonce', 'expires_at']
       OR (v_assertion ->> 'old_operation_id') IS DISTINCT FROM v_old.id::text
       OR (v_assertion ->> 'run_id') IS DISTINCT FROM p_run_id::text
       OR (v_assertion ->> 'old_request_hash') IS DISTINCT FROM v_old.request_hash
       OR (v_assertion ->> 'new_request_hash') IS DISTINCT FROM
          (p_action ->> 'request_hash')
       OR (v_assertion ->> 'reason') IS DISTINCT FROM v_reason
       OR (v_assertion ->> 'device_id') IS DISTINCT FROM p_device_id::text
       OR (v_assertion ->> 'session_id') IS DISTINCT FROM p_session_id::text THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_typeof(v_assertion -> 'changed_fields') <> 'array' THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    SELECT array_agg(x) INTO v_changed
      FROM jsonb_array_elements_text(v_assertion -> 'changed_fields') x;
    IF v_changed IS NULL
       OR NOT work.text_array_closed_unique(v_changed,
            ARRAY['grant', 'entry_ref', 'source_identity', 'params', 'none']) THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    -- reason <-> changed_fields pairs that are decidable from the closed set.
    IF (v_reason = 'workspace_rebound'
        AND NOT (v_changed @> ARRAY['grant', 'entry_ref']))
       OR (v_reason = 'tool_params_changed' AND NOT (v_changed @> ARRAY['params']))
       OR (v_reason = 'source_changed' AND NOT (v_changed @> ARRAY['source_identity']))
       OR (v_reason = 'resend_undelivered' AND NOT (v_changed @> ARRAY['none']))
       OR (v_reason = 'approval_expired' AND NOT (v_changed @> ARRAY['none']))
       OR (v_reason = 'reauthorized' AND NOT (v_changed @> ARRAY['grant'])) THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    -- The mutually inverse pair (twenty-first round): workspace_rebound requires a
    -- succession row the server itself wrote and the new action must reference its
    -- new grant; reauthorized requires that no such row exists and the scope is
    -- unchanged. entry_ref has no column on this side, so resource_selector_hash is
    -- the observable identity of the scope - a narrower test, never a wider one.
    SELECT EXISTS (
      SELECT 1 FROM work.workspace_grant_succession s
      WHERE s.org_id = p_org_id AND s.run_id = p_run_id
        AND s.old_grant_id = v_old_action.grant_id
        AND s.new_grant_id = (p_action ->> 'grant_id')::uuid
    ) INTO v_succession;
    IF v_reason = 'workspace_rebound' AND NOT v_succession THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    IF v_reason = 'reauthorized'
       AND (v_succession
            OR v_old_action.resource_selector_hash IS DISTINCT FROM
               (p_action ->> 'resource_selector_hash')) THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    -- J21's two buckets, counted separately and refused separately. Active overflow is
    -- supersede_limit_exceeded; passive overflow is supersede_not_allowed, because
    -- "the user did nothing wrong" must not be locked out under the active bucket's
    -- vocabulary (control §9, twenty-first round).
    IF v_reason IN ('workspace_rebound', 'tool_params_changed') THEN
      SELECT count(*) INTO v_bucket_count FROM work.operation o
        WHERE o.org_id = p_org_id AND o.run_id = p_run_id AND o.step_key = v_step_key
          AND o.supersede_reason IN ('workspace_rebound', 'tool_params_changed');
      IF v_bucket_count >= 5 THEN
        RAISE EXCEPTION 'supersede_limit_exceeded' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_reason IN ('approval_expired', 'source_changed') THEN
      SELECT count(*) INTO v_bucket_count FROM work.operation o
        WHERE o.org_id = p_org_id AND o.run_id = p_run_id AND o.step_key = v_step_key
          AND o.supersede_reason = v_reason;
      IF v_bucket_count >= 3 THEN
        RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_reason = 'resend_undelivered' THEN
      SELECT count(*) INTO v_bucket_count FROM work.operation o
        WHERE o.org_id = p_org_id AND o.run_id = p_run_id AND o.step_key = v_step_key
          AND o.supersede_reason = 'resend_undelivered';
      IF v_bucket_count >= 1 THEN
        RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
      END IF;
      -- The old action already succeeded and settled: keep its terminal state and its
      -- settlement, only mark the dispatch superseded.
      IF v_old.state <> 'succeeded' THEN
        RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    -- The old action's own state must permit a supersede. unknown is never superseded.
    IF v_reason <> 'resend_undelivered'
       AND v_old.state IN ('succeeded', 'failed', 'canceled', 'reconciled',
                           'unknown', 'unresolved') THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 5. the readonly branch - the ONLY consumer of readonly_approval_grant (R11C-1).
  -- Coverage is hash equality: a hash cannot express a subtree, and the signed rule
  -- (list/search take relative_dir, read takes the entry's parent dir) is computed on
  -- the device into this hash. Equality is the narrow reading - it can only prompt
  -- more often, never approve a wider scope than the user signed.
  IF v_action_kind IN ('workspace.list', 'workspace.read', 'workspace.search')
     AND NOT (v_is_supersede AND v_reason IN ('reauthorized', 'resend_undelivered')) THEN
    SELECT * INTO v_readonly FROM work.readonly_approval_grant g
      WHERE g.org_id = p_org_id AND g.run_id = p_run_id AND g.device_id = p_device_id
        AND g.workspace_grant_id = v_grant.id
        AND g.grant_revision = v_grant.grant_revision
        AND g.status = 'active' AND g.expires_at > now()
        AND v_action_kind = ANY(g.tool_set)
        AND g.resource_selector_hash = (p_action ->> 'resource_selector_hash')
        AND g.policy_epoch = v_policy.effective_epoch
        AND g.access_epoch = v_run.admission_access_epoch
      ORDER BY g.created_at LIMIT 1;
    IF FOUND THEN
      v_auto := true;
    END IF;
  END IF;

  -- 7. the atomic write.
  v_operation_id := work.create_operation(p_run_id, p_org_id,
    p_action ->> 'logical_key',
    CASE WHEN v_action_kind LIKE 'workspace.%' THEN 'tool'
         WHEN v_action_kind = 'artifact.write' THEN 'artifact'
         ELSE 'model' END,
    p_action ->> 'request_hash');
  v_attempt_id := gen_random_uuid();

  UPDATE work.operation
    SET step_key = v_step_key, supersede_no = v_supersede_no,
        supersedes_operation_id = CASE WHEN v_is_supersede
          THEN (p_action ->> 'supersedes_operation_id')::uuid ELSE NULL END,
        supersede_reason = v_reason,
        supersede_assertion_hash = CASE WHEN v_is_supersede
          THEN work.sha256_text(v_assertion::text) ELSE NULL END,
        dispatch_attempt_id = v_attempt_id,
        revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = v_operation_id;

  INSERT INTO work.local_action
    (org_id, operation_id, attempt_id, action_kind, grant_id, grant_revision,
     resource_selector_hash, classification, local_payload_ref, request_hash,
     tool_schema, destination_id, byte_upper_bound, token_upper_bound)
  VALUES
    (p_org_id, v_operation_id, v_attempt_id, v_action_kind, v_grant.id,
     v_grant.grant_revision, p_action ->> 'resource_selector_hash', v_classification,
     p_action ->> 'local_payload_ref', p_action ->> 'request_hash',
     p_action ->> 'tool_schema', v_destination,
     (p_action ->> 'byte_upper_bound')::bigint,
     (p_action ->> 'token_upper_bound')::bigint);

  IF v_is_supersede THEN
    -- Conditional termination, exactly as control §4.2 prescribes: cancel_operation
    -- silently returns for terminal and unknown/unresolved rows, and turns a
    -- dispatching row into unknown rather than pretending it did not happen.
    IF v_reason <> 'resend_undelivered' THEN
      PERFORM work.cancel_operation(p_org_id, v_old.id, NULL, 'superseded');
      UPDATE work.approval a
        SET status = 'expired', revision = a.revision + 1, updated_at = now()
        FROM work.approval_operation ao
        WHERE ao.approval_id = a.id AND ao.org_id = a.org_id
          AND ao.operation_id = v_old.id AND a.org_id = p_org_id
          AND a.status = 'pending';
      -- release_quota, not a bare UPDATE: the account's reserved_tokens has to come
      -- back down and the ledger needs its release entry. Only held rows are released
      -- (release_quota refuses anything else, which is why the filter is here).
      FOR v_reservation_id IN
        SELECT q.id FROM work.quota_reservation q
        WHERE q.org_id = p_org_id AND q.operation_id = v_old.id AND q.state = 'held'
      LOOP
        PERFORM work.release_quota(v_reservation_id);
      END LOOP;
    END IF;
    UPDATE work.device_dispatch d
      SET delivery_state = 'superseded', updated_at = now()
      WHERE d.org_id = p_org_id AND d.operation_id = v_old.id
        AND d.delivery_state <> 'superseded';
  END IF;

  IF v_auto THEN
    PERFORM work.authorize_operation(p_org_id, v_operation_id,
      v_policy.effective_epoch, 'policy_auto');
    UPDATE work.readonly_approval_grant
      SET consumed_count = consumed_count + 1, revision = revision + 1,
          updated_at = now()
      WHERE org_id = p_org_id AND id = v_readonly.id;
    PERFORM work.append_audit(p_org_id, NULL, 'operation.auto_approved',
      'operation', v_operation_id::text,
      jsonb_build_object('readonly_grant_id', v_readonly.id,
        'workspace_grant_id', v_grant.id, 'grant_revision', v_grant.grant_revision,
        'action_kind', v_action_kind));
    v_approval_id := NULL;
  ELSE
    -- ask_each is the default: every action that did not hit the readonly grant gets
    -- its own Approval. reauthorized and resend_undelivered land here by construction
    -- because the readonly branch above excludes them, which is control §4.2's
    -- "resend_undelivered强制人工审批" and "reauthorized…每次必须重新逐次审批".
    v_approval_id := work.request_approval(p_org_id, v_operation_id,
      p_action ->> 'request_hash',
      jsonb_build_object('action_kind', v_action_kind, 'grant_id', v_grant.id,
        'grant_revision', v_grant.grant_revision,
        'resource_selector_hash', p_action ->> 'resource_selector_hash',
        'classification', v_classification, 'destination_id', v_destination),
      CASE WHEN v_action_kind IN ('model.send_remote', 'model.send_device_local')
           THEN 'high'
           WHEN v_action_kind = 'artifact.write' THEN 'medium' ELSE 'low' END,
      LEAST(v_grant.expires_at, v_lease.expires_at), v_policy.effective_epoch);
    IF v_run.state = 'active' THEN
      UPDATE work.run
        SET state = 'waiting', wait_reason = 'approval',
            control_revision = control_revision + 1, updated_at = now()
        WHERE org_id = p_org_id AND id = p_run_id;
      PERFORM work.append_task_event(p_org_id, v_task.id, 'run.waiting',
        jsonb_build_object('run_id', p_run_id, 'reason', 'approval'));
    END IF;
  END IF;

  PERFORM work.append_audit(p_org_id, NULL, 'operation.prepare_local',
    'operation', v_operation_id::text,
    jsonb_build_object('run_id', p_run_id, 'device_id', p_device_id,
      'action_kind', v_action_kind, 'classification', v_classification,
      'attempt_id', v_attempt_id, 'supersede_reason', v_reason,
      'auto_approved', v_auto));

  SELECT state, revision INTO v_final_state, v_final_revision
    FROM work.operation WHERE org_id = p_org_id AND id = v_operation_id;
  v_response := jsonb_build_object(
    'operation_id', v_operation_id, 'logical_key', p_action ->> 'logical_key',
    'step_key', v_step_key, 'supersede_no', v_supersede_no,
    'state', v_final_state, 'revision', v_final_revision,
    'approval_id', v_approval_id, 'auto_approved', v_auto,
    'request_hash', p_action ->> 'request_hash', 'attempt_id', v_attempt_id,
    'checkpoint_seq', p_checkpoint_seq, 'classification', v_classification,
    'destination_id', v_destination);
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- consume_device_permit (control §4.2, design §6.3).
--
-- The single-use authority is the pair of UNIQUE keys on device_dispatch plus the
-- authorized -> dispatching CAS. There is no permit table: SignedPermit is a stateless
-- token, and a second table would be a second single-use authority (offset 3).
--
-- Invariant 3's SECOND enforcement point is here, with the same predicate and the same
-- code as prepare. (A) is re-evaluated from server facts, never from the device's own
-- claim; the device's classification only enters as a cross-check.
--
-- Quota is re-verified, not reserved (O-14 = jia): if the caller already reserved, the
-- reservation must still be held or unknown. A released/settled reservation under an
-- authorized Operation means the ledger and the dispatch disagree.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.consume_device_permit(
  p_org_id text,
  p_operation_id uuid,
  p_attempt_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_lease_id uuid,
  p_fence bigint,
  p_request_hash text,
  p_permit jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_operation work.operation%ROWTYPE;
  v_action work.local_action%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_grant work.workspace_grant%ROWTYPE;
  v_policy work.local_execution_policy%ROWTYPE;
  v_approval work.approval%ROWTYPE;
  v_existing work.device_dispatch%ROWTYPE;
  v_reservation work.quota_reservation%ROWTYPE;
  v_command_id uuid;
  v_taint integer;
  v_scope_hash text;
  v_aud text;
  v_response jsonb;
  v_approval_id uuid;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF NOT work.device_permit_valid(p_permit)
     OR COALESCE(p_request_hash, '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_permit ->> 'jti', '') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_permit ->> 'request_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_permit ->> 'scope_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_permit ->> 'signature', '') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_permit ->> 'aud', '') NOT IN ('device-tool', 'device-model-proxy')
     OR COALESCE(p_permit ->> 'fence', '') !~ '^[0-9]+$'
     OR COALESCE(p_permit ->> 'generation', '') !~ '^[0-9]+$'
     OR COALESCE(p_permit ->> 'policy_epoch', '') !~ '^[0-9]+$'
     OR COALESCE(p_permit ->> 'access_epoch', '') !~ '^[0-9]+$'
     OR COALESCE(p_permit ->> 'grant_revision', '') !~ '^[0-9]+$'
     OR COALESCE(p_permit ->> 'max_bytes', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  -- Replay first: the same jti is the same permit, and a permit may not be re-signed
  -- to send the same action twice ("提交结果未知就进入核对").
  SELECT * INTO v_existing FROM work.device_dispatch
    WHERE org_id = p_org_id AND permit_jti = (p_permit ->> 'jti')::uuid;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'command_id', v_existing.command_id, 'permit_jti', v_existing.permit_jti,
      'operation_id', v_existing.operation_id,
      'dispatch_attempt_id', v_existing.attempt_id, 'fence', v_existing.fence,
      'expires_at', v_existing.expires_at, 'delivery_state', v_existing.delivery_state,
      'permit', p_permit, 'replayed', true);
  END IF;

  SELECT task_id INTO v_run.task_id FROM work.run r
    JOIN work.operation o ON o.run_id = r.id AND o.org_id = r.org_id
    WHERE o.org_id = p_org_id AND o.id = p_operation_id;
  IF v_run.task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE id = v_run.task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id
      AND id = (SELECT run_id FROM work.operation
                WHERE org_id = p_org_id AND id = p_operation_id)
    FOR UPDATE;
  SELECT * INTO v_operation FROM work.operation
    WHERE org_id = p_org_id AND id = p_operation_id FOR UPDATE;
  SELECT * INTO v_action FROM work.local_action
    WHERE org_id = p_org_id AND operation_id = p_operation_id
      AND attempt_id = p_attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_operation.dispatch_attempt_id IS DISTINCT FROM p_attempt_id THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_device.status = 'revoked' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.device_id <> p_device_id OR v_session.state <> 'active'
     OR v_session.expires_at <= now()
     OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_lease FROM work.execution_lease
    WHERE org_id = p_org_id AND id = p_lease_id FOR UPDATE;
  IF NOT FOUND OR v_lease.run_id <> v_run.id OR v_lease.device_id <> p_device_id
     OR v_lease.session_id <> p_session_id OR v_lease.state <> 'active'
     OR v_lease.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.fence IS DISTINCT FROM p_fence OR v_lease.fence IS DISTINCT FROM p_fence
     OR (p_permit ->> 'fence')::bigint IS DISTINCT FROM p_fence THEN
    RAISE EXCEPTION 'stale_fence' USING ERRCODE = 'P0001';
  END IF;

  -- Every identity field of the token is compared with a server fact. The token is
  -- never the authority for any of them.
  IF (p_permit ->> 'org_id') IS DISTINCT FROM p_org_id
     OR (p_permit ->> 'subject_id') IS DISTINCT FROM v_task.owner_subject_id
     OR (p_permit ->> 'device_id') IS DISTINCT FROM p_device_id::text
     OR (p_permit ->> 'session_id') IS DISTINCT FROM p_session_id::text
     OR (p_permit ->> 'agent_instance_id') IS DISTINCT FROM
        v_session.agent_instance_id::text
     OR (p_permit ->> 'boot_id') IS DISTINCT FROM v_session.boot_id
     OR (p_permit ->> 'generation')::bigint IS DISTINCT FROM v_session.generation
     OR (p_permit ->> 'run_id') IS DISTINCT FROM v_run.id::text
     OR (p_permit ->> 'operation_id') IS DISTINCT FROM p_operation_id::text
     OR (p_permit ->> 'dispatch_attempt_id') IS DISTINCT FROM p_attempt_id::text
     OR (p_permit ->> 'request_hash') IS DISTINCT FROM p_request_hash
     OR (p_permit ->> 'request_hash') IS DISTINCT FROM v_operation.request_hash THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  -- aud matches the action class; device-egress was moved out by card E=B.
  v_aud := CASE WHEN v_action.action_kind IN ('model.send_remote',
                                            'model.send_device_local')
                THEN 'device-model-proxy' ELSE 'device-tool' END;
  IF (p_permit ->> 'aud') IS DISTINCT FROM v_aud THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  -- TTL: at most five seconds, and never beyond the remaining lease.
  IF (p_permit ->> 'expires_at')::timestamptz <= now()
     OR (p_permit ->> 'expires_at')::timestamptz > now() + interval '5 seconds'
     OR (p_permit ->> 'expires_at')::timestamptz > v_lease.expires_at
     OR (p_permit ->> 'issued_at')::timestamptz > now() THEN
    RAISE EXCEPTION 'permit_expired' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_grant FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = v_action.grant_id FOR UPDATE;
  IF NOT FOUND OR v_grant.state <> 'active' OR v_grant.expires_at <= now()
     OR v_grant.grant_revision IS DISTINCT FROM v_action.grant_revision
     OR (p_permit ->> 'grant_id') IS DISTINCT FROM v_action.grant_id::text
     OR (p_permit ->> 'grant_revision')::bigint IS DISTINCT FROM
        v_action.grant_revision THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_policy FROM work.local_execution_policy WHERE org_id = p_org_id;
  IF (p_permit ->> 'policy_epoch')::bigint IS DISTINCT FROM v_policy.effective_epoch
     OR (p_permit ->> 'access_epoch')::bigint IS DISTINCT FROM
        v_run.admission_access_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF (p_permit ->> 'destination_id') IS DISTINCT FROM v_action.destination_id
     OR (p_permit ->> 'max_bytes')::bigint > v_action.byte_upper_bound THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  -- scope_hash is recomputed from the server's own action row, in a fixed key order.
  v_scope_hash := work.sha256_text('{"action_kind":"' || v_action.action_kind
    || '","grant_id":"' || v_action.grant_id::text
    || '","grant_revision":' || v_action.grant_revision
    || ',"resource_selector_hash":"' || v_action.resource_selector_hash
    || '","classification":"' || v_action.classification
    || '","destination_id":' || CASE WHEN v_action.destination_id IS NULL THEN 'null'
         ELSE '"' || v_action.destination_id || '"' END || '}');
  IF (p_permit ->> 'scope_hash') IS DISTINCT FROM v_scope_hash THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT ao.approval_id INTO v_approval_id FROM work.approval_operation ao
    WHERE ao.org_id = p_org_id AND ao.operation_id = p_operation_id;
  IF v_approval_id IS NOT NULL THEN
    SELECT * INTO v_approval FROM work.approval
      WHERE org_id = p_org_id AND id = v_approval_id FOR UPDATE;
    IF v_approval.status <> 'approved' OR v_approval.expires_at <= now()
       OR (p_permit ->> 'approval_id') IS DISTINCT FROM v_approval_id::text
       OR (p_permit ->> 'decision_revision')::bigint IS DISTINCT FROM
          v_approval.revision THEN
      RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
    END IF;
  ELSIF (p_permit ->> 'approval_id') IS NOT NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  -- Invariant 3, second enforcement point: an unknown that appeared AFTER prepare
  -- still blocks the dispatch.
  IF EXISTS (
    SELECT 1 FROM work.operation o
    WHERE o.org_id = p_org_id AND o.run_id = v_run.id
      AND o.state IN ('unknown', 'unresolved')
  ) THEN
    RAISE EXCEPTION 'run_has_unreconciled_operation' USING ERRCODE = 'P0001';
  END IF;

  -- (A) again, from server facts, with the same input set as prepare.
  IF v_action.action_kind IN ('model.send_remote', 'model.send_device_local')
     AND v_action.destination_id <> 'device_local' THEN
    SELECT COALESCE(MAX(work.classification_rank(g.classification)), 0) INTO v_taint
    FROM work.local_action la
    JOIN work.operation o ON o.id = la.operation_id AND o.org_id = la.org_id
    JOIN work.workspace_grant g ON g.id = la.grant_id AND g.org_id = la.org_id
    WHERE la.org_id = p_org_id AND o.run_id = v_run.id
      AND la.action_kind IN ('workspace.read', 'workspace.search', 'artifact.write');
    IF v_taint >= work.classification_rank('local_only') THEN
      RAISE EXCEPTION 'destination_not_allowed_for_local_only' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF work.classification_rank(v_action.classification)
     < work.classification_rank(v_grant.classification) THEN
    RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
  END IF;

  -- O-14 = jia: re-verify only. No reservation is created here.
  SELECT * INTO v_reservation FROM work.quota_reservation q
    WHERE q.org_id = p_org_id AND q.operation_id = p_operation_id
    ORDER BY q.reservation_seq DESC LIMIT 1;
  IF FOUND AND v_reservation.state NOT IN ('held', 'unknown') THEN
    RAISE EXCEPTION 'quota_reservation_not_held' USING ERRCODE = 'P0001';
  END IF;

  -- The single CAS. Only the winner gets a deliverable permit.
  UPDATE work.operation
    SET state = 'dispatching', revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_operation_id AND state = 'authorized';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_not_authorizable' USING ERRCODE = 'P0001';
  END IF;

  v_command_id := gen_random_uuid();
  INSERT INTO work.device_dispatch
    (org_id, operation_id, attempt_id, device_id, session_id, journal_epoch,
     command_id, permit_jti, request_hash, fence, expires_at, delivery_state)
  VALUES
    (p_org_id, p_operation_id, p_attempt_id, p_device_id, p_session_id,
     v_session.journal_epoch, v_command_id, (p_permit ->> 'jti')::uuid,
     p_request_hash, p_fence, (p_permit ->> 'expires_at')::timestamptz,
     'not_applicable');

  PERFORM work.append_task_event(p_org_id, v_task.id, 'operation.dispatched',
    jsonb_build_object('operation_id', p_operation_id, 'command_id', v_command_id,
      'attempt_id', p_attempt_id, 'fence', p_fence));
  PERFORM work.append_audit(p_org_id, NULL, 'device_permit.consumed',
    'operation', p_operation_id::text,
    jsonb_build_object('command_id', v_command_id,
      'permit_jti', (p_permit ->> 'jti')::uuid, 'attempt_id', p_attempt_id,
      'aud', v_aud, 'fence', p_fence));

  v_response := jsonb_build_object(
    'command_id', v_command_id, 'permit_jti', (p_permit ->> 'jti')::uuid,
    'operation_id', p_operation_id, 'dispatch_attempt_id', p_attempt_id,
    'fence', p_fence, 'expires_at', (p_permit ->> 'expires_at')::timestamptz,
    'delivery_state', 'not_applicable', 'permit', p_permit);
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- record_device_receipt (control §4.2, design §6.4).
--
-- The terminal writer for a local Operation is work.issue_operation_resolution, NOT
-- work.finish_operation_from_receipt. The latter is hard-wired to the egress gate: it
-- raises dispatch_gate_not_found without a work.dispatch_delivery row and
-- dispatch_receipt_not_bound unless that row is receipt_recorded/success. Card E=B moved
-- the egress entry out, so no local action ever has such a row - calling it would make
-- every local receipt unsettleable. issue_operation_resolution already writes the
-- Operation's terminal state through the whitelist intersection AND the resolution row
-- the device needs to move its journal out of unknown (control §6.4 step 6).
--
-- device_local usage is NOT metered here (card Q-a, I5): usage_source is validated
-- against the three signed values and otherwise carried, never settled. EV114 is not
-- in this batch's evidence gate.
--
-- An old fence is accounted, not refused: the receipt is evidence about what happened,
-- and discarding it would lose the fact. It simply does not write any state.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.record_device_receipt(
  p_org_id text,
  p_device_id uuid,
  p_journal_epoch uuid,
  p_receipts jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_operation work.operation%ROWTYPE;
  v_run work.run%ROWTYPE;
  v_existing work.device_receipt%ROWTYPE;
  v_element jsonb;
  v_exec jsonb;
  v_seq bigint;
  v_expected bigint;
  v_through bigint;
  v_signed_hash text;
  v_state text;
  v_outcome text;
  v_resolution jsonb;
  v_recorded jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_old_fence boolean;
  v_lease_id uuid;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF NOT work.device_receipt_batch_valid(p_receipts) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_device.status = 'revoked' THEN
    -- A revoked device's late receipts are no longer accepted (B03 carrier §3.3);
    -- the Run is closed one-sidedly from the server's own gate facts.
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(seq), 0) INTO v_expected FROM work.device_receipt
    WHERE org_id = p_org_id AND device_id = p_device_id
      AND journal_epoch = p_journal_epoch;
  v_through := v_expected;
  v_expected := v_expected + 1;

  FOR v_element IN SELECT * FROM jsonb_array_elements(p_receipts) LOOP
    v_exec := v_element -> 'original_execution';
    v_seq := (v_element ->> 'receipt_seq')::bigint;
    v_state := v_element ->> 'state';
    v_outcome := v_element ->> 'outcome';
    v_signed_hash := work.sha256_text(COALESCE(v_element ->> 'signature', ''));

    IF COALESCE(v_element ->> 'request_hash', '') !~ '^[0-9a-f]{64}$'
       OR COALESCE(v_element ->> 'signature', '') !~ '^sha256:[0-9a-f]{64}$'
       OR v_state NOT IN ('started', 'completed', 'unknown')
       OR (v_state = 'completed') <> (v_outcome IS NOT NULL)
       OR (v_outcome IS NOT NULL AND v_outcome NOT IN
           ('succeeded', 'failed', 'rejected_not_executed'))
       OR COALESCE(v_exec ->> 'org_id', '') <> p_org_id
       OR COALESCE(v_exec ->> 'device_id', '') <> p_device_id::text
       OR COALESCE(v_exec ->> 'fence', '') !~ '^[0-9]+$'
       OR (v_element ->> 'usage_source') IS NOT NULL
          AND (v_element ->> 'usage_source') NOT IN
              ('provider', 'gateway_estimate', 'unavailable') THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'receipt_seq', v_seq, 'code', 'invalid_request'));
      CONTINUE;
    END IF;

    SELECT * INTO v_existing FROM work.device_receipt
      WHERE org_id = p_org_id AND device_id = p_device_id
        AND journal_epoch = p_journal_epoch AND seq = v_seq;
    IF FOUND THEN
      IF v_existing.signed_payload_hash IS DISTINCT FROM v_signed_hash THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'receipt_seq', v_seq, 'code', 'idempotency_key_conflict'));
      ELSE
        v_recorded := v_recorded || jsonb_build_array(jsonb_build_object(
          'receipt_seq', v_seq, 'operation_id', v_existing.operation_id,
          'state', v_existing.state, 'resolution_revision', NULL, 'replayed', true));
        IF v_seq >= v_through THEN
          v_through := v_seq;
        END IF;
      END IF;
      CONTINUE;
    END IF;

    IF v_seq <> v_expected THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'receipt_seq', v_seq, 'code', 'receipt_seq_out_of_window'));
      CONTINUE;
    END IF;

    SELECT * INTO v_operation FROM work.operation
      WHERE org_id = p_org_id AND id = (v_exec ->> 'operation_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'receipt_seq', v_seq, 'code', 'invalid_request'));
      CONTINUE;
    END IF;
    SELECT * INTO v_run FROM work.run
      WHERE org_id = p_org_id AND id = v_operation.run_id;
    IF v_run.id::text IS DISTINCT FROM (v_exec ->> 'run_id')
       OR v_operation.dispatch_attempt_id::text IS DISTINCT FROM
          (v_exec ->> 'attempt_id') THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'receipt_seq', v_seq, 'code', 'invalid_request'));
      CONTINUE;
    END IF;
    -- The outer session only carries transport; the identity that matters is the one
    -- signed into original_execution, and it must be a session of this device.
    SELECT * INTO v_session FROM work.device_session
      WHERE org_id = p_org_id AND id = (v_exec ->> 'session_id')::uuid;
    IF NOT FOUND OR v_session.device_id <> p_device_id
       OR v_session.journal_epoch IS DISTINCT FROM p_journal_epoch
       OR v_session.boot_id IS DISTINCT FROM (v_exec ->> 'boot_id')
       OR v_session.agent_instance_id::text IS DISTINCT FROM
          (v_exec ->> 'agent_instance_id')
       OR v_session.generation::text IS DISTINCT FROM (v_exec ->> 'generation') THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'receipt_seq', v_seq, 'code', 'receipt_signature_invalid'));
      CONTINUE;
    END IF;
    v_old_fence := (v_exec ->> 'fence')::bigint IS DISTINCT FROM v_run.fence;

    INSERT INTO work.device_receipt
      (org_id, device_id, journal_epoch, seq, operation_id, attempt_id, request_hash,
       fence, state, outcome, signed_payload_hash, result_hash, local_result_ref,
       resolution_source, server_only, error_code, usage_source)
    VALUES
      (p_org_id, p_device_id, p_journal_epoch, v_seq, v_operation.id,
       v_operation.dispatch_attempt_id, v_element ->> 'request_hash',
       (v_exec ->> 'fence')::bigint, v_state, v_outcome, v_signed_hash,
       NULLIF(v_element ->> 'result_hash', ''),
       NULLIF(v_element ->> 'local_result_ref', ''),
       'device', false, NULLIF(v_element ->> 'error_code', ''),
       NULLIF(v_element ->> 'usage_source', ''));

    v_resolution := NULL;
    IF v_state = 'completed' AND NOT v_old_fence THEN
      IF v_outcome = 'rejected_not_executed' THEN
        -- That verdict belongs to an Operation that was never dispatched; from
        -- dispatching there is no registered edge to it, so it cannot be written here.
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'receipt_seq', v_seq, 'code', 'invalid_request'));
      ELSE
        v_resolution := work.issue_operation_resolution(
          p_org_id, v_operation.id, v_outcome, NULL, NULL,
          'sha256:' || work.sha256_text('operation_resolution|'
            || v_operation.id::text || '|' || v_outcome || '|' || v_seq::text),
          NULL,
          jsonb_build_object('source', 'device_receipt', 'receipt_seq', v_seq,
            'journal_epoch', p_journal_epoch, 'fence', (v_exec ->> 'fence')::bigint));
      END IF;
    END IF;

    v_recorded := v_recorded || jsonb_build_array(jsonb_build_object(
      'receipt_seq', v_seq, 'operation_id', v_operation.id, 'state', v_state,
      'resolution_revision', v_resolution -> 'resolution_revision',
      'replayed', false));
    v_through := v_seq;
    v_expected := v_seq + 1;
  END LOOP;

  -- The two watermarks the design names. They only ever advance.
  UPDATE work.device_session
    SET last_receipt_seq = GREATEST(last_receipt_seq, v_through),
        revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND device_id = p_device_id
      AND journal_epoch = p_journal_epoch AND last_receipt_seq < v_through;
  FOR v_lease_id IN
    SELECT l.id FROM work.execution_lease l
    WHERE l.org_id = p_org_id AND l.device_id = p_device_id
      AND l.state = 'active' AND l.last_receipt_seq < v_through
  LOOP
    UPDATE work.execution_lease
      SET last_receipt_seq = v_through, revision = revision + 1, updated_at = now()
      WHERE org_id = p_org_id AND id = v_lease_id;
  END LOOP;

  PERFORM work.append_audit(p_org_id, NULL, 'device_receipt.recorded',
    'device', p_device_id::text,
    jsonb_build_object('journal_epoch', p_journal_epoch,
      'recorded', jsonb_array_length(v_recorded),
      'conflicts', jsonb_array_length(v_conflicts),
      'receipt_through_seq', v_through));

  RETURN jsonb_build_object('recorded', v_recorded, 'conflicts', v_conflicts,
    'receipt_through_seq', v_through);
END;
$$;

-- ---------------------------------------------------------------------------
-- finish_local_run_state: the local Run's ONLY terminal writer (control §6.4 step 5).
--
-- It must not call work.finish_run. The four signed reasons, restated because they are
-- the whole point of this function existing:
--   1. finish_run gates succeeded on the TASK-level task_has_blocking_operation, which
--      would let a previous Run's unknown block this Run forever, and it returns
--      run_has_unresolved_operation instead of finish_precondition_failed.
--   2. finish_run has no device-side inputs and writes none of device_run_finish,
--      lease release, binding finish or the revision return.
--   3. finish_run's replay is by outcome and RETURNS void, so a device that lost its
--      ack cannot recover terminal_run_revision, and a different payload with the same
--      outcome is silently swallowed.
--   4. finish_run only protects the succeeded branch under cancel_requested; failed and
--      canceled overwrite terminal_reason unconditionally.
--
-- The terminal task_event, the outbox row and the reservation release are NOT written
-- here: run_terminal_event, run_terminal_reservation_release and append_task_event's
-- own outbox insert already do it, and duplicating them would double every event.
--
-- waiting -> succeeded is deliberately NOT a new edge. It goes waiting -> active ->
-- succeeded, reusing resume_run, because a direct edge would skip the R0a finish gate
-- that the whitelist exists to protect.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.finish_local_run_state(
  p_org_id text,
  p_run_id uuid,
  p_outcome text,
  p_reason text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_reason text := work.reason_code(p_reason);
  v_target text;
  v_execution_id uuid;
  v_lease_id uuid;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  IF p_outcome NOT IN ('succeeded', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF v_run.task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE id = v_run.task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;

  IF v_run.state = p_outcome THEN
    RETURN v_run.control_revision;
  END IF;
  IF p_outcome = 'succeeded' AND v_run.state = 'cancel_requested' THEN
    RAISE EXCEPTION 'run_cancel_requested' USING ERRCODE = 'P0001';
  END IF;
  IF v_task.state <> 'open' OR v_task.active_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;

  v_target := p_outcome;
  -- A failed proposal under a cancel request becomes the cancellation finish, and the
  -- cancellation reason already on the row is kept (control §6.4 step 2).
  IF v_run.state = 'cancel_requested' AND p_outcome IN ('failed', 'canceled') THEN
    v_target := 'canceled';
  END IF;

  IF v_run.state = 'waiting' AND p_outcome = 'succeeded' THEN
    PERFORM work.resume_run(p_org_id, p_run_id);
    SELECT * INTO v_run FROM work.run
      WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  END IF;
  -- canceled has no direct edge from active or waiting; it goes through
  -- cancel_requested, which is the registered path and keeps the reason.
  IF v_target = 'canceled' AND v_run.state IN ('active', 'waiting') THEN
    UPDATE work.run
      SET state = 'cancel_requested',
          terminal_reason = COALESCE(v_run.terminal_reason, v_reason),
          control_revision = control_revision + 1, updated_at = now()
      WHERE org_id = p_org_id AND id = p_run_id;
    SELECT * INTO v_run FROM work.run
      WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  END IF;

  UPDATE work.run
    SET state = v_target,
        wait_reason = NULL,
        terminal_reason = CASE
          WHEN v_run.state = 'cancel_requested' THEN v_run.terminal_reason
          ELSE v_reason END,
        control_revision = control_revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_run_id;

  UPDATE work.task
    SET state = CASE WHEN v_target = 'succeeded' THEN 'awaiting_acceptance'
                     ELSE state END,
        active_run_id = NULL, latest_run_id = p_run_id,
        revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = v_task.id;

  -- §5.E1's third invalidation source: the Run reaching a terminal state invalidates
  -- its readonly grants in the same transaction.
  UPDATE work.readonly_approval_grant
    SET status = 'invalidated', revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND run_id = p_run_id AND status = 'active';

  FOR v_lease_id IN
    SELECT l.id FROM work.execution_lease l
    WHERE l.org_id = p_org_id AND l.run_id = p_run_id AND l.state = 'active'
  LOOP
    UPDATE work.execution_lease
      SET state = 'released', revision = revision + 1, updated_at = now()
      WHERE org_id = p_org_id AND id = v_lease_id;
  END LOOP;

  UPDATE work.device_run_binding
    SET state = 'finished', revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'active';
  UPDATE work.device_run_binding
    SET state = 'canceled', revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND run_id = p_run_id AND state IN ('offered', 'ready');

  -- One signature per row: a Run may hold several runtime executions.
  FOR v_execution_id IN
    SELECT e.execution_id FROM work.runtime_execution e
    WHERE e.org_id = p_org_id AND e.run_id = p_run_id
      AND e.state NOT IN ('completed', 'revoked', 'expired')
  LOOP
    PERFORM work.revoke_runtime_execution(p_org_id, v_execution_id,
      COALESCE(v_reason, 'run_finished'));
  END LOOP;

  PERFORM work.append_audit(p_org_id, NULL, 'run.finish_local', 'run', p_run_id::text,
    jsonb_build_object('task_id', v_task.id, 'outcome', v_target,
      'terminal_reason', CASE WHEN v_run.state = 'cancel_requested'
                              THEN v_run.terminal_reason ELSE v_reason END));

  SELECT control_revision INTO v_run.control_revision FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  RETURN v_run.control_revision;
END;
$$;

-- ---------------------------------------------------------------------------
-- finish_local_run (control §6.4 steps 1-5, design §6.5).
--
-- Every refusal is decided BEFORE the terminal write, in this one function, so there
-- is no window in which a concurrent proposal could slip between the check and the
-- write. A rejected proposal still gets a device_run_finish row (state='rejected') -
-- that row is the evidence of what was refused and why, and the partial unique index
-- only constrains accepted rows.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.finish_local_run(
  p_org_id text,
  p_run_id uuid,
  p_finish_id uuid,
  p_lease_id uuid,
  p_binding_revision bigint,
  p_fence bigint,
  p_finish jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_checkpoint work.device_checkpoint%ROWTYPE;
  v_existing work.device_run_finish%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_outcome text;
  v_run_outcome text;
  v_reason text;
  v_reject text;
  v_set_hash text;
  v_max_seq bigint;
  v_receipt_through bigint;
  v_unresolved jsonb;
  v_terminal bigint;
  v_signed_hash text;
  v_server_signature text;
  v_response jsonb;
  v_version_id uuid;
  v_deliverable_ok boolean := true;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF NOT work.local_run_finish_valid(p_finish) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_outcome := p_finish ->> 'outcome';
  v_reason := p_finish ->> 'reason_code';
  IF v_outcome NOT IN ('completed', 'failed')
     OR COALESCE(p_finish ->> 'final_checkpoint_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_finish ->> 'final_operation_set_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_finish ->> 'device_signature', '') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_finish ->> 'final_checkpoint_seq', '') !~ '^[0-9]+$'
     OR COALESCE(p_finish ->> 'receipt_through_seq', '') !~ '^[0-9]+$'
     OR (v_outcome = 'completed' AND v_reason IS NOT NULL)
     OR (v_reason IS NOT NULL AND v_reason NOT IN
         ('no_deliverable', 'model_error', 'tool_limit', 'runtime_limit_exceeded',
          'runtime_unresumable', 'checkpoint_lost', 'input_missing')) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_signed_hash := work.sha256_text(p_finish ->> 'device_signature');

  -- Idempotency by (org, run, finish_id), never by outcome.
  SELECT * INTO v_existing FROM work.device_run_finish
    WHERE org_id = p_org_id AND run_id = p_run_id AND finish_id = p_finish_id;
  IF FOUND THEN
    IF v_existing.signed_payload_hash IS DISTINCT FROM v_signed_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'finish_id', p_finish_id, 'state', v_existing.state,
      'code', v_existing.reject_code,
      'terminal_run_revision', v_existing.terminal_run_revision,
      'expected_operation_set_hash', v_existing.final_operation_set_hash,
      'unresolved_operations', '[]'::jsonb,
      'server_signature', v_existing.server_signature, 'replayed', true);
  END IF;

  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF v_run.task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE id = v_run.task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  SELECT * INTO v_lease FROM work.execution_lease
    WHERE org_id = p_org_id AND id = p_lease_id FOR UPDATE;
  IF NOT FOUND OR v_lease.run_id <> p_run_id OR v_lease.state <> 'active'
     OR v_lease.expires_at <= now()
     OR v_lease.binding_revision IS DISTINCT FROM p_binding_revision THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id
      AND binding_revision = p_binding_revision FOR UPDATE;
  IF NOT FOUND OR v_binding.device_id <> v_lease.device_id
     OR v_binding.session_id <> v_lease.session_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = v_lease.device_id;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = v_lease.session_id;

  v_reject := NULL;
  v_set_hash := work.local_operation_set_hash(p_org_id, p_run_id);
  v_unresolved := '[]'::jsonb;

  -- 1. fence. An old fence is refused without writing any state.
  IF v_run.fence IS DISTINCT FROM p_fence OR v_lease.fence IS DISTINCT FROM p_fence THEN
    v_reject := 'stale_fence';
  END IF;

  -- 2. Task ownership and the cancel request.
  IF v_reject IS NULL THEN
    IF v_task.state <> 'open' OR v_task.active_run_id IS DISTINCT FROM p_run_id THEN
      v_reject := 'finish_precondition_failed';
    ELSIF v_run.state = 'cancel_requested' AND v_outcome = 'completed' THEN
      v_reject := 'run_cancel_requested';
    END IF;
  END IF;

  -- 3. checkpoint / receipt continuity / the recomputed operation-set hash.
  IF v_reject IS NULL THEN
    SELECT COALESCE(MAX(checkpoint_seq), -1) INTO v_max_seq
      FROM work.device_checkpoint
      WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'recorded';
    SELECT * INTO v_checkpoint FROM work.device_checkpoint
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND checkpoint_seq = (p_finish ->> 'final_checkpoint_seq')::bigint;
    SELECT COALESCE(MAX(seq), 0) INTO v_receipt_through FROM work.device_receipt
      WHERE org_id = p_org_id AND device_id = v_lease.device_id
        AND journal_epoch = v_session.journal_epoch;
    IF (p_finish ->> 'final_checkpoint_seq')::bigint IS DISTINCT FROM v_max_seq
       OR v_checkpoint.checkpoint_hash IS DISTINCT FROM
          (p_finish ->> 'final_checkpoint_hash')
       OR (p_finish ->> 'receipt_through_seq')::bigint IS DISTINCT FROM v_receipt_through
       OR v_checkpoint.receipt_through_seq > v_receipt_through
       OR (p_finish ->> 'final_operation_set_hash') IS DISTINCT FROM v_set_hash THEN
      v_reject := 'finish_state_mismatch';
      SELECT COALESCE(jsonb_agg(jsonb_build_object('operation_id', o.id,
                                                   'state', o.state)), '[]'::jsonb)
        INTO v_unresolved
      FROM work.operation o
      WHERE o.org_id = p_org_id AND o.run_id = p_run_id
        AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching',
                        'unknown', 'unresolved');
    END IF;
  END IF;

  -- 4. the completed gate, computed for THIS RUN only. task_has_blocking_operation is
  -- deliberately not used: it aggregates the whole Task and a previous Run's unknown
  -- would block this one forever. It stays in force for new-Run admission and acceptance.
  IF v_reject IS NULL AND v_outcome = 'completed' THEN
    IF EXISTS (
      SELECT 1 FROM work.operation o
      WHERE o.org_id = p_org_id AND o.run_id = p_run_id
        AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching',
                        'unknown', 'unresolved')
    ) OR EXISTS (
      SELECT 1 FROM work.device_dispatch d
      JOIN work.operation o ON o.id = d.operation_id AND o.org_id = d.org_id
      WHERE d.org_id = p_org_id AND o.run_id = p_run_id
        AND d.delivery_state IN ('pending', 'undelivered')
    ) THEN
      v_reject := 'finish_precondition_failed';
    ELSE
      -- Every deliverable must be a published local_only version of THIS Run.
      FOR v_version_id IN
        SELECT (x #>> '{}')::uuid
        FROM jsonb_array_elements(p_finish -> 'deliverable_versions') x
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM work.artifact_version av
          WHERE av.org_id = p_org_id AND av.version_id = v_version_id
            AND av.state = 'published' AND av.location = 'local_only'
            AND av.classification = 'local_only'
            AND av.provenance ->> 'run_id' = p_run_id::text
        ) THEN
          v_deliverable_ok := false;
        END IF;
      END LOOP;
      IF jsonb_array_length(p_finish -> 'deliverable_versions') = 0
         OR NOT v_deliverable_ok THEN
        v_reject := 'finish_precondition_failed';
      END IF;
    END IF;
  END IF;

  v_server_signature := 'sha256:' || work.sha256_text('run_finish|' || p_run_id::text
    || '|' || p_finish_id::text || '|' || v_outcome || '|'
    || COALESCE(v_reject, 'accepted') || '|' || v_set_hash);

  IF v_reject IS NOT NULL THEN
    INSERT INTO work.device_run_finish
      (org_id, run_id, finish_id, binding_revision, fence, lease_id, outcome,
       reason_code, final_checkpoint_seq, final_checkpoint_hash, receipt_through_seq,
       final_operation_set_hash, deliverable_versions, signed_payload_hash, state,
       reject_code, terminal_run_revision, server_signature)
    VALUES
      (p_org_id, p_run_id, p_finish_id, p_binding_revision, p_fence, p_lease_id,
       v_outcome, v_reason, (p_finish ->> 'final_checkpoint_seq')::bigint,
       p_finish ->> 'final_checkpoint_hash',
       (p_finish ->> 'receipt_through_seq')::bigint, v_set_hash,
       p_finish -> 'deliverable_versions', v_signed_hash, 'rejected', v_reject, NULL,
       v_server_signature);
    PERFORM work.append_audit(p_org_id, NULL, 'run.finish_local_rejected',
      'run', p_run_id::text,
      jsonb_build_object('finish_id', p_finish_id, 'code', v_reject,
        'expected_operation_set_hash', v_set_hash));
    RETURN jsonb_build_object('finish_id', p_finish_id, 'state', 'rejected',
      'code', v_reject, 'terminal_run_revision', NULL,
      'expected_operation_set_hash', v_set_hash, 'unresolved_operations', v_unresolved,
      'server_signature', v_server_signature, 'replayed', false);
  END IF;

  -- 5. the terminal write, through the dedicated local writer only.
  v_run_outcome := CASE v_outcome WHEN 'completed' THEN 'succeeded' ELSE 'failed' END;
  v_terminal := work.finish_local_run_state(p_org_id, p_run_id, v_run_outcome, v_reason);

  INSERT INTO work.device_run_finish
    (org_id, run_id, finish_id, binding_revision, fence, lease_id, outcome,
     reason_code, final_checkpoint_seq, final_checkpoint_hash, receipt_through_seq,
     final_operation_set_hash, deliverable_versions, signed_payload_hash, state,
     reject_code, terminal_run_revision, server_signature)
  VALUES
    (p_org_id, p_run_id, p_finish_id, p_binding_revision, p_fence, p_lease_id,
     v_outcome, v_reason, (p_finish ->> 'final_checkpoint_seq')::bigint,
     p_finish ->> 'final_checkpoint_hash',
     (p_finish ->> 'receipt_through_seq')::bigint, v_set_hash,
     p_finish -> 'deliverable_versions', v_signed_hash, 'accepted', NULL, v_terminal,
     v_server_signature);

  v_response := jsonb_build_object('finish_id', p_finish_id, 'state', 'accepted',
    'code', NULL, 'terminal_run_revision', v_terminal,
    'expected_operation_set_hash', v_set_hash, 'unresolved_operations', '[]'::jsonb,
    'server_signature', v_server_signature);
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- consume_device_ack (offset 4's landing: the one ack frame card E=B kept).
--
-- It writes ONLY the delivery watermark. B03 carrier §3.2: "唯一还在的 ack 确实不写任何
-- 业务事实". A lower revision never rolls the watermark back, and journal_row_missing
-- marks not_applicable rather than leaving the resolution unconfirmable forever.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.consume_device_ack(
  p_org_id text,
  p_device_id uuid,
  p_session_id uuid,
  p_acks jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_session work.device_session%ROWTYPE;
  v_element jsonb;
  v_resolution work.operation_resolution%ROWTYPE;
  v_resolve_id uuid;
  v_state text;
  v_applied jsonb := '[]'::jsonb;
  v_not_applicable jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_newer bigint;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF p_acks IS NULL OR jsonb_typeof(p_acks) <> 'array'
     OR jsonb_array_length(p_acks) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.device_id <> p_device_id OR v_session.state <> 'active'
     OR v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  FOR v_element IN SELECT * FROM jsonb_array_elements(p_acks) LOOP
    IF jsonb_typeof(v_element) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_element)) <> 2
       OR NOT v_element ?& ARRAY['resolve_id', 'state']
       OR COALESCE(v_element ->> 'resolve_id', '') !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(v_element ->> 'state', '') NOT IN
          ('applied', 'journal_row_missing', 'conflict') THEN
      RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
    END IF;
    v_resolve_id := (v_element ->> 'resolve_id')::uuid;
    v_state := v_element ->> 'state';

    SELECT * INTO v_resolution FROM work.operation_resolution
      WHERE org_id = p_org_id AND resolve_id = v_resolve_id FOR UPDATE;
    IF NOT FOUND THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'resolve_id', v_resolve_id, 'code', 'invalid_request'));
      CONTINUE;
    END IF;
    SELECT COALESCE(MAX(resolution_revision), 0) INTO v_newer
      FROM work.operation_resolution
      WHERE org_id = p_org_id AND operation_id = v_resolution.operation_id;
    IF v_newer > v_resolution.resolution_revision THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'resolve_id', v_resolve_id, 'code', 'idempotency_key_conflict'));
      CONTINUE;
    END IF;
    IF v_state = 'conflict' THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'resolve_id', v_resolve_id, 'code', 'idempotency_key_conflict'));
      CONTINUE;
    END IF;
    IF v_state = 'applied' THEN
      UPDATE work.operation_resolution
        SET resolution_delivery = 'acked', acked_at = now(),
            delivery_attempts = delivery_attempts + 1, updated_at = now()
        WHERE org_id = p_org_id AND resolve_id = v_resolve_id
          AND resolution_delivery <> 'acked';
      v_applied := v_applied || jsonb_build_array(v_resolve_id);
    ELSE
      UPDATE work.operation_resolution
        SET resolution_delivery = 'not_applicable',
            delivery_attempts = delivery_attempts + 1, updated_at = now()
        WHERE org_id = p_org_id AND resolve_id = v_resolve_id
          AND resolution_delivery <> 'acked';
      v_not_applicable := v_not_applicable || jsonb_build_array(v_resolve_id);
    END IF;
  END LOOP;

  PERFORM work.append_audit(p_org_id, NULL, 'device_ack.consumed',
    'device', p_device_id::text,
    jsonb_build_object('session_id', p_session_id,
      'applied', jsonb_array_length(v_applied),
      'not_applicable', jsonb_array_length(v_not_applicable),
      'conflicts', jsonb_array_length(v_conflicts)));
  RETURN jsonb_build_object('applied', v_applied, 'not_applicable', v_not_applicable,
    'conflicts', v_conflicts);
END;
$$;

-- ---------------------------------------------------------------------------
-- decide_local_approval (device design §4.3, control §4.2, design §15.2).
--
-- The proof is compared field by field with the HTTP/scalar values and the nonce is
-- consumed atomically (O-15 = jia: approval_decision.nonce + partial unique index).
-- A signature for "approve once" may not be replayed to widen the scope or change the
-- decision, which is what the nonce index and the params_hash CAS together enforce.
--
-- Remembering is only ever approved + readonly. Rejecting one action terminates the
-- whole Run with reason approval_rejected in run.terminal_reason (O-6 = jia), through
-- the same dedicated local terminal writer the finish path uses.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.decide_local_approval(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_approval_id uuid,
  p_client_request_id text,
  p_decision jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_approval work.approval%ROWTYPE;
  v_operation work.operation%ROWTYPE;
  v_action work.local_action%ROWTYPE;
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_grant work.workspace_grant%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_policy work.local_execution_policy%ROWTYPE;
  v_receipt jsonb;
  v_request_hash text;
  v_scope jsonb;
  v_decision text;
  v_remember boolean;
  v_expires timestamptz;
  v_grant_id uuid;
  v_response jsonb;
  v_existing_decision work.approval_decision%ROWTYPE;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_actor_subject_id, 'approval.decide',
    p_client_request_id);

  IF NOT work.approval_decision_proof_valid(p_decision) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_request_hash := work.sha256_text('approval.decide|' || p_approval_id::text
    || '|' || p_actor_subject_id || '|' || COALESCE(p_decision::text, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'approval.decide'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  v_decision := p_decision ->> 'decision';
  IF v_decision NOT IN ('approved', 'rejected')
     OR COALESCE(p_decision ->> 'params_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_decision ->> 'signature', '') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_decision ->> 'nonce', '') !~ '^[A-Za-z0-9_-]{8,128}$'
     OR COALESCE(p_decision ->> 'expected_revision', '') !~ '^[0-9]+$'
     OR COALESCE(p_decision ->> 'policy_epoch', '') !~ '^[0-9]+$'
     OR COALESCE(p_decision ->> 'access_epoch', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_remember := COALESCE((p_decision ->> 'remember_readonly')::boolean, false);
  v_scope := p_decision -> 'readonly_scope';
  IF v_decision = 'rejected' AND v_remember THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF NOT v_remember AND (v_scope IS NOT NULL AND jsonb_typeof(v_scope) <> 'null'
     OR (p_decision ->> 'readonly_expires_at') IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_remember AND (v_scope IS NULL OR jsonb_typeof(v_scope) <> 'object'
     OR (p_decision ->> 'readonly_expires_at') IS NULL) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  -- Every scalar the caller sent must equal the signed copy inside the proof.
  IF (p_decision ->> 'org_id') IS DISTINCT FROM p_org_id
     OR (p_decision ->> 'subject_id') IS DISTINCT FROM p_actor_subject_id
     OR (p_decision ->> 'auth_plane') IS DISTINCT FROM p_auth_plane
     OR (p_decision ->> 'auth_epoch')::bigint IS DISTINCT FROM p_auth_epoch
     OR (p_decision ->> 'approval_id') IS DISTINCT FROM p_approval_id::text THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT o.id, o.run_id INTO v_operation.id, v_operation.run_id
  FROM work.approval_operation ao
  JOIN work.operation o ON o.id = ao.operation_id AND o.org_id = ao.org_id
  WHERE ao.approval_id = p_approval_id AND ao.org_id = p_org_id;
  IF v_operation.id IS NULL THEN
    RAISE EXCEPTION 'approval_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = v_operation.run_id FOR UPDATE;
  SELECT * INTO v_task FROM work.task
    WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  IF v_task.deleted_at IS NOT NULL
     OR v_task.owner_subject_id <> p_actor_subject_id
     OR NOT EXISTS (
       SELECT 1 FROM work.member m
       WHERE m.org_id = p_org_id AND m.subject_id = p_actor_subject_id
         AND m.status = 'active' AND m.role <> 'viewer') THEN
    RAISE EXCEPTION 'approval_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_operation FROM work.operation
    WHERE org_id = p_org_id AND id = v_operation.id FOR UPDATE;
  SELECT * INTO v_action FROM work.local_action
    WHERE org_id = p_org_id AND operation_id = v_operation.id
    ORDER BY created_at LIMIT 1;
  IF (p_decision ->> 'operation_id') IS DISTINCT FROM v_operation.id::text THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  -- The current execution authority: the device session that carries this plane/epoch.
  SELECT * INTO v_session FROM work.device_session s
    WHERE s.org_id = p_org_id AND s.id = (p_decision ->> 'session_id')::uuid;
  IF NOT FOUND OR v_session.state <> 'active' OR v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_session.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM p_auth_epoch
     OR v_session.device_id::text IS DISTINCT FROM (p_decision ->> 'device_id')
     OR v_session.owner_subject_id IS DISTINCT FROM p_actor_subject_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_approval FROM work.approval
    WHERE org_id = p_org_id AND id = p_approval_id FOR UPDATE;
  IF v_approval.status <> 'pending' THEN
    -- A replay of the same client_request_id was already answered by the audit receipt
    -- above; a different request against an already-decided approval is not pending.
    RAISE EXCEPTION 'approval_not_pending' USING ERRCODE = 'P0001';
  END IF;
  IF v_approval.revision IS DISTINCT FROM
       (p_decision ->> 'expected_revision')::bigint
     OR v_approval.params_hash IS DISTINCT FROM (p_decision ->> 'params_hash')
     OR v_approval.expires_at <= now()
     OR (p_decision ->> 'expires_at')::timestamptz <= now() THEN
    RAISE EXCEPTION 'approval_stale_or_expired' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_policy FROM work.local_execution_policy WHERE org_id = p_org_id;
  IF (p_decision ->> 'policy_epoch')::bigint IS DISTINCT FROM v_policy.effective_epoch
     OR (p_decision ->> 'access_epoch')::bigint IS DISTINCT FROM
        v_run.admission_access_epoch THEN
    RAISE EXCEPTION 'approval_stale_or_expired' USING ERRCODE = 'P0001';
  END IF;
  -- The nonce is single-use across the whole organization, not just this approval.
  IF EXISTS (SELECT 1 FROM work.approval_decision
             WHERE org_id = p_org_id AND nonce = p_decision ->> 'nonce') THEN
    RAISE EXCEPTION 'approval_nonce_reused' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.approval
    SET status = v_decision, revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_approval_id;
  INSERT INTO work.approval_decision
    (approval_id, org_id, decision, actor_subject_id, params_hash, policy_epoch, nonce)
  VALUES
    (p_approval_id, p_org_id, v_decision, p_actor_subject_id,
     p_decision ->> 'params_hash', v_approval.policy_epoch, p_decision ->> 'nonce');

  v_grant_id := NULL;
  IF v_decision = 'approved' THEN
    UPDATE work.operation
      SET state = 'authorized', revision = revision + 1, updated_at = now()
      WHERE org_id = p_org_id AND id = v_operation.id;
    IF v_run.state = 'waiting' AND v_run.wait_reason = 'approval' THEN
      PERFORM work.resume_run(p_org_id, v_run.id);
    END IF;
    IF v_remember THEN
      -- Remembering is only ever readonly: the tool_set closed set excludes
      -- artifact.write and every model action, so a write can never be remembered.
      IF v_action.action_kind NOT IN ('workspace.list', 'workspace.read',
                                      'workspace.search') THEN
        RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_grant FROM work.workspace_grant
        WHERE org_id = p_org_id AND id = v_action.grant_id;
      -- The remembered scope must be exactly the scope that was approved: same grant,
      -- same revision, same selector, and a tool_set that contains this action and
      -- nothing outside the three readonly kinds. A proof may not widen it.
      IF jsonb_typeof(v_scope -> 'tool_set') <> 'array'
         OR jsonb_array_length(v_scope -> 'tool_set') = 0
         OR NOT work.text_array_closed_unique(
              ARRAY(SELECT jsonb_array_elements_text(v_scope -> 'tool_set')),
              ARRAY['workspace.list', 'workspace.read', 'workspace.search'])
         OR NOT (v_action.action_kind = ANY(
              ARRAY(SELECT jsonb_array_elements_text(v_scope -> 'tool_set'))))
         OR COALESCE(v_scope ->> 'resource_selector_hash', '') !~ '^[0-9a-f]{64}$'
         OR (v_scope ->> 'resource_selector_hash') IS DISTINCT FROM
            v_action.resource_selector_hash
         OR (v_scope ->> 'grant_id') IS DISTINCT FROM v_action.grant_id::text
         OR COALESCE(v_scope ->> 'grant_revision', '') !~ '^[0-9]+$'
         OR (v_scope ->> 'grant_revision')::bigint IS DISTINCT FROM
            v_action.grant_revision THEN
        RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
      END IF;
      v_expires := LEAST(now() + interval '24 hours', v_grant.expires_at,
        (p_decision ->> 'readonly_expires_at')::timestamptz);
      IF v_expires <= now() THEN
        RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
      END IF;
      INSERT INTO work.readonly_approval_grant
        (org_id, owner_subject_id, run_id, device_id, workspace_grant_id,
         grant_revision, tool_set, resource_selector_hash, policy_epoch, access_epoch,
         approval_id, expires_at, status)
      VALUES
        (p_org_id, p_actor_subject_id, v_run.id, v_session.device_id, v_grant.id,
         v_grant.grant_revision,
         ARRAY(SELECT jsonb_array_elements_text(v_scope -> 'tool_set')),
         v_scope ->> 'resource_selector_hash', v_policy.effective_epoch,
         v_run.admission_access_epoch, p_approval_id, v_expires, 'active')
      RETURNING id INTO v_grant_id;
    END IF;
  ELSE
    UPDATE work.operation
      SET state = 'canceled', revision = revision + 1, updated_at = now()
      WHERE org_id = p_org_id AND id = v_operation.id;
    -- Rejecting one action ends this Run (control §5). Other undispatched actions are
    -- cancelled by the same terminal path; dispatched ones stay for reconciliation.
    PERFORM work.finish_local_run_state(p_org_id, v_run.id, 'canceled',
      'approval_rejected');
  END IF;

  PERFORM work.append_task_event(p_org_id, v_task.id, 'approval.decided',
    jsonb_build_object('approval_id', p_approval_id,
      'operation_id', v_operation.id, 'decision', v_decision,
      'readonly_grant_id', v_grant_id));
  v_response := jsonb_build_object('approval_id', p_approval_id,
    'operation_id', v_operation.id, 'decision', v_decision,
    'approval_revision', v_approval.revision + 1,
    'readonly_grant_id', v_grant_id, 'run_id', v_run.id);
  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'approval.decide',
    'approval', p_approval_id::text,
    jsonb_build_object('request_id', p_client_request_id,
      'request_hash', v_request_hash, 'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- revoke_readonly_grant and its read face (design §15.2).
--
-- Revoking does NOT cancel already-dispatched actions: those are reconciled, exactly
-- as control §6.3 says for directory revocation. The read face keeps expired and
-- revoked rows visible, because the audit question is "which grant exempted this
-- action from approval", and that question outlives the grant.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.revoke_readonly_grant(
  p_org_id text,
  p_actor_subject_id text,
  p_grant_id uuid,
  p_client_request_id text,
  p_expected_revision bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_grant work.readonly_approval_grant%ROWTYPE;
  v_receipt jsonb;
  v_request_hash text;
  v_response jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  PERFORM work.lock_request_key(p_org_id, p_actor_subject_id, 'readonly_grant.revoke',
    p_client_request_id);

  v_request_hash := work.sha256_text('readonly_grant.revoke|' || p_grant_id::text
    || '|' || p_actor_subject_id || '|' || COALESCE(p_expected_revision::text, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'readonly_grant.revoke'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_grant FROM work.readonly_approval_grant
    WHERE org_id = p_org_id AND id = p_grant_id FOR UPDATE;
  IF NOT FOUND OR v_grant.owner_subject_id <> p_actor_subject_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_grant.status <> 'active' THEN
    RAISE EXCEPTION 'invalid_transition:readonly_approval_grant:not_active'
      USING ERRCODE = '23514';
  END IF;
  IF v_grant.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.readonly_approval_grant
    SET status = 'revoked', revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_grant_id;

  v_response := jsonb_build_object('grant_id', p_grant_id, 'status', 'revoked',
    'revision', v_grant.revision + 1);
  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'readonly_grant.revoke',
    'readonly_approval_grant', p_grant_id::text,
    jsonb_build_object('request_id', p_client_request_id,
      'request_hash', v_request_hash, 'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

CREATE FUNCTION work.list_readonly_grants(
  p_org_id text,
  p_actor_subject_id text,
  p_run_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  -- A definer read face, like list_devices / list_workspace_grants: M1a grants no table
  -- privilege at all, so a plain SELECT would be unreachable for work_api.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', g.id, 'owner_subject_id', g.owner_subject_id, 'run_id', g.run_id,
      'device_id', g.device_id, 'workspace_grant_id', g.workspace_grant_id,
      'grant_revision', g.grant_revision, 'tool_set', to_jsonb(g.tool_set),
      'resource_selector_hash', g.resource_selector_hash,
      'policy_epoch', g.policy_epoch, 'access_epoch', g.access_epoch,
      'approval_id', g.approval_id, 'expires_at', g.expires_at, 'status', g.status,
      'consumed_count', g.consumed_count, 'revision', g.revision,
      'created_at', g.created_at, 'updated_at', g.updated_at)
    ORDER BY g.created_at), '[]'::jsonb)
    INTO v_result
  FROM work.readonly_approval_grant g
  WHERE g.org_id = p_org_id
    AND (p_run_id IS NULL OR g.run_id = p_run_id)
    AND g.owner_subject_id = p_actor_subject_id;
  RETURN jsonb_build_object('grants', v_result);
END;
$$;

-- ---------------------------------------------------------------------------
-- The audit-receipt index, extended to the two new key-taking work_api commands.
-- A partial unique index cannot be CREATE OR REPLACE'd, so this is DROP + CREATE with
-- the previous four actions kept verbatim. Rows whose metadata has no request_id (the
-- whole R0a decide_approval path) stay NULL and therefore stay distinct - the R0a
-- behaviour is unchanged.
-- ---------------------------------------------------------------------------
DROP INDEX work.work_audit_device_command_receipt;

CREATE UNIQUE INDEX work_audit_device_command_receipt
  ON work.audit_event (org_id, actor_subject_id, action, (metadata ->> 'request_id'))
  WHERE action IN ('device.pair.confirm', 'device.revoke', 'workspace_grant.revoke',
                   'run.workspace_rebind', 'approval.decide', 'readonly_grant.revoke');

-- ---------------------------------------------------------------------------
-- issue_operation_resolution, restated (O-10 = jia, design §15.3 item 2).
--
-- This body is the effective 0041 catalog body with exactly two blocks replaced: the
-- evidence_unavailable attestation pair and the evidence_exhausted attestation triple.
-- Everything else - the replay/conflict rules, the "not terminal" versus
-- unknown/unresolved preconditions, the evidence-exists refusals, the whitelist
-- intersection with exactly one candidate, the delivery_state and settlement_state
-- derivations, the reconcile -> input wait rewrite, the events and the return shape -
-- is carried over unchanged, because a restatement that quietly dropped one of them
-- would rewrite a shipped conclusion.
--
-- #87: CREATE OR REPLACE inherits neither SECURITY DEFINER nor search_path, so both are
-- restated in this same statement.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- issue_operation_resolution, restated (O-10 = jia, design §15.3 item 2).
--
-- This body is the effective 0041 catalog body with exactly two blocks replaced: the
-- evidence_unavailable attestation pair and the evidence_exhausted attestation triple.
-- Everything else - the replay/conflict rules, the "not terminal" versus
-- unknown/unresolved preconditions, the evidence-exists refusals, the whitelist
-- intersection with exactly one candidate, the delivery_state and settlement_state
-- derivations, the reconcile -> input wait rewrite, the events and the return shape -
-- is carried over unchanged, because a restatement that quietly dropped one of them
-- would rewrite a shipped conclusion.
--
-- #87: CREATE OR REPLACE inherits neither SECURITY DEFINER nor search_path, so both are
-- restated in this same statement.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- issue_operation_resolution, restated (O-10 = jia, design §15.3 item 2).
--
-- This body is the effective 0041 catalog body with exactly two blocks replaced: the
-- evidence_unavailable attestation pair and the evidence_exhausted attestation triple.
-- Everything else - the replay/conflict rules, the "not terminal" versus
-- unknown/unresolved preconditions, the evidence-exists refusals, the whitelist
-- intersection with exactly one candidate, the delivery_state and settlement_state
-- derivations, the reconcile -> input wait rewrite, the events and the return shape -
-- is carried over unchanged, because a restatement that quietly dropped one of them
-- would rewrite a shipped conclusion.
--
-- #87: CREATE OR REPLACE inherits neither SECURITY DEFINER nor search_path, so both are
-- restated in this same statement.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- issue_operation_resolution, restated (O-10 = jia, design §15.3 item 2).
--
-- This body is the effective 0041 catalog body with exactly two blocks replaced: the
-- evidence_unavailable attestation pair and the evidence_exhausted attestation triple.
-- Everything else - the replay/conflict rules, the "not terminal" versus
-- unknown/unresolved preconditions, the evidence-exists refusals, the whitelist
-- intersection with exactly one candidate, the delivery_state and settlement_state
-- derivations, the reconcile -> input wait rewrite, the events and the return shape -
-- is carried over unchanged, because a restatement that quietly dropped one of them
-- would rewrite a shipped conclusion.
--
-- #87: CREATE OR REPLACE inherits neither SECURITY DEFINER nor search_path, so both are
-- restated in this same statement.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- issue_operation_resolution, restated (O-10 = jia, design §15.3 item 2).
--
-- This body is the effective 0041 catalog body with exactly two blocks replaced: the
-- evidence_unavailable attestation pair and the evidence_exhausted attestation triple.
-- Everything else - the replay/conflict rules, the "not terminal" versus
-- unknown/unresolved preconditions, the evidence-exists refusals, the whitelist
-- intersection with exactly one candidate, the delivery_state and settlement_state
-- derivations, the reconcile -> input wait rewrite, the events and the return shape -
-- is carried over unchanged, because a restatement that quietly dropped one of them
-- would rewrite a shipped conclusion.
--
-- #87: CREATE OR REPLACE inherits neither SECURITY DEFINER nor search_path, so both are
-- restated in this same statement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work.issue_operation_resolution(
  p_org_id text, p_operation_id uuid, p_state text, p_code text, p_ticket_id text, p_signature text, p_actor_subject_id text, p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_task_id uuid;
  operation_row work.operation%ROWTYPE;
  run_row work.run%ROWTYPE;
  gate_row work.dispatch_delivery%ROWTYPE;
  v_next_revision bigint;
  v_latest work.operation_resolution%ROWTYPE;
  v_settlement text;
  v_delivery text;
  v_target text;
  v_candidates int;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_state NOT IN ('succeeded', 'failed', 'canceled', 'rejected_not_executed',
                     'undelivered', 'sealed_not_sent') THEN
    RAISE EXCEPTION 'invalid_request:state' USING ERRCODE = '22023';
  END IF;
  IF p_code IS NOT NULL
     AND p_code NOT IN ('evidence_unavailable', 'evidence_exhausted') THEN
    RAISE EXCEPTION 'invalid_request:code' USING ERRCODE = '22023';
  END IF;
  IF p_signature IS NULL OR p_signature !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request:signature' USING ERRCODE = '22023';
  END IF;

  -- Lock order per §4.3: Task, Run, Operation.
  SELECT r.task_id INTO v_task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task WHERE id = v_task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO run_row FROM work.run
  WHERE id = (SELECT run_id FROM work.operation WHERE id = p_operation_id)
    AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO operation_row FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;

  -- Resolutions exist for local Runs only (control §4.1 "仅本机 Run 使用"), and
  -- step_key is what marks a row as belonging to a local step.
  IF operation_row.step_key IS NULL THEN
    RAISE EXCEPTION 'operation_not_local' USING ERRCODE = 'P0001';
  END IF;

  -- The delivery fact is read once, here, and reused for both the precondition below
  -- and the delivery_state the frame reports: the same row must not be able to mean
  -- "already dispatched" to one check and "delivered" to the other.
  SELECT * INTO gate_row
  FROM work.dispatch_delivery
  WHERE org_id = p_org_id AND operation_id = p_operation_id;

  -- "同 Operation 仅终态变化才新签发" (§4.1) and "迟到核账不改已签发结论" are one rule
  -- read two ways: the newest row may be replayed, a verdict that repeats it changes
  -- nothing, and a *different* verdict arriving late is a conflict rather than a new
  -- revision of the same conclusion. Checked before the state preconditions because
  -- after any resolution lands the Operation is terminal, so every other guard would
  -- otherwise mask this answer with operation_not_reconcilable.
  SELECT * INTO v_latest
  FROM work.operation_resolution
  WHERE org_id = p_org_id AND operation_id = p_operation_id
  ORDER BY resolution_revision DESC
  LIMIT 1;
  IF FOUND THEN
    IF v_latest.state = p_state
       AND v_latest.code IS NOT DISTINCT FROM p_code THEN
      IF v_latest.signature = p_signature THEN
        RETURN jsonb_build_object('resolve_id', v_latest.resolve_id,
                                  'resolution_revision', v_latest.resolution_revision,
                                  'settlement_state', v_latest.settlement_state,
                                  'delivery_state', v_latest.delivery_state,
                                  'replayed', true);
      END IF;
      -- Same verdict, different signature: two claims about one conclusion.
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF v_latest.code IS NOT NULL OR p_code IS NOT NULL THEN
      -- A downgrade is signed at most once per Operation, in either direction: after
      -- one has been issued no further conclusion may be dressed up as a second
      -- revision, and an already-settled Operation may not be downgraded retroactively.
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_code IS NULL THEN
    -- A settlement verdict may only be issued against an Operation that has not been
    -- settled: a terminal row has nothing left to conclude. Deliberately expressed as
    -- "not terminal" rather than a short allow-list: §4.2 names seal, reject, settle
    -- and undelivered as this command's triggers, and those four arrive on Operations
    -- in prepared / waiting_approval / authorized as well as dispatching / unknown.
    -- Listing only the last three made ('sealed_not_sent','canceled') and
    -- ('canceled','canceled') unissuable - dead mapping rows and an unimplementable
    -- verdict - while realizability is already enforced by the whitelist intersection
    -- below, which is the check that actually means something.
    IF operation_row.state IN ('succeeded', 'failed', 'canceled', 'reconciled') THEN
      RAISE EXCEPTION 'operation_not_reconcilable' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- Shared precondition 1 for the side-effect path and 2 for the read-only one.
    IF operation_row.state NOT IN ('unknown', 'unresolved') THEN
      RAISE EXCEPTION 'operation_not_reconcilable' USING ERRCODE = 'P0001';
    END IF;
    -- Gate facts are checked on *both* degradation paths, not only the read-only one.
    -- For evidence_unavailable the presence of a dispatch row is the disproof of
    -- precondition (1) (an action that was never dispatched cannot have an external
    -- side effect); for evidence_exhausted it is precondition (2) failing - a gate row
    -- is a server-side authoritative fact about what happened, so the case is
    -- settleable, not downgradable, and the sealed_not_sent / consumed /
    -- receipt_recorded states are exactly the evidence §4.2 forbids skipping.
    IF gate_row.operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'resolution_evidence_exists' USING ERRCODE = 'P0001';
    END IF;
    IF p_code = 'evidence_unavailable' THEN
      IF operation_row.kind <> 'tool' THEN
        RAISE EXCEPTION 'evidence_unavailable_scope_denied' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    -- Precondition 5 for the read-only path and 2 for the side-effect one: no
    -- server-side authority fact may be left unread. Anything present means the case
    -- is reconcilable, not downgradable.
    IF EXISTS (
      SELECT 1 FROM work.operation_usage_fact f
      WHERE f.org_id = p_org_id AND f.operation_id = p_operation_id
    ) OR operation_row.usage_recorded_at IS NOT NULL THEN
      RAISE EXCEPTION 'resolution_evidence_exists' USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(operation_row.provider_request_id, '') <> ''
       OR COALESCE(operation_row.receipt_ref, '') <> '' THEN
      RAISE EXCEPTION 'resolution_evidence_exists' USING ERRCODE = 'P0001';
    END IF;
    IF p_code = 'evidence_unavailable' THEN
      -- Preconditions (3) and (4) of the read-only path, last because the server's own
      -- facts are the cheaper and more informative refusal.
      -- O-10 = jia (0042): the lease/revocation half is now a TABLE READ over the
      -- execution_lease and device rows 0040 landed, so an operator can no longer
      -- attest a fact the server can check itself. The journal half stays an
      -- attestation: the journal lives in the device's SQLite (device design §6.1)
      -- and the server has no way to read it.
      IF NOT (
        EXISTS (
          SELECT 1 FROM work.execution_lease l
          WHERE l.org_id = p_org_id AND l.run_id = operation_row.run_id
            AND (l.state <> 'active' OR l.expires_at <= now())
        )
        OR EXISTS (
          SELECT 1 FROM work.device d
          JOIN work.device_run_binding b
            ON b.device_id = d.id AND b.org_id = d.org_id
          WHERE d.org_id = p_org_id AND b.run_id = operation_row.run_id
            AND d.status = 'revoked'
        )
      ) THEN
        RAISE EXCEPTION 'resolution_preconditions_unattested' USING ERRCODE = 'P0001';
      END IF;
      IF (p_evidence ->> 'journal_unavailable') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'resolution_preconditions_unattested' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF p_code = 'evidence_exhausted' THEN
      -- Preconditions 3 and 4 of the side-effect path. A missing ticket is a malformed
      -- request, not a cursor problem: the ticket is J38's external visibility control
      -- and may not be invented on the spot.
      IF COALESCE(btrim(p_ticket_id), '') = '' THEN
        RAISE EXCEPTION 'invalid_request:ticket_id' USING ERRCODE = '22023';
      END IF;
      -- O-10 = jia (0042): device_unreachable becomes a read of device_session over
      -- this Run's binding, and the lease/revocation fact is the same read as above.
      -- seal_checked is DELETED, not replaced: device_run_seal was moved out by card
      -- E=B, so keeping the key would let a downgrade pass on an attestation about a
      -- table that will never exist.
      -- "Unreachable" means NO active session, so the refusal fires when one EXISTS.
      IF EXISTS (
        SELECT 1 FROM work.device_session s
        JOIN work.device_run_binding b
          ON b.session_id = s.id AND b.org_id = s.org_id
        WHERE s.org_id = p_org_id AND b.run_id = operation_row.run_id
          AND s.state = 'active' AND s.expires_at > now()
      ) THEN
        RAISE EXCEPTION 'resolution_preconditions_unattested' USING ERRCODE = 'P0001';
      END IF;
      IF NOT (
        EXISTS (
          SELECT 1 FROM work.execution_lease l
          WHERE l.org_id = p_org_id AND l.run_id = operation_row.run_id
            AND (l.state <> 'active' OR l.expires_at <= now())
        )
        OR EXISTS (
          SELECT 1 FROM work.device d
          JOIN work.device_run_binding b
            ON b.device_id = d.id AND b.org_id = d.org_id
          WHERE d.org_id = p_org_id AND b.run_id = operation_row.run_id
            AND d.status = 'revoked'
        )
      ) THEN
        RAISE EXCEPTION 'resolution_preconditions_unattested' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- The Operation's own state comes from the whitelist mapping intersected with the
  -- registered edges out of its current state - never from the settlement vocabulary.
  -- Zero or several candidates are both refusals: picking one would be guessing.
  SELECT min(m.operation_state), count(*) INTO v_target, v_candidates
  FROM work.resolution_state_map m
  JOIN work.state_transition e
    ON e.entity = 'operation' AND e.from_state = operation_row.state
   AND e.to_state = m.operation_state
  WHERE m.resolution_state = p_state;
  IF v_target IS NULL OR v_candidates <> 1
     OR (p_code IS NOT NULL AND v_target <> 'reconciled') THEN
    RAISE EXCEPTION 'resolution_target_unreachable' USING ERRCODE = 'P0001';
  END IF;

  -- delivery_state is the gate's own state rather than "a row exists": §4.1 takes the
  -- device_dispatch vocabulary here, and sealed_not_sent means precisely "never
  -- delivered". Reporting it as delivered would tell the device to close a journal row
  -- for an action the server itself recorded as unsent.
  v_delivery := CASE
    WHEN gate_row.gate_state IS NULL THEN 'not_applicable'
    WHEN gate_row.gate_state = 'sealed_not_sent' THEN 'undelivered'
    ELSE 'delivered'
  END;

  -- §4.1: settlement_state takes quota_reservation.state's same closed set and the
  -- frame only echoes the server ledger fact - the device does not decide it. Both
  -- degradation paths pin it to 'unknown' per §4.2, because the reservation is left
  -- exactly where it is (invariant 2: no evidence is not proof of non-execution, and
  -- release_quota would refuse to release a non-held row anyway). Only the settlement
  -- path reads the ledger, and it reads the newest reservation: a supersede chain
  -- leaves several rows per Operation (UNIQUE (operation_id, reservation_seq),
  -- 0002:281) and the current fact is the highest seq. No reservation at all is
  -- reported as 'unknown' rather than 'settled' - there is no row to echo, and
  -- claiming a settlement the ledger cannot show is the failure this column exists
  -- to prevent.
  IF p_code IS NOT NULL THEN
    v_settlement := 'unknown';
  ELSE
    SELECT q.state INTO v_settlement
    FROM work.quota_reservation q
    WHERE q.org_id = p_org_id AND q.operation_id = p_operation_id
    ORDER BY q.reservation_seq DESC
    LIMIT 1;
    v_settlement := COALESCE(v_settlement, 'unknown');
  END IF;

  SELECT COALESCE(MAX(resolution_revision), 0) + 1 INTO v_next_revision
  FROM work.operation_resolution
  WHERE org_id = p_org_id AND operation_id = p_operation_id;

  INSERT INTO work.operation_resolution
    (org_id, run_id, operation_id, resolution_revision, resolve_id, attempt_id,
     state, delivery_state, code, usage_source, settlement_state, signature,
     evidence, ticket_id)
  VALUES
    (p_org_id, operation_row.run_id, p_operation_id, v_next_revision,
     gen_random_uuid(), operation_row.dispatch_attempt_id, p_state,
     v_delivery, p_code,
     CASE WHEN p_code IS NULL THEN NULL ELSE 'unavailable' END,
     v_settlement, p_signature,
     p_evidence || jsonb_build_object(
       'operation_state_before', operation_row.state,
       'operation_state_after', v_target,
       'reservation_held', EXISTS (SELECT 1 FROM work.quota_reservation q
                                   WHERE q.org_id = p_org_id AND q.operation_id = p_operation_id
                                     AND q.state = 'held'),
       'reservations', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                     'seq', q.reservation_seq, 'state', q.state)
                                   ORDER BY q.reservation_seq)
                                FROM work.quota_reservation q
                                WHERE q.org_id = p_org_id
                                  AND q.operation_id = p_operation_id), '[]'::jsonb)),
     NULLIF(btrim(COALESCE(p_ticket_id, '')), ''));

  -- The target came from the whitelist intersection above, so the transition trigger
  -- cannot refuse it. Writing 'failed' here because the settlement said failed is the
  -- mistake this whole path exists to prevent.
  UPDATE work.operation
  SET state = v_target, revision = revision + 1, updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;

  -- §6.4/§4.2: the Run's wait reason is rewritten from reconcile to input, not
  -- cleared, and control_revision rises while fence stays put (same convention as
  -- the effective resume_run at baseline 0002:2096-2107).
  IF run_row.state = 'waiting' AND run_row.wait_reason = 'reconcile' THEN
    UPDATE work.run
    SET wait_reason = 'input', control_revision = control_revision + 1, updated_at = now()
    WHERE id = run_row.id AND org_id = p_org_id;
  END IF;

  PERFORM work.append_task_event(
    p_org_id, v_task_id,
    CASE WHEN v_target = 'reconciled' THEN 'operation.reconciled' ELSE 'operation.settled' END,
    jsonb_build_object('operation_id', p_operation_id, 'state', p_state,
                       'operation_state', v_target,
                       'code', p_code, 'settlement_state', v_settlement,
                       'delivery_state', v_delivery)
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'operation.resolution_issued',
    'operation', p_operation_id::text,
    jsonb_build_object('state', p_state, 'operation_state', v_target, 'code', p_code,
                       'ticket_id', NULLIF(btrim(COALESCE(p_ticket_id, '')), ''),
                       'resolution_revision', v_next_revision,
                       'settlement_state', v_settlement,
                       'delivery_state', v_delivery,
                       'evidence', p_evidence)
  );
  RETURN jsonb_build_object(
    'resolve_id', (SELECT resolve_id FROM work.operation_resolution
                   WHERE org_id = p_org_id AND operation_id = p_operation_id
                     AND resolution_revision = v_next_revision),
    'resolution_revision', v_next_revision,
    'operation_state', v_target,
    'settlement_state', v_settlement,
    'delivery_state', v_delivery,
    'replayed', false
  );
END;
$$;





-- ---------------------------------------------------------------------------
-- Privileges. No table privilege is granted to any runtime role (0024 precedent): the
-- only way in is a definer command. Every new function is revoked from PUBLIC, and only
-- the commands a runtime role actually calls get an EXECUTE grant.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION work.device_dispatch_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.enforce_delivery_state_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.deliverable_versions_valid(jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.local_action_prepare_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.device_permit_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.device_receipt_element_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.device_receipt_batch_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.local_run_finish_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.approval_decision_proof_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.local_operation_set_hash(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.prepare_local_operation(
  text, uuid, uuid, uuid, uuid, bigint, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.consume_device_permit(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.record_device_receipt(text, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.finish_local_run_state(text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.finish_local_run(
  text, uuid, uuid, uuid, bigint, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.consume_device_ack(text, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.decide_local_approval(
  text, text, text, bigint, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.revoke_readonly_grant(
  text, text, uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.list_readonly_grants(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.issue_operation_resolution(
  p_org_id text, p_operation_id uuid, p_state text, p_code text, p_ticket_id text, p_signature text, p_actor_subject_id text, p_evidence jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION work.prepare_local_operation(
  text, uuid, uuid, uuid, uuid, bigint, bigint, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.consume_device_permit(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.record_device_receipt(
  text, uuid, uuid, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.finish_local_run_state(
  text, uuid, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.finish_local_run(
  text, uuid, uuid, uuid, bigint, bigint, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.consume_device_ack(
  text, uuid, uuid, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.decide_local_approval(
  text, text, text, bigint, uuid, text, jsonb) TO work_api;
GRANT EXECUTE ON FUNCTION work.revoke_readonly_grant(
  text, text, uuid, text, bigint) TO work_api;
GRANT EXECUTE ON FUNCTION work.list_readonly_grants(
  text, text, uuid) TO work_api;
-- The restated resolution command keeps exactly the grantees it already had: the 0041
-- catalog records EXECUTE for work_owner and work_worker, and CREATE OR REPLACE
-- preserves privileges. The worker grant is restated explicitly so the ACL is readable
-- from this increment alone rather than only from the previous catalog.
GRANT EXECUTE ON FUNCTION work.issue_operation_resolution(
  p_org_id text, p_operation_id uuid, p_state text, p_code text, p_ticket_id text,
  p_signature text, p_actor_subject_id text, p_evidence jsonb) TO work_worker;


REVOKE ALL ON TABLE work.local_action FROM PUBLIC;
REVOKE ALL ON TABLE work.local_action FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.device_dispatch FROM PUBLIC;
REVOKE ALL ON TABLE work.device_dispatch FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.device_receipt FROM PUBLIC;
REVOKE ALL ON TABLE work.device_receipt FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.device_run_finish FROM PUBLIC;
REVOKE ALL ON TABLE work.device_run_finish FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;

RESET ROLE;
