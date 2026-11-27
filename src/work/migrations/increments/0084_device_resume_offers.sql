-- 0084: reconnect resume offers for Runs whose executor exited while work was pending.
--
-- 0052 made pending offers session-bound and read-only: a new session cannot pick up the old
-- offer. Cross-session recovery therefore stays on the explicit workspace-rebind command, which
-- creates its own higher revision after re-authorization. This command closes the same-session
-- gap: after approval/executor exit it creates the missing higher-revision resume offer, while
-- the existing list/ready/start chain remains the sole delivery and activation path.
--
-- Authority: device-design §3.2 resume flow and §6.3 checkpoint recovery; 0069 atomic binding
-- activation; 0052 session-bound offer/readiness gates. No new table or public error code.

SET ROLE work_owner;

CREATE FUNCTION work.ensure_device_resume_offers(
  p_org_id text,
  p_device_id uuid,
  p_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_checkpoint work.device_checkpoint%ROWTYPE;
  v_revision bigint;
  v_grant_count bigint;
  v_offer jsonb;
  v_request_id text;
  v_response jsonb;
  v_created jsonb := '[]'::jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_device.status = 'revoked' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id AND device_id = p_device_id;
  IF NOT FOUND OR v_session.state <> 'active' OR v_session.expires_at <= clock_timestamp()
     OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM work.org WHERE id = p_org_id FOR SHARE;

  FOR v_run IN
    SELECT r.* FROM work.device_run_binding latest_binding
    JOIN work.run r ON r.org_id = latest_binding.org_id AND r.id = latest_binding.run_id
    JOIN work.task t ON t.org_id = r.org_id AND t.id = r.task_id
    WHERE latest_binding.org_id = p_org_id
      AND latest_binding.device_id = p_device_id
      AND latest_binding.binding_revision = (
        SELECT MAX(b.binding_revision) FROM work.device_run_binding b
        WHERE b.org_id = latest_binding.org_id AND b.run_id = latest_binding.run_id)
      AND (r.state = 'active' OR (r.state = 'waiting' AND r.wait_reason = 'input'))
      AND t.state = 'open' AND t.active_run_id = r.id
      AND NOT EXISTS (
        SELECT 1 FROM work.operation o
        WHERE o.org_id = r.org_id AND o.run_id = r.id
          AND o.state IN ('unknown', 'unresolved'))
      AND NOT EXISTS (
        SELECT 1 FROM work.execution_lease l
        WHERE l.org_id = r.org_id AND l.run_id = r.id AND l.state = 'active'
          AND l.expires_at > clock_timestamp()
          AND l.purpose IN ('reconcile_finish', 'execute'))
    ORDER BY r.id
  LOOP
    -- Match create_device_run_binding's Task-before-Run lock order; heartbeat must not invert it.
    SELECT * INTO v_task FROM work.task
      WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    SELECT * INTO v_run FROM work.run
      WHERE org_id = p_org_id AND id = v_run.id FOR UPDATE;
    IF NOT FOUND OR v_task.state <> 'open' OR v_task.active_run_id IS DISTINCT FROM v_run.id
       OR NOT (v_run.state = 'active'
           OR (v_run.state = 'waiting' AND v_run.wait_reason = 'input')) THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM work.operation o
      WHERE o.org_id = p_org_id AND o.run_id = v_run.id
        AND o.state IN ('unknown', 'unresolved')
    ) OR EXISTS (
      SELECT 1 FROM work.execution_lease l
      WHERE l.org_id = p_org_id AND l.run_id = v_run.id AND l.state = 'active'
        AND l.expires_at > clock_timestamp()
        AND l.purpose IN ('reconcile_finish', 'execute')
    ) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_binding FROM work.device_run_binding
      WHERE org_id = p_org_id AND run_id = v_run.id
      ORDER BY binding_revision DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND OR v_binding.device_id <> p_device_id THEN
      CONTINUE;
    END IF;

    -- A new session must explicitly re-authorize/rebind its workspace grants. Copying the old
    -- session's grant refs would mint a new-session lease that the permit path could not lawfully
    -- use. The explicit rebind command already creates the higher-revision offer for that path.
    IF v_binding.session_id <> p_session_id THEN
      CONTINUE;
    END IF;
    PERFORM 1 FROM jsonb_array_elements(v_binding.grant_set) e
    JOIN work.workspace_grant g
      ON g.org_id = p_org_id AND g.id = (e ->> 'grant_id')::uuid
    FOR SHARE OF g;
    SELECT count(*) INTO v_grant_count
    FROM jsonb_array_elements(v_binding.grant_set) e
    JOIN work.workspace_grant g
      ON g.org_id = p_org_id AND g.id = (e ->> 'grant_id')::uuid
    WHERE g.device_id = p_device_id AND g.session_id = p_session_id
      AND g.state = 'active' AND g.expires_at > clock_timestamp()
      AND g.grant_revision = (e ->> 'grant_revision')::bigint;
    IF v_grant_count <> jsonb_array_length(v_binding.grant_set) THEN
      CONTINUE;
    END IF;

    -- An active Run with an already acquired execute lease is still executing. Re-offering it
    -- before the lease/workflow parks the Run would make 0069 activation refuse run_not_active.
    IF v_run.state = 'active' AND EXISTS (
      SELECT 1 FROM work.audit_event a
      WHERE a.org_id = p_org_id AND a.action = 'device_lease.acquired'
        AND a.metadata -> 'response' ->> 'run_id' = v_run.id::text
    ) THEN
      CONTINUE;
    END IF;

    -- A live offer/lease already bound to this session is the resume path. Do not create a
    -- second nonce while the device may still answer the first one.
    IF EXISTS (
      SELECT 1 FROM work.device_run_binding b
      WHERE b.org_id = p_org_id AND b.run_id = v_run.id
        AND b.session_id = p_session_id
        AND b.binding_revision = (SELECT MAX(latest.binding_revision)
          FROM work.device_run_binding latest
          WHERE latest.org_id = b.org_id AND latest.run_id = b.run_id)
        AND b.state IN ('offered', 'ready', 'active')
        AND b.offer_expiry > clock_timestamp()
        AND (b.state IN ('offered', 'ready') OR EXISTS (
          SELECT 1 FROM work.execution_lease l
          WHERE l.org_id = b.org_id AND l.run_id = b.run_id
            AND l.binding_revision = b.binding_revision AND l.purpose = 'execute'
            AND l.state = 'active' AND l.expires_at > clock_timestamp()
            AND NOT EXISTS (SELECT 1 FROM work.audit_event a
              WHERE a.org_id = l.org_id AND a.action = 'device_lease.acquired'
                AND a.metadata ->> 'lease_id' = l.id::text)))
    ) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_checkpoint FROM work.device_checkpoint
      WHERE org_id = p_org_id AND run_id = v_run.id AND state = 'recorded'
      ORDER BY checkpoint_seq DESC LIMIT 1;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    v_revision := v_binding.binding_revision + 1;
    v_offer := jsonb_build_object(
      'input_ref', v_binding.input_ref,
      'input_hash', v_binding.input_hash,
      'snapshot_descriptor_ref', v_binding.snapshot_descriptor_ref,
      'snapshot_hash', v_binding.snapshot_hash,
      'profile_id', v_binding.profile_id,
      'profile_revision', v_binding.profile_revision,
      'runtime_digest', v_binding.runtime_digest,
      'tool_manifest_hash', v_binding.tool_manifest_hash,
      'model_version', v_binding.model_version,
      'grant_set', v_binding.grant_set,
      'expected_checkpoint_seq', v_checkpoint.checkpoint_seq,
      'expected_checkpoint_hash', v_checkpoint.checkpoint_hash,
      'offer_ttl_seconds', 120
    );
    v_request_id := 'resume:' || v_run.id::text || ':' || p_session_id::text
      || ':' || v_revision::text;
    v_response := work.create_device_run_binding(
      p_org_id, v_run.id, p_device_id, p_session_id, v_revision, v_request_id, v_offer);
    v_created := v_created || jsonb_build_array(v_response);
  END LOOP;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION work.ensure_device_resume_offers(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.ensure_device_resume_offers(text, uuid, uuid) TO work_worker;
