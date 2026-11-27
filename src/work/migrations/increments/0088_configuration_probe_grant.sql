-- 0088: internal short-lived grant for bounded configuration probes.
--
-- Model actions use a grant as their server-derived classification authority. A configuration probe
-- has no workspace root, so the database creates an internal local_only grant and hides it from the
-- ordinary workspace-grant list. The binding records the exact probe and carries only that grant.
SET ROLE work_owner;

ALTER TABLE work.workspace_grant
  ADD COLUMN purpose text NOT NULL DEFAULT 'workspace'
  CHECK (purpose IN ('workspace', 'configuration_probe'));

ALTER TABLE work.device_run_binding
  ADD COLUMN probe_id uuid,
  ADD CONSTRAINT device_run_binding_probe_fkey
    FOREIGN KEY (org_id, probe_id) REFERENCES work.model_profile_probe(org_id, probe_id),
  ADD CONSTRAINT device_run_binding_purpose_shape
    CHECK ((purpose = 'configuration_probe') = (probe_id IS NOT NULL));

ALTER TABLE work.device_run_binding
  DROP CONSTRAINT device_run_binding_grant_set_shape;
ALTER TABLE work.device_run_binding
  ADD CONSTRAINT device_run_binding_grant_set_shape CHECK (
    (purpose = 'configuration_probe' AND jsonb_typeof(grant_set) = 'array'
      AND jsonb_array_length(grant_set) = 1)
    OR (purpose = 'task' AND work.binding_grant_set_valid(grant_set))
  );

CREATE FUNCTION work.provide_configuration_probe_grant() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_session work.device_session%ROWTYPE;
  v_probe work.model_profile_probe%ROWTYPE;
  v_grant_id uuid;
  v_template_hash text := work.sha256_text('device-model-probe-v1');
  v_expires_at timestamptz;
BEGIN
  IF NEW.purpose <> 'configuration_probe' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_probe FROM work.model_profile_probe mp
  JOIN work.device_model_binding b
    ON b.org_id = mp.org_id AND b.id = mp.binding_id
  WHERE mp.org_id = NEW.org_id AND (mp.run_id IS NULL OR mp.run_id = NEW.run_id)
    AND NEW.snapshot_descriptor_ref = 'probe:' || mp.probe_id::text
    AND b.device_id = NEW.device_id AND b.session_id = NEW.session_id
    AND b.profile_id = NEW.profile_id AND b.profile_revision = NEW.profile_revision
    AND b.status = 'pending_probe'
  ORDER BY mp.created_at DESC
  LIMIT 1;
  IF NOT FOUND OR v_probe.state NOT IN ('queued', 'running') OR v_probe.binding_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_session FROM work.device_session
  WHERE org_id = NEW.org_id AND id = NEW.session_id AND device_id = NEW.device_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  v_grant_id := gen_random_uuid();
  v_expires_at := LEAST(now() + interval '5 minutes', NEW.offer_expiry, v_session.expires_at);
  INSERT INTO work.workspace_grant
    (org_id, id, device_id, session_id, owner_subject_id, boot_id, root_ref,
     root_identity_hash, allowed_tools, classification, matched_rule_index,
     grant_revision, expires_at, state, client_request_id, request_hash, purpose)
  VALUES
    (NEW.org_id, v_grant_id, NEW.device_id, NEW.session_id, v_session.owner_subject_id,
     v_session.boot_id, gen_random_uuid(), v_template_hash, ARRAY['workspace.list']::text[],
     'local_only', NULL, 1, v_expires_at, 'active', 'probe:' || NEW.run_id::text,
     v_template_hash, 'configuration_probe');
  NEW.probe_id := v_probe.probe_id;
  NEW.grant_set := jsonb_build_array(jsonb_build_object(
    'grant_id', v_grant_id, 'grant_revision', 1
  ));
  PERFORM work.append_audit(
    NEW.org_id, v_session.owner_subject_id, 'configuration_probe.grant.created',
    'device_run_binding', NEW.run_id::text,
    jsonb_build_object('probe_id', v_probe.probe_id, 'grant_id', v_grant_id,
      'expires_at', v_expires_at, 'classification', 'local_only'));
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_run_binding_configuration_probe_grant
BEFORE INSERT ON work.device_run_binding
FOR EACH ROW EXECUTE FUNCTION work.provide_configuration_probe_grant();

REVOKE ALL ON FUNCTION work.provide_configuration_probe_grant() FROM PUBLIC;

CREATE OR REPLACE FUNCTION work.list_workspace_grants(
  p_org_id text,
  p_actor_subject_id text,
  p_device_id uuid,
  p_cursor text,
  p_limit int
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_limit int := COALESCE(p_limit, 50);
  v_items jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF v_limit < 1 OR v_limit > 100 OR (p_cursor IS NOT NULL AND p_cursor <> '') THEN
    RAISE EXCEPTION 'invalid_pagination' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_agg(x) INTO v_items
    FROM (
      SELECT jsonb_build_object('grant_id', g.id, 'device_id', g.device_id,
               'session_id', g.session_id, 'root_ref', g.root_ref,
               'classification', g.classification,
               'allowed_tools', to_jsonb(g.allowed_tools),
               'grant_revision', g.grant_revision, 'expires_at', g.expires_at,
               'state', g.state, 'succeeded_by', g.succeeded_by,
               'matched_rule_index', g.matched_rule_index,
               'created_at', g.created_at, 'revision', g.revision) AS x
        FROM work.workspace_grant g
       WHERE g.org_id = p_org_id AND g.owner_subject_id = p_actor_subject_id
         AND g.purpose = 'workspace'
         AND (p_device_id IS NULL OR g.device_id = p_device_id)
       ORDER BY g.created_at DESC, g.id DESC
       LIMIT v_limit
    ) s;
  RETURN jsonb_build_object('items', COALESCE(v_items, '[]'::jsonb),
    'next_cursor', null);
END;
$$;

REVOKE ALL ON FUNCTION work.list_workspace_grants(text, text, uuid, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.list_workspace_grants(text, text, uuid, text, int) TO work_api;

RESET ROLE;
