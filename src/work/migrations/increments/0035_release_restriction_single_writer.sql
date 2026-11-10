-- 0035: released 收回单一写者（J42，卡片 #50 之二）
--
-- access_restriction.state='released' 此前有两个写点：release_restriction（0019，非 operator
-- 来源）与 apply_execution_entitlement 的 ack 分支批量 UPDATE（0023/生效体 0027）。后者绕过
-- 前者的按条审计与来源守卫。本增量把 operator 来源也漏斗进 release_restriction：
--   * release_restriction 增带默认值的来源参 p_release_source（默认 'command'，旧 5 参调用
--     靠默认解析），operator 分支自读 execution_entitlement.host_ack_revision 复验已成立
--     （事实由被调方证明，化解 0019 旧拒绝理由）；非 operator 路径调它释放 operator deny 仍拒。
--   * apply_execution_entitlement 的 ack 分支不再批量 UPDATE，改逐条调 release_restriction
--     （自带按条审计）；命令级审计仍带 operator_authorization_ref 与 released_denials。
-- 守卫"全链置 released 的 UPDATE 站点唯一"与本增量同批（见 internal/migrate 测试）。
-- 签名变更不能用 CREATE OR REPLACE（会造重载），故 release_restriction 先 DROP 再 CREATE。
-- 两个函数同为 SECURITY DEFINER、owner 同为 work_owner，触发器式按角色区分不可行，守卫走
-- catalog 生效体扫描＋testpg 穷举。

DROP FUNCTION work.release_restriction(text, uuid, uuid, bigint, text);

CREATE FUNCTION work.release_restriction(
  p_org_id text,
  p_restriction_id uuid,
  p_command_id uuid,
  p_observed_revision bigint,
  p_actor_subject_id text,
  p_release_source text DEFAULT 'command'
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  restriction_row work.access_restriction%ROWTYPE;
  command_row work.consumed_governance_command%ROWTYPE;
  v_projection_active boolean;
  v_projection_revision bigint;
  release_revision bigint;
  v_host_ack_revision bigint;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RETURN 'org_context_mismatch';
  END IF;
  SELECT * INTO restriction_row
  FROM work.access_restriction
  WHERE org_id = p_org_id AND id = p_restriction_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'restriction_not_releasable';
  END IF;
  IF restriction_row.state = 'released' THEN
    IF p_observed_revision IS NOT NULL
       AND restriction_row.released_by_revision = p_observed_revision THEN
      RETURN 'already_released';
    END IF;
    RETURN 'restriction_not_releasable';
  END IF;
  IF restriction_row.source IN ('governance', 'policy', 'device', 'grant', 'model') THEN
    -- Never released: a newer grant produces a newer revision and this row only
    -- covers the old epoch.
    RETURN 'restriction_not_releasable';
  END IF;

  IF restriction_row.source IN ('host_seat', 'work_seat_change') THEN
    -- The projection cannot distinguish "a new granting command" from "some row
    -- was edited", so only the command event counts (§3.4 rule 6). The comparison
    -- is against release_floor_revision, never host_revision, which is null for
    -- the Work-initiated case and would make every comparison null.
    IF p_command_id IS NULL THEN
      RETURN 'restriction_not_releasable';
    END IF;
    SELECT * INTO command_row
    FROM work.consumed_governance_command
    WHERE org_id = p_org_id AND command_id = p_command_id;
    -- gap_skipped rows are registered only so that a skipped interval is never
    -- replayed (§3.1). They are the record of an event that was *not* applied, so
    -- treating one as release evidence would turn the cursor recovery into the
    -- silent resume §3.4 rule 2 forbids.
    IF NOT FOUND
       OR command_row.gap_skipped
       OR command_row.kind <> 'seat'
       OR NOT command_row.desired
       OR command_row.target_subject_id <> restriction_row.subject_id
       OR command_row.member_revision <= restriction_row.release_floor_revision THEN
      RETURN 'restriction_not_releasable';
    END IF;
    release_revision := command_row.member_revision;
  ELSIF restriction_row.source IN ('host_org', 'host_member') THEN
    -- §3.4 states this release condition as two conjuncts - "同步观察到 status=active"
    -- AND a revision above the floor - so the projected status is part of the predicate
    -- and not a caller's discretion. The sync identity supplies the revision it saw;
    -- the status is a row the database already has, and reading it here is what stops a
    -- caller from lifting a deny for an organization or person the projection still
    -- records as suspended. Under a SECURITY DEFINER body these reads are bound by the
    -- same tenant_isolation policy as every other table, and the org-context check at
    -- the top of this function already fixes which tenant they run against.
    IF restriction_row.scope = 'org' THEN
      SELECT o.status = 'active', o.revision INTO v_projection_active, v_projection_revision
      FROM work.org o WHERE o.id = p_org_id;
    ELSE
      SELECT m.status = 'active', m.revision INTO v_projection_active, v_projection_revision
      FROM work.member m
      WHERE m.org_id = p_org_id AND m.subject_id = restriction_row.subject_id;
    END IF;
    -- `IS NOT TRUE` also covers the missing-row case: a projection that has been
    -- deleted proves nothing about anybody being active again.
    IF v_projection_active IS NOT TRUE THEN
      RETURN 'restriction_not_releasable';
    END IF;
    IF p_observed_revision IS NULL
       OR p_observed_revision > v_projection_revision
       OR p_observed_revision <= restriction_row.release_floor_revision THEN
      -- The upper bound is what makes `released_by_revision` a fact rather than an
      -- input: the caller reports the revision it observed, and a value the projection
      -- does not have would be recorded as release evidence nobody ever saw.
      RETURN 'restriction_not_releasable';
    END IF;
    release_revision := p_observed_revision;
  ELSIF restriction_row.source = 'operator' THEN
    -- J42: operator denys are released only by the operator command path, and the
    -- fact that opens them - host_ack_revision on the entitlement row - is proven
    -- here by the callee rather than supplied by the caller (resolves the old
    -- 0019 refusal that drove the batch UPDATE in apply_execution_entitlement).
    IF p_release_source IS DISTINCT FROM 'operator' THEN
      RETURN 'restriction_not_releasable';
    END IF;
    SELECT host_ack_revision INTO v_host_ack_revision
    FROM work.execution_entitlement WHERE org_id = p_org_id;
    IF v_host_ack_revision IS NULL
       OR v_host_ack_revision <= restriction_row.release_floor_revision THEN
      RETURN 'restriction_not_releasable';
    END IF;
    release_revision := v_host_ack_revision;
  ELSE
    RETURN 'restriction_not_releasable';
  END IF;

  UPDATE work.access_restriction
  SET state = 'released',
      released_by_revision = release_revision,
      released_at = now(),
      revision = revision + 1,
      updated_at = now()
  WHERE org_id = p_org_id AND id = p_restriction_id;
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'access_restriction.released',
    'access_restriction', p_restriction_id::text,
    jsonb_build_object(
      'source', restriction_row.source,
      'scope', restriction_row.scope,
      'subject_id', restriction_row.subject_id,
      'release_floor_revision', restriction_row.release_floor_revision,
      'released_by_revision', release_revision,
      'command_id', p_command_id
    )
  );
  RETURN 'released';
END;
$$;

REVOKE ALL ON FUNCTION work.release_restriction(text, uuid, uuid, bigint, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION work.apply_execution_entitlement(
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
  v_prior_hash text;
  v_request_hash text;
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
  v_request_hash := work.sha256_text(jsonb_build_object(
    'actor_subject_id', p_actor_subject_id,
    'authorization_ref', p_operator_authorization_ref,
    'enabled', p_enabled,
    'operator_suspended', p_operator_suspended,
    'seat_limit', p_seat_limit,
    'target_entitlement_revision', p_target_entitlement_revision,
    'host_ack_revision', p_host_ack_revision
  )::text);

  SELECT metadata -> 'result', metadata ->> 'request_hash'
    INTO v_prior, v_prior_hash
  FROM work.audit_event
  WHERE org_id = p_org_id
    AND action = 'execution_entitlement.applied'
    AND metadata ->> 'client_request_id' = p_client_request_id;
  IF FOUND THEN
    -- One half of the receipt rule was implemented here and the other was not: the
    -- org row lock above keeps concurrent retries honest, but a reused request id
    -- carrying a different decision - a different seat limit, a different target
    -- revision, a different ticket - was answered with the earlier result, so the
    -- operator saw "applied" for a command the database never ran. See 0005:48.
    IF v_prior_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
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
    -- not release a host_org, host_member, seat or policy deny. J42 funnels the release
    -- through `release_restriction` (the single writer): called with source 'operator',
    -- it self-reads the entitlement host_ack_revision rather than taking the caller's word.
    UPDATE work.org
    SET execution_enabled = true,
        operator_suspended = false,
        updated_at = now()
    WHERE id = p_org_id;
    -- J42: released goes through release_restriction, the single writer. The batch
    -- UPDATE that used to sit here bypassed its per-row audit and source guard; each
    -- operator deny is now released by the same callee as every other source, which
    -- self-reads the entitlement ack fact and writes a per-row audit. The command-level
    -- audit below still carries operator_authorization_ref and released_denials.
    FOR v_restriction_id IN
      SELECT id FROM work.access_restriction
      WHERE org_id = p_org_id
        AND source = 'operator'
        AND state IN ('active', 'reconcile_required')
        AND release_floor_revision < p_target_entitlement_revision
      ORDER BY id
    LOOP
      IF work.release_restriction(
           p_org_id, v_restriction_id, NULL, NULL, p_actor_subject_id, 'operator'
         ) = 'released' THEN
        v_released := v_released + 1;
      END IF;
    END LOOP;
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
                       'request_hash', v_request_hash,
                       'operator_authorization_ref', p_operator_authorization_ref,
                       'result', v_result)
  );
  RETURN v_result;
END;
$$;

-- Restated: CREATE OR REPLACE leaves the previous ACL alone.
REVOKE ALL ON FUNCTION work.apply_execution_entitlement(
  text, text, text, boolean, boolean, bigint, bigint, bigint, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.apply_execution_entitlement(
  text, text, text, boolean, boolean, bigint, bigint, bigint, text
) TO work_operator;
