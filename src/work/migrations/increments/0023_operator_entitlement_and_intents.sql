-- 0023: producers for the operator suspension and for the cancellation intents.
--
-- Authority: control design §3.3 (P2/P4/P5/P6), §3.4 (operator denys release on their
-- own rule and on nobody else's), §6.1 (the intent row §6.1 has always required, and the
-- `mark_members_absent` sentence that asks for it), §1.4 line 87 (the operator face, 202,
-- dedicated identity). Validation exit: EV96 (the Apply rules themselves - P4's "no deny
-- from a ceiling change", P5's unacknowledged second command, P6's restore that must not
-- release other sources) and EV76 (Host archive/restore versus operator_suspended) are the
-- gates that name this surface, and both are still unexecuted - the guards added with this
-- increment are DB-level, not evidence.
--
-- Two obligations existed with no producer:
--
--   * `work.org.operator_suspended` is what the execution surfaces read - `submit_task`
--     (0002:1550, replaced by 0005:92, replaced by 0015:118), the trigger
--     `enforce_org_execution` (0002:2685-2722), `authorize_runtime_capability`
--     (0010:356) and the guard `assert_org_execution_enabled` (0009:123-136, whose body
--     0022 replaced) - but the only writes to it anywhere in the chain were in tests.
--     0002:3882 records the intent - "operator_suspended 只由运维停用路径设置，目录同步不得
--     覆盖" - and that path was a bare UPDATE: no revision, no deny, no intent, no audit.
--     0022's new `org_operator_suspended` answer is reachable only through the producer
--     added here, and it covers the four worker gates only: `submit_task` and the
--     `enforce_org_execution` trigger still raise `org_execution_unavailable` (403, ui
--     `org_paused`), which is a user-visible status and was deliberately left alone.
--   * `work.cancellation_intent` was created with a pending index and a retry ladder
--     (0018:464-490) and has zero INSERT statements in the whole chain, so §6.1's
--     consumer had nothing to consume and the rule stayed invisible.
--
-- "May this organization run" has two carriers on purpose: `work.org`, which the shipped
-- guards read, and `execution_entitlement`, §4.1's operator record with its revision and
-- Host acknowledgement. This command keeps them consistent by rule instead of adding a
-- third table: **narrowing takes effect immediately** (P2 - flags, deny, epoch bump and
-- intents before any Host call), and **restoration takes effect only when the Host
-- acknowledges that exact revision** (P2's reverse ordering, and §3.3's "开通返回 pending
-- 直至 Host 确认"). So `execution_entitlement` holds the requested state and `work.org`
-- the effective one; the pending window between them is expressed as
-- `host_ack_revision IS DISTINCT FROM revision` - no new column, no new state value,
-- nothing registered without a writer.
--
-- The suspend decision keys off the operator's own request, never off the current
-- mirror: an organization Host has already archived still gets its operator deny. Keying
-- off the mirror would have made "the org was not running anyway" swallow the suspension,
-- and the first Host un-archive would then resume service that a person had stopped -
-- the fail-open this whole path exists to close.
--
-- Deliberately NOT done here:
--   * P5's "未决的 entitlement 命令" is read off that ack gap rather than off
--     `governance_change`, because that table has no writer yet (§4.2 段末 ⑥). Making
--     this command the saga's first writer would settle the saga's shape under the name
--     of a CAS. When §3.2 lands, the two must be reconciled to one carrier.
--   * "operator 允许管理的组织集合" (§3.3) has no carrier in this database. Until the
--     operator plane gets a per-endpoint identity (task #27), the boundary is the
--     dedicated `work_operator` role: EXECUTE on this command and nothing else, created
--     by deploy/ecs/provision-r0b-roles.sh, held by exactly one workload.
--   * the HTTP face is #27's too, for the same reason - `POST
--     /operator/organizations/{id}/execution-state` needs the transport that says which
--     workload is the operator before anything can answer 202.
--   * intents are written and not yet consumed. The consumer is §6.1's narrowing worker
--     (task #32). Writing without consuming is the safe direction here - it piles up
--     cancellations rather than dropping them - but it is unfinished work, not a feature.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- The intent writer (§6.1)
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.queue_run_cancellations(
  p_org_id text,
  p_source_event_id uuid,
  p_cutoff_epoch bigint,
  p_reason text,
  p_subject_id text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_count bigint;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_source_event_id IS NULL OR p_cutoff_epoch IS NULL
     OR COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'invalid_request:cancellation_scope' USING ERRCODE = '22023';
  END IF;

  -- §6.1's predicate and nothing wider: only Runs whose frozen `admission_access_epoch`
  -- is at or below the epoch this narrowing retires are in scope. `p_cutoff_epoch` is the
  -- retired value (see record_org_narrowing), so a Run admitted after the deny is
  -- excluded by construction - that exclusion is the only reason the column exists.
  --
  -- `cancel_requested` is left out because that Run is already inside the cancel path;
  -- an intent exists to enter it, and a second no-op row only makes the queue look
  -- longer than the work. Terminal states are out for the same reason.
  --
  -- `admission_access_epoch` is NOT NULL DEFAULT 0 (0018:26), so Runs predating R0b read
  -- as the oldest possible admission and are included. Leaving them out would let a
  -- revoke sail past every Run that existed before the upgrade - the fail-open direction
  -- this table exists to prevent.
  --
  -- No writer-side cap, on purpose: §6.1's "每组织最多500意图待领" is a claim limit on
  -- the consumer, and a limit here would silently drop cancellations.
  INSERT INTO work.cancellation_intent
    (org_id, source_event_id, run_id, reason)
  SELECT p_org_id, p_source_event_id, r.id, p_reason
  FROM work.run r
  JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
  WHERE r.org_id = p_org_id
    AND r.state IN ('queued', 'active', 'waiting')
    AND r.admission_access_epoch <= p_cutoff_epoch
    AND (p_subject_id IS NULL OR t.owner_subject_id = p_subject_id)
  ON CONFLICT (org_id, source_event_id, run_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Internal: reached only from the narrowing triggers and from the operator command, as
-- work_owner. No workload role may queue a cancellation by hand.
REVOKE ALL ON FUNCTION work.queue_run_cancellations(text, uuid, bigint, text, text)
  FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The projection triggers now also queue intents (same transaction, same cutoff)
-- ---------------------------------------------------------------------------
--
-- CREATE OR REPLACE repeats SECURITY DEFINER and the fixed search_path: replacing a body
-- does not inherit the security settings of the function it replaces, and losing either
-- one here would run this trigger as the invoking role with a caller-controlled
-- search_path. The REVOKE lines are restated for the same reason - a replacement does not
-- reset an ACL it did not change, and leaving a wider grant attached to a new body is how
-- a tightening gets silently undone.

CREATE OR REPLACE FUNCTION work.record_org_narrowing() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_epoch bigint;
  v_restriction_id uuid := gen_random_uuid();
  v_intents bigint;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NULL;
  END IF;
  IF NEW.status <> 'active' THEN
    PERFORM set_config('app.org_id', NEW.id, true);
    UPDATE work.org
    SET access_epoch = access_epoch + 1, updated_at = now()
    WHERE id = NEW.id
    RETURNING access_epoch INTO v_epoch;
    INSERT INTO work.access_restriction
      (id, org_id, scope, source, reason, epoch, host_revision, release_floor_revision)
    VALUES
      (v_restriction_id, NEW.id, 'org', 'host_org',
       'organization_' || NEW.status, v_epoch - 1, NEW.revision, NEW.revision);
    -- §6.1 asks for the cancellation intent alongside the deny; it had no producer.
    v_intents := work.queue_run_cancellations(
      NEW.id, v_restriction_id, v_epoch - 1, 'organization_' || NEW.status, NULL);
    PERFORM work.append_audit(
      NEW.id, NULL, 'access_restriction.created', 'access_restriction',
      v_restriction_id::text,
      jsonb_build_object('source', 'host_org', 'scope', 'org',
                         'host_revision', NEW.revision,
                         'cutoff_access_epoch', v_epoch - 1,
                         'access_epoch', v_epoch,
                         'cancellation_intents', v_intents)
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION work.record_member_narrowing() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_epoch bigint;
  v_restriction_id uuid;
  v_source text;
  v_open_change boolean;
  v_intents bigint;
BEGIN
  IF OLD.status = NEW.status AND OLD.work_seat = NEW.work_seat THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.org_id', NEW.org_id, true);

  IF OLD.status = 'active' AND NEW.status IN ('suspended', 'left') THEN
    v_restriction_id := gen_random_uuid();
    UPDATE work.org SET access_epoch = access_epoch + 1, updated_at = now()
    WHERE id = NEW.org_id RETURNING access_epoch INTO v_epoch;
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'member', NEW.subject_id, 'host_member',
       'member_' || NEW.status, v_epoch - 1, NEW.revision, NEW.revision);
    v_intents := work.queue_run_cancellations(
      NEW.org_id, v_restriction_id, v_epoch - 1, 'member_' || NEW.status,
      NEW.subject_id);
    PERFORM work.append_audit(
      NEW.org_id, NULL, 'access_restriction.created', 'access_restriction',
      v_restriction_id::text,
      jsonb_build_object('source', 'host_member', 'subject_id', NEW.subject_id,
                         'member_revision', NEW.revision,
                         'cutoff_access_epoch', v_epoch - 1,
                         'access_epoch', v_epoch,
                         'cancellation_intents', v_intents)
    );
  END IF;

  IF OLD.work_seat AND NOT NEW.work_seat THEN
    SELECT EXISTS (
      SELECT 1 FROM work.governance_change
      WHERE org_id = NEW.org_id
        AND target_kind = 'seat'
        AND target_id = NEW.subject_id
        AND state <> 'applied'
    ) INTO v_open_change;
    v_source := CASE WHEN v_open_change THEN 'work_seat_change' ELSE 'host_seat' END;
    v_restriction_id := gen_random_uuid();
    UPDATE work.org SET access_epoch = access_epoch + 1, updated_at = now()
    WHERE id = NEW.org_id RETURNING access_epoch INTO v_epoch;
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'member', NEW.subject_id, v_source,
       'work_seat_lost', v_epoch - 1,
       CASE WHEN v_open_change THEN NULL ELSE NEW.revision END,
       -- §3.4: the seat floor is the person's already projected member revision. The
       -- projection row is being updated right now, so it is always available here.
       NEW.revision);
    v_intents := work.queue_run_cancellations(
      NEW.org_id, v_restriction_id, v_epoch - 1, 'work_seat_lost', NEW.subject_id);
    PERFORM work.append_audit(
      NEW.org_id, NULL, 'access_restriction.created', 'access_restriction',
      v_restriction_id::text,
      jsonb_build_object('source', v_source, 'subject_id', NEW.subject_id,
                         'member_revision', NEW.revision,
                         'cutoff_access_epoch', v_epoch - 1,
                         'access_epoch', v_epoch,
                         'cancellation_intents', v_intents)
    );
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION work.record_org_narrowing() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.record_member_narrowing() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The operator command: entitlement state, its deny, and its release
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.apply_execution_entitlement(
  p_org_id text,
  p_actor_subject_id text,
  p_operator_authorization_ref text,
  p_enabled boolean,
  p_operator_suspended boolean,
  p_seat_limit bigint,
  p_target_entitlement_revision bigint,
  p_host_ack_revision bigint,
  p_client_request_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_epoch bigint;
  ent_row work.execution_entitlement%ROWTYPE;
  v_prior jsonb;
  v_reason text;
  v_desired boolean;
  v_ack_only boolean := false;
  v_denied boolean;
  v_restriction_id uuid;
  v_intents bigint := 0;
  v_released bigint := 0;
  v_execution_enabled boolean;
  v_operator_suspended boolean;
  v_outcome text;
  v_result jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  -- The operator is not an organization admin, so assert_org_admin would be the wrong
  -- door: it would let any org admin suspend service, which §3.3 reserves for a provider
  -- identity acting on a ticket. What is enforced here is three things: the session
  -- binding (the actor cannot be a string the caller invented), a non-blank authorization
  -- reference, and EXECUTE limited to the dedicated work_operator role.
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF COALESCE(btrim(p_operator_authorization_ref), '') = '' THEN
    RAISE EXCEPTION 'invalid_request:operator_authorization_ref' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(btrim(p_client_request_id), '') = '' THEN
    RAISE EXCEPTION 'invalid_request:client_request_id' USING ERRCODE = '22023';
  END IF;
  IF p_enabled IS NULL OR p_operator_suspended IS NULL
     OR p_target_entitlement_revision IS NULL OR p_target_entitlement_revision < 0
     OR (p_seat_limit IS NOT NULL AND p_seat_limit < 0)
     OR (p_host_ack_revision IS NOT NULL
         AND p_host_ack_revision <> p_target_entitlement_revision) THEN
    RAISE EXCEPTION 'invalid_request:entitlement' USING ERRCODE = '22023';
  END IF;

  -- §4.3: org row first, then the entitlement row, then restrictions, then Runs. Taking
  -- the org lock here is also what makes the epoch bump below an extension of a lock this
  -- transaction already holds rather than a new reverse edge.
  PERFORM 1 FROM work.org WHERE id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO work.execution_entitlement
    (org_id, enabled, seat_limit, operator_suspended, revision, updated_at)
  VALUES (p_org_id, false, NULL, false, 0, now())
  ON CONFLICT (org_id) DO NOTHING;
  SELECT * INTO ent_row FROM work.execution_entitlement WHERE org_id = p_org_id FOR UPDATE;

  -- One request, one result (§3.3: a timeout re-reads the original command instead of
  -- guessing whether the first attempt landed). The receipt is the audit row itself, so
  -- this adds no second ledger - same carrier as 0019's gap-skip receipt.
  SELECT metadata -> 'result' INTO v_prior
  FROM work.audit_event
  WHERE org_id = p_org_id
    AND action = 'execution_entitlement.applied'
    AND metadata ->> 'client_request_id' = p_client_request_id;
  IF FOUND THEN
    RETURN v_prior;
  END IF;

  v_desired := p_enabled AND NOT p_operator_suspended;

  IF p_target_entitlement_revision < ent_row.revision
     OR (ent_row.revision > 0
         AND p_target_entitlement_revision > ent_row.revision
         AND ent_row.host_ack_revision IS DISTINCT FROM ent_row.revision) THEN
    -- Either a stale command, or P5: an earlier operator change is still waiting for its
    -- Host acknowledgement and a second Apply must not race it.
    RAISE EXCEPTION 'governance_revision_conflict' USING ERRCODE = 'P0001';
  END IF;

  IF p_target_entitlement_revision = ent_row.revision THEN
    -- Only an acknowledgement may arrive for a revision already recorded, and it cannot
    -- restate the payload while it is at it.
    IF p_host_ack_revision IS NULL
       OR p_enabled IS DISTINCT FROM ent_row.enabled
       OR p_operator_suspended IS DISTINCT FROM ent_row.operator_suspended
       OR p_seat_limit IS DISTINCT FROM ent_row.seat_limit THEN
      RAISE EXCEPTION 'governance_revision_conflict' USING ERRCODE = 'P0001';
    END IF;
    v_ack_only := true;
  ELSIF p_host_ack_revision IS NOT NULL THEN
    -- An acknowledgement cannot describe a revision that has not been recorded yet: that
    -- would be the caller asserting the Host's answer.
    RAISE EXCEPTION 'invalid_request:host_ack_revision' USING ERRCODE = '22023';
  END IF;

  UPDATE work.execution_entitlement
  SET enabled = p_enabled,
      seat_limit = p_seat_limit,
      operator_suspended = p_operator_suspended,
      revision = p_target_entitlement_revision,
      host_ack_revision = COALESCE(p_host_ack_revision, host_ack_revision),
      updated_at = now()
  WHERE org_id = p_org_id;

  IF NOT v_desired THEN
    -- P2's first half: the Work-side restriction lands before any Host call. Re-stating
    -- an already-active suspension moves the flags but does not build a second deny or a
    -- second queue of intents - the epoch must move exactly once per narrowing, or the
    -- cutoff stops meaning "the epoch this restriction retired".
    v_reason := CASE WHEN p_operator_suspended THEN 'operator_suspended'
                     ELSE 'entitlement_disabled' END;
    SELECT EXISTS (
      SELECT 1 FROM work.access_restriction
      WHERE org_id = p_org_id
        AND source = 'operator'
        AND state IN ('active', 'reconcile_required')
    ) INTO v_denied;

    UPDATE work.org
    SET execution_enabled = false,
        operator_suspended = p_operator_suspended,
        updated_at = now()
    WHERE id = p_org_id;

    IF NOT v_denied THEN
      UPDATE work.org
      SET access_epoch = access_epoch + 1
      WHERE id = p_org_id
      RETURNING access_epoch INTO v_epoch;
      v_restriction_id := gen_random_uuid();
      INSERT INTO work.access_restriction
        (id, org_id, scope, source, reason, epoch, host_revision,
         release_floor_revision)
      VALUES
        (v_restriction_id, p_org_id, 'org', 'operator', v_reason, v_epoch - 1, NULL,
         p_target_entitlement_revision);
      v_intents := work.queue_run_cancellations(
        p_org_id, v_restriction_id, v_epoch - 1, v_reason, NULL);
      PERFORM work.append_audit(
        p_org_id, p_actor_subject_id, 'access_restriction.created',
        'access_restriction', v_restriction_id::text,
        jsonb_build_object('source', 'operator', 'scope', 'org', 'reason', v_reason,
                           'cutoff_access_epoch', v_epoch - 1,
                           'access_epoch', v_epoch,
                           'entitlement_revision', p_target_entitlement_revision,
                           'operator_authorization_ref', p_operator_authorization_ref,
                           'cancellation_intents', v_intents)
      );
    END IF;
    v_outcome := CASE WHEN v_denied THEN 'already_suspended' ELSE 'suspended' END;
  ELSIF v_ack_only THEN
    -- The acknowledgement is what a restoration has been waiting for. Only
    -- `source = 'operator'` rows are touched: P6 is explicit that restoring service does
    -- not release a host_org, host_member, seat or policy deny. `release_restriction`
    -- keeps refusing those here (0019:142-144) because the fact that opens an operator
    -- deny - host_ack_revision on the entitlement row - is not one of its arguments.
    UPDATE work.org
    SET execution_enabled = true,
        operator_suspended = false,
        updated_at = now()
    WHERE id = p_org_id;
    UPDATE work.access_restriction
    SET state = 'released',
        released_by_revision = p_target_entitlement_revision,
        released_at = now(),
        revision = revision + 1,
        updated_at = now()
    WHERE org_id = p_org_id
      AND source = 'operator'
      AND state IN ('active', 'reconcile_required')
      AND release_floor_revision < p_target_entitlement_revision;
    GET DIAGNOSTICS v_released = ROW_COUNT;
    IF v_released > 0 THEN
      PERFORM work.append_audit(
        p_org_id, p_actor_subject_id, 'access_restriction.released',
        'access_restriction', p_org_id,
        jsonb_build_object('source', 'operator',
                           'released_count', v_released,
                           'released_by_revision', p_target_entitlement_revision,
                           'operator_authorization_ref', p_operator_authorization_ref)
      );
    END IF;
    v_outcome := CASE WHEN v_released > 0 THEN 'restored' ELSE 'ack_recorded' END;
  ELSE
    -- A new command that loosens the state: recorded, but the effective change waits for
    -- the Host acknowledgement, so the mirror and the deny stay exactly as they are.
    -- §3.3 calls this "pending 直至 Host 确认"; it is visible as
    -- host_ack_revision IS DISTINCT FROM revision, which is also what P5 reads.
    v_outcome := 'pending_ack';
  END IF;

  SELECT o.execution_enabled, o.operator_suspended
  INTO v_execution_enabled, v_operator_suspended
  FROM work.org o WHERE o.id = p_org_id;

  v_result := jsonb_build_object(
    'org_id', p_org_id,
    'revision', p_target_entitlement_revision,
    'enabled', p_enabled,
    'operator_suspended', p_operator_suspended,
    'seat_limit', p_seat_limit,
    'host_ack_revision', COALESCE(p_host_ack_revision, ent_row.host_ack_revision),
    'execution_enabled', v_execution_enabled,
    'denial_active', EXISTS (
      SELECT 1 FROM work.access_restriction
      WHERE org_id = p_org_id AND source = 'operator'
        AND state IN ('active', 'reconcile_required')
    ),
    'cancellation_intents', v_intents,
    'released_denials', v_released,
    'outcome', v_outcome
  );

  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'execution_entitlement.applied',
    'execution_entitlement', p_org_id,
    jsonb_build_object('client_request_id', p_client_request_id,
                       'operator_authorization_ref', p_operator_authorization_ref,
                       'result', v_result)
  );
  RETURN v_result;
END;
$$;

-- The receipt has to be findable by request id, and unique so a retried request cannot
-- produce two receipts for one decision.
CREATE UNIQUE INDEX work_audit_event_entitlement_request
  ON work.audit_event (org_id, ((metadata ->> 'client_request_id')))
  WHERE action = 'execution_entitlement.applied';

REVOKE ALL ON FUNCTION work.apply_execution_entitlement(
  text, text, text, boolean, boolean, bigint, bigint, bigint, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.apply_execution_entitlement(
  text, text, text, boolean, boolean, bigint, bigint, bigint, text
) TO work_operator;

-- The role is created outside the chain (provision-r0b-roles.sh / testpg), and without
-- schema USAGE it authenticates and then fails to resolve anything - the same trap 0019
-- hit with work_governance_events. USAGE plus this one EXECUTE is the whole operator
-- surface: no table privileges, because every effect goes through the definer body.
GRANT USAGE ON SCHEMA work TO work_operator;

RESET ROLE;
