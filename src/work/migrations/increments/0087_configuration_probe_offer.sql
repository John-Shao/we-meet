-- 0087: carry configuration-probe metadata in the signed run offer.
SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.list_pending_device_offers(
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
  v_result jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

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

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'run_id', b.run_id,
    'binding_revision', b.binding_revision,
    'binding_hash', work.sha256_text('run_offer|' || b.run_id::text || '|'
      || b.binding_revision::text || '|' || b.start_nonce::text),
    'task_id', b.task_id,
    'device_id', b.device_id,
    'session_id', b.session_id,
    'input_ref', b.input_ref,
    'input_hash', b.input_hash,
    'snapshot_descriptor_ref', b.snapshot_descriptor_ref,
    'snapshot_hash', b.snapshot_hash,
    'profile_id', b.profile_id,
    'profile_revision', b.profile_revision,
    'runtime_digest', b.runtime_digest,
    'tool_manifest_hash', b.tool_manifest_hash,
    'model_version', b.model_version,
    'grant_set', b.grant_set,
    'expected_checkpoint_seq', b.expected_checkpoint_seq,
    'expected_checkpoint_hash', b.expected_checkpoint_hash,
    'start_nonce', b.start_nonce,
    'offer_expiry', b.offer_expiry,
    'probe', CASE WHEN b.purpose = 'configuration_probe' THEN jsonb_build_object(
      'binding_id', mp.binding_id,
      'probe_id', mp.probe_id,
      'preview_hash', mp.preview_hash,
      'template_hash', work.sha256_text('device-model-probe-v1')
    ) ELSE NULL END
  ) ORDER BY b.run_id, b.binding_revision), '[]'::jsonb)
  INTO v_result
  FROM work.device_run_binding b
  LEFT JOIN work.model_profile_probe mp
    ON mp.org_id = b.org_id AND mp.run_id = b.run_id
  WHERE b.org_id = p_org_id
    AND b.device_id = p_device_id
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
            AND a.metadata ->> 'lease_id' = l.id::text)));

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION work.list_pending_device_offers(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.list_pending_device_offers(text, uuid, uuid) TO work_worker;

RESET ROLE;
