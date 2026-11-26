SET ROLE work_owner;

-- EV118 R12A-14: a destination refusal at permit time is a durable cancellation,
-- not a transient heartbeat retry. Keep the reviewed 0069 implementation intact
-- behind a thin wrapper so normal permits and replay follow the exact old path.
ALTER FUNCTION work.consume_device_permit(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, text
) RENAME TO consume_device_permit_unfiltered;

CREATE FUNCTION work.consume_device_permit(
  p_org_id text,
  p_operation_id uuid,
  p_attempt_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_lease_id uuid,
  p_fence bigint,
  p_request_hash text,
  p_kid text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run_id uuid;
  v_task_id uuid;
  v_task work.task%ROWTYPE;
  v_state text;
  v_action_kind text;
  v_destination_id text;
  v_taint integer;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  -- A real dispatch is already authoritative; let the old function return its
  -- byte-for-byte replay before any cancellation predicate is evaluated.
  IF EXISTS (
    SELECT 1 FROM work.device_dispatch
    WHERE org_id = p_org_id AND operation_id = p_operation_id
      AND attempt_id = p_attempt_id
  ) THEN
    RETURN work.consume_device_permit_unfiltered(
      p_org_id, p_operation_id, p_attempt_id, p_device_id, p_session_id,
      p_lease_id, p_fence, p_request_hash, p_kid);
  END IF;

  SELECT run_id, state INTO v_run_id, v_state
  FROM work.operation
  WHERE org_id = p_org_id AND id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN work.consume_device_permit_unfiltered(
      p_org_id, p_operation_id, p_attempt_id, p_device_id, p_session_id,
      p_lease_id, p_fence, p_request_hash, p_kid);
  END IF;

  SELECT task_id INTO v_task_id
  FROM work.run
  WHERE org_id = p_org_id AND id = v_run_id
  FOR UPDATE;
  SELECT * INTO v_task
  FROM work.task
  WHERE org_id = p_org_id AND id = v_task_id
  FOR UPDATE;
  SELECT action_kind, destination_id INTO v_action_kind, v_destination_id
  FROM work.local_action
  WHERE org_id = p_org_id AND operation_id = p_operation_id
    AND attempt_id = p_attempt_id
  FOR UPDATE;

  IF v_state = 'authorized'
     AND v_action_kind IN ('model.send_remote', 'model.send_device_local')
     AND v_destination_id <> 'device_local' THEN
    SELECT COALESCE(MAX(work.classification_rank(g.classification)), 0)
      INTO v_taint
    FROM work.local_action la
    JOIN work.operation o ON o.id = la.operation_id AND o.org_id = la.org_id
    JOIN work.workspace_grant g ON g.id = la.grant_id AND g.org_id = g.org_id
    WHERE la.org_id = p_org_id AND o.run_id = v_run_id
      AND la.action_kind IN ('workspace.read', 'workspace.search', 'artifact.write');
    IF v_taint >= work.classification_rank('local_only') THEN
      PERFORM work.cancel_operation(
        p_org_id, p_operation_id, v_task.owner_subject_id,
        'destination_not_allowed_for_local_only');
      RETURN jsonb_build_object(
        'status', 'refused',
        'code', 'destination_not_allowed_for_local_only',
        'operation_id', p_operation_id,
        'dispatch_attempt_id', p_attempt_id);
    END IF;
  END IF;

  RETURN work.consume_device_permit_unfiltered(
    p_org_id, p_operation_id, p_attempt_id, p_device_id, p_session_id,
    p_lease_id, p_fence, p_request_hash, p_kid);
END;
$$;

ALTER FUNCTION work.consume_device_permit(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, text
) OWNER TO work_owner;
ALTER FUNCTION work.consume_device_permit_unfiltered(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, text
) OWNER TO work_owner;

REVOKE ALL ON FUNCTION work.consume_device_permit(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.consume_device_permit_unfiltered(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.consume_device_permit_unfiltered(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) FROM work_worker;
GRANT EXECUTE ON FUNCTION work.consume_device_permit(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) TO work_worker;

RESET ROLE;
