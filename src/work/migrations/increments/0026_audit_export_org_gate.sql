-- 0026: stop queueing new audit exports while an organization is switched off.
--
-- D3-N06's answer for the kill switch and for an organization suspension is stated in the
-- orchestration matrix (work-r0a-orchestration-design-2026-10-25.md:608) and in the drill
-- sheet (work-r0a-c03-u3-drills-2026-10-27.md:80): with the switch on, new submissions and
-- **new exports** must be 0, while relay, shredder, projection sync and retention sweep keep
-- running. The submission half was already enforced - work.submit_task reads the org row and
-- raises `org_execution_unavailable` (0002:1543-1552), and the runtime gates do the same
-- through work.assert_org_execution_enabled (0009:123-136, narrowed by 0022:28-49). The
-- export half had no check at all: work.create_audit_export called only
-- work.assert_org_admin and read org_policy for retention, so an operator-suspended or
-- archived organization could still queue a job that its own export worker would then run.
--
-- The two codes are chosen deliberately rather than by reusing the guard:
-- work.assert_org_execution_enabled raises `org_execution_disabled`, which the catalogue
-- maps to `service_degraded` - a policy refusal would reach the admin as a 503, which is
-- the same defect family that `run_not_quiescent` and `artifact_read_only` already fell into
-- (see internal/apierr/errors.go). Here `org_operator_suspended` (409, contact_operator) and
-- `org_execution_unavailable` (403, org_paused) are both public codes and both already
-- declared as responses of POST /work/v1/admin/audit-exports
-- (r0a-openapi-v1.yaml:701-704), and 0022's ordering rationale applies unchanged: an
-- organization that is both archived and operator-suspended reports the human decision
-- first, because that is the one somebody has to act on.
--
-- The gate sits after the idempotency replay and before the INSERT, not at the top of the
-- body. The contract promises that the same client_request_id with the same parameters
-- returns the same job (r0a-openapi-v1.yaml:685), so a client retrying after a lost ACK
-- during a suspension must still read its original job instead of being told the export
-- never happened - refusing a replay would turn a switch-on into a lost-work claim, and
-- D3-N06 also requires that completed external actions are not replayed after recovery.
--
-- Everything else is 0002:4584-4655 restated unchanged: the validations, the retention and
-- span limits, the request hash, the replay lookup with its FOR UPDATE, the insert and the
-- audit payload. The differences are the org gate and the execution attributes below.
SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.create_audit_export(
  p_org_id text,
  p_subject_id text,
  p_client_request_id text,
  p_range_from timestamptz,
  p_range_to timestamptz,
  p_format text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
  org_row work.org%ROWTYPE;
  retention int;
  req_hash text;
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  IF p_client_request_id IS NULL OR char_length(btrim(p_client_request_id)) < 8
     OR char_length(p_client_request_id) > 128 THEN
    RAISE EXCEPTION 'invalid_request:client_request_id' USING ERRCODE = '22023';
  END IF;
  IF p_format IS NULL OR p_format NOT IN ('csv', 'json') THEN
    RAISE EXCEPTION 'invalid_request:export_format' USING ERRCODE = '22023';
  END IF;
  IF p_range_from IS NULL OR p_range_to IS NULL OR p_range_from >= p_range_to THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_range_to > now() THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(NULLIF(op.policy->>'audit_retention_days', '')::int, 365)
    INTO retention
  FROM work.org_policy op WHERE op.org_id = p_org_id;
  IF retention IS NULL THEN
    retention := 365;
  END IF;
  IF p_range_from < now() - make_interval(days => retention) THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_range_to - p_range_from > make_interval(days => 92) THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;

  req_hash := work.sha256_text(jsonb_build_object(
    'client_request_id', p_client_request_id,
    'range_from', p_range_from,
    'range_to', p_range_to,
    'format', p_format
  )::text);

  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.org_id = p_org_id AND e.client_request_id = p_client_request_id
  FOR UPDATE;

  IF FOUND THEN
    IF export_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN work.audit_export_view(export_row);
  END IF;

  -- D3-N06: no new export job may be queued while the organization is switched off. An
  -- unknown organization takes the same answer as a switched-off one, because `org_not_found`
  -- has no public code and would surface as a 503 for what is a policy decision.
  SELECT * INTO org_row FROM work.org WHERE id = p_org_id FOR SHARE;
  IF NOT FOUND OR org_row.operator_suspended THEN
    RAISE EXCEPTION 'org_operator_suspended' USING ERRCODE = 'P0001';
  END IF;
  IF org_row.status <> 'active' OR NOT org_row.execution_enabled THEN
    RAISE EXCEPTION 'org_execution_unavailable' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO work.audit_export
    (org_id, requested_by, client_request_id, request_hash, range_from, range_to, format, status)
  VALUES
    (p_org_id, p_subject_id, p_client_request_id, req_hash, p_range_from, p_range_to, p_format, 'queued')
  RETURNING * INTO export_row;

  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'audit_export.requested', 'audit_export', export_row.id::text,
    jsonb_build_object('format', p_format, 'range_from', p_range_from, 'range_to', p_range_to)
  );
  RETURN work.audit_export_view(export_row);
END;
$$;

-- create_audit_export is reached only through POST /work/v1/admin/audit-exports as work_api,
-- and a definer body must not be callable by PUBLIC. Both are restated because
-- CREATE OR REPLACE leaves the ACL it did not change and silently keeps `prosecdef = false`
-- from the original declaration - the failure mode 0025 documents for set_provider_config.
REVOKE ALL ON FUNCTION work.create_audit_export(
  text, text, text, timestamptz, timestamptz, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.create_audit_export(
  text, text, text, timestamptz, timestamptz, text
) TO work_api;

RESET ROLE;
