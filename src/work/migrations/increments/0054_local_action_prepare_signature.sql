-- 0054: local action prepare real-signature reconciliation (M3 gateway GW13, P0 #1).
--
-- The device agent signs the action_prepare body with a real ES256 signature: fixed
-- 64-byte R||S, base64url without padding (86 characters), over
-- JCS({schema_version:2, type:"action_prepare", body}) with body.signature stripped
-- (device-design §3.1 action_prepare row). Until now prepare_local_operation only
-- shape-checked a `sha256:<64hex>` PLACEHOLDER (0042:757) because plpgsql cannot verify
-- ES256 (pgcrypto has no ECDSA verify); the cryptographic check is the Go gateway's job
-- (0040:1135, 0048 receipt precedent, 0053 finish precedent). The gateway verifies the
-- frame signature against the in-DB device key (0047 device_signing_key) BEFORE calling
-- this command, then translates the wire body into the 20-key element this command
-- consumes. This increment reconciles the SQL shape with the real signature so a genuine
-- device action_prepare is no longer rejected as invalid_request.
--
-- One change, keeping the shipped judgment order intact:
--   * prepare_local_operation: CREATE OR REPLACE restating every 0042 check verbatim,
--     changing ONLY the device_signature shape from the placeholder
--     `^sha256:[0-9a-f]{64}$` to the real ES256 form `^[A-Za-z0-9_-]{86}$`. The command
--     still binds device/session/lease/fence/binding/checkpoint, keeps (org,run,logical_key)
--     as the idempotency authority (O-9 = jia), evaluates the (A) destination gate from
--     server facts, runs the supersede invariants and the 14-key assertion shape, hits the
--     readonly grant branch or creates the Approval, and reserves no quota (O-14 = jia).
--     It does NOT verify the cryptography (the gateway does, before calling). CREATE OR
--     REPLACE preserves privileges but inherits neither SECURITY DEFINER nor search_path,
--     so both are restated in the body (0041:17-19 house rule). The work_worker EXECUTE
--     grant from 0042 is preserved by CREATE OR REPLACE (0046/0048 precedent).
--
-- Wire rulings landed with this increment (主签 2026-11-17 单选; device-design §3.1 is
-- annotated in place and its original text preserved verbatim):
--   * action_prepare's closed body gains `lease_id` and `fence`. The design row listed
--     neither, yet the command requires p_lease_id (purpose='execute', 0042:855-861) and
--     compares p_fence against BOTH run.fence and lease.fence before raising stale_fence
--     (0042:862-864). Deriving them server-side would turn that gate into an identity and
--     remove the only refusal a stale-fence device can receive, so the device names the
--     lease it is acting under, exactly as run_finish and checkpoint_commit already do.
--   * action_prepared's closed downlink body is the command's 13 response keys plus
--     `signature` (14); the internal `replayed` marker is not carried (0053 precedent).
--     The design row listed four keys, but `attempt_id` is a required argument of
--     consume_device_permit, so the four-key row left the next step uncallable.
--   * `supersede_no` is not a new frame key: the command enforces
--     logical_key = step_key || '#' || supersede_no (0042:774), so the gateway derives it
--     from the logical_key the device already sends.
--
-- NOT in this increment (ruled direction, next batch): the 28-key SignedPermit has no
-- minter. consume_device_permit takes p_permit as an INPUT and echoes it (0042:1516),
-- while work_worker has no SELECT on local_action / workspace_grant / device_session /
-- device_dispatch, so the gateway cannot build it; and device-design §3.3 requires
-- signing AFTER the dispatch CAS, with only the winner holding a deliverable permit.
-- The ruling is to restate consume_device_permit to mint internally (drop p_permit) and
-- to add an independent permit signing key distributed as hello_ack `permit_public_jwk`.
-- Neither is implemented here, and no permit/command frame is served yet. The device's
-- SignedPermit also still carries unix-second timestamps and omits a null destination_id,
-- both incompatible with the 28-key RFC3339 body SQL demands; that alignment belongs to
-- the same next batch.
--
-- No new public error code is registered: every code this command raises is already in
-- contracts/error-codes.json db_exception_map, and the first raising endpoint here is the
-- gRPC device plane, not the HTTP public API (the catalog's public set is HTTP vocabulary;
-- 0051/0053 precedent). No table privilege is granted.

SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.prepare_local_operation(
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
     OR COALESCE(p_action ->> 'device_signature', '') !~ '^[A-Za-z0-9_-]{86}$'
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

RESET ROLE;
