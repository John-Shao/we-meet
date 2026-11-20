SET ROLE work_owner;

CREATE TABLE work.egress_output_recovery (
  org_id text NOT NULL,
  operation_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  staged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, operation_id),
  FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id),
  FOREIGN KEY (execution_id, org_id) REFERENCES work.runtime_execution(execution_id, org_id),
  FOREIGN KEY (run_id, task_id, org_id) REFERENCES work.run(id, task_id, org_id),
  FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id)
);
ALTER TABLE work.egress_output_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.egress_output_recovery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.egress_output_recovery
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
REVOKE ALL ON work.egress_output_recovery FROM PUBLIC, work_api, work_worker;
GRANT SELECT ON work.egress_output_recovery TO work_worker;

CREATE FUNCTION work.egress_output_recovery_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = work, pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'egress_output_immutable' USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER egress_output_recovery_immutable
  BEFORE UPDATE OR DELETE ON work.egress_output_recovery
  FOR EACH ROW EXECUTE FUNCTION work.egress_output_recovery_guard();
REVOKE ALL ON FUNCTION work.egress_output_recovery_guard() FROM PUBLIC;

CREATE FUNCTION work.stage_egress_output(p_org_id text, p_operation_id uuid, p_manifest jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = work, pg_catalog AS $$
DECLARE
  e work.runtime_execution%ROWTYPE;
  g work.dispatch_delivery%ROWTYPE;
  o work.operation%ROWTYPE;
  t work.task%ROWTYPE;
  existing jsonb;
  k text;
  keys text[] := ARRAY['execution_id','attempt_id','request_hash','gateway_invocation_id',
    'writer_gateway_id','receipt_slot_id','answer_ref_id','answer_locator','answer_hash',
    'answer_bytes','receipt_locator','receipt_hash','receipt_body_hash','receipt_bytes','logical_key'];
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF p_operation_id IS NULL OR p_manifest IS NULL OR jsonb_typeof(p_manifest) <> 'object'
     OR NOT (p_manifest ?& keys) OR p_manifest - keys <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_request:output_manifest' USING ERRCODE = '22023';
  END IF;
  FOREACH k IN ARRAY keys LOOP
    IF k IN ('answer_bytes','receipt_bytes') THEN
      IF jsonb_typeof(p_manifest->k) <> 'number' OR (p_manifest->>k) !~ '^[1-9][0-9]*$'
         OR (p_manifest->>k)::numeric > 262144 THEN
        RAISE EXCEPTION 'invalid_request:output_bytes' USING ERRCODE = '22023';
      END IF;
    ELSIF jsonb_typeof(p_manifest->k) <> 'string' OR length(p_manifest->>k) NOT BETWEEN 1 AND 512 THEN
      RAISE EXCEPTION 'invalid_request:output_manifest' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['execution_id','attempt_id','writer_gateway_id','receipt_slot_id','answer_ref_id'] LOOP
    IF (p_manifest->>k) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid_request:output_uuid' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['request_hash','answer_hash','receipt_hash','receipt_body_hash'] LOOP
    PERFORM work.assert_document_hash(k, p_manifest->>k);
  END LOOP;
  PERFORM work.assert_content_ref('answer_locator', p_manifest->>'answer_locator');
  PERFORM work.assert_content_ref('receipt_locator', p_manifest->>'receipt_locator');
  SELECT * INTO o FROM work.operation WHERE org_id=p_org_id AND id=p_operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_found' USING ERRCODE='P0002'; END IF;
  PERFORM work.lock_runtime_run(p_org_id, o.run_id);
  SELECT * INTO e FROM work.runtime_execution
    WHERE org_id=p_org_id AND execution_id=(p_manifest->>'execution_id')::uuid FOR UPDATE;
  IF NOT FOUND OR e.operation_id IS DISTINCT FROM p_operation_id OR e.run_id IS DISTINCT FROM o.run_id
     OR e.dispatch_attempt_id IS DISTINCT FROM (p_manifest->>'attempt_id')::uuid
     OR e.request_hash IS DISTINCT FROM p_manifest->>'request_hash'
     OR o.logical_key IS DISTINCT FROM p_manifest->>'logical_key' THEN
    RAISE EXCEPTION 'egress_output_binding_mismatch' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO t FROM work.task WHERE org_id=p_org_id AND id=e.task_id;
  IF NOT FOUND OR t.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'egress_output_task_deleted' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO g FROM work.dispatch_delivery
    WHERE org_id=p_org_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR g.gate_state NOT IN ('consumed','receipt_recorded')
     OR g.execution_id IS DISTINCT FROM e.execution_id
     OR g.attempt_id IS DISTINCT FROM e.dispatch_attempt_id
     OR g.request_hash IS DISTINCT FROM p_manifest->>'request_hash'
     OR g.gateway_invocation_id IS DISTINCT FROM p_manifest->>'gateway_invocation_id'
     OR g.receipt_slot_id IS DISTINCT FROM (p_manifest->>'receipt_slot_id')::uuid THEN
    RAISE EXCEPTION 'egress_output_gate_mismatch' USING ERRCODE='P0001';
  END IF;
  IF g.gate_state='receipt_recorded' AND (g.receipt_result IS DISTINCT FROM 'success'
     OR g.receipt_ref IS DISTINCT FROM p_manifest->>'receipt_locator'
     OR g.receipt_hash IS DISTINCT FROM p_manifest->>'receipt_hash') THEN
    RAISE EXCEPTION 'egress_output_receipt_mismatch' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM work.content_reference cr WHERE cr.org_id=p_org_id
    AND (cr.ref_id IN ((p_manifest->>'answer_ref_id')::uuid,(p_manifest->>'receipt_slot_id')::uuid)
      OR cr.logical_slot IN ('answer:'||e.execution_id::text||':'||(p_manifest->>'logical_key'),
        'receipt:'||e.execution_id::text||':'||(p_manifest->>'logical_key')))
    AND cr.tombstoned_at IS NOT NULL) THEN
    RAISE EXCEPTION 'content_slot_conflict' USING ERRCODE='P0001';
  END IF;
  SELECT manifest INTO existing FROM work.egress_output_recovery
    WHERE org_id=p_org_id AND operation_id=p_operation_id;
  IF FOUND THEN
    IF existing IS DISTINCT FROM p_manifest THEN
      RAISE EXCEPTION 'egress_output_conflict' USING ERRCODE='P0001';
    END IF;
    RETURN jsonb_build_object('outcome','idempotent');
  END IF;
  INSERT INTO work.egress_output_recovery(org_id,operation_id,execution_id,task_id,run_id,manifest)
    VALUES(p_org_id,p_operation_id,e.execution_id,e.task_id,e.run_id,p_manifest);
  RETURN jsonb_build_object('outcome','staged');
END;
$$;
REVOKE ALL ON FUNCTION work.stage_egress_output(text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.stage_egress_output(text,uuid,jsonb) TO work_worker;

CREATE OR REPLACE FUNCTION work.list_content_refs(p_org_id text) RETURNS SETOF text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = work, pg_catalog AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id = '' THEN
    RAISE EXCEPTION 'invalid_request:org_id' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT split_part(regexp_replace(e.content_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.audit_export e
  WHERE e.org_id = p_org_id AND e.content_ref IS NOT NULL
  UNION ALL
  SELECT split_part(regexp_replace(i.content_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.input_object i
  WHERE i.org_id = p_org_id AND i.content_ref IS NOT NULL
  UNION ALL
  SELECT split_part(regexp_replace(a.content_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.artifact_version a
  WHERE a.org_id = p_org_id AND a.content_ref IS NOT NULL
  UNION ALL
  SELECT split_part(regexp_replace(c.content_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.content_reference c
  WHERE c.org_id = p_org_id AND c.content_ref IS NOT NULL
  UNION ALL
  SELECT split_part(regexp_replace(x.intent_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.runtime_execution x
  WHERE x.org_id = p_org_id AND x.intent_ref LIKE 'content://work/%'
  UNION ALL
  SELECT split_part(regexp_replace(d.receipt_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.dispatch_delivery d
  WHERE d.org_id = p_org_id AND d.receipt_ref LIKE 'content://work/%'
  UNION ALL
  SELECT split_part(regexp_replace(o.receipt_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.operation o
  WHERE o.org_id = p_org_id AND o.receipt_ref LIKE 'content://work/%'
  UNION ALL
  SELECT split_part(regexp_replace(r.manifest->>'answer_locator', '^content://work/[^/]*/', ''), '?', 1)
  FROM work.egress_output_recovery r
  WHERE r.org_id = p_org_id AND r.manifest->>'answer_locator' LIKE 'content://work/%'
  UNION ALL
  SELECT split_part(regexp_replace(r.manifest->>'receipt_locator', '^content://work/[^/]*/', ''), '?', 1)
  FROM work.egress_output_recovery r
  WHERE r.org_id = p_org_id AND r.manifest->>'receipt_locator' LIKE 'content://work/%';
END;
$$;
REVOKE ALL ON FUNCTION work.list_content_refs(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.list_content_refs(text) TO work_worker;
RESET ROLE;
