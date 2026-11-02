-- 0025: give setProviderConfig's conflict the detail its public code requires.
--
-- work.set_provider_config raises `revision_conflict`, which the error catalogue maps
-- to `version_conflict`. apierr deliberately refuses to emit `version_conflict` without
-- a numeric DETAIL, because that code means "your expected revision was wrong" and the
-- client needs the current revision to recover: apierr/errors.go turns a missing detail
-- into 503 service_degraded, and the same file records that this exact conversion
-- already turned legitimate 409s into 503s once before (run_not_quiescent, which raises
-- no detail at all and is therefore special-cased there). 0018:114-115 shows the
-- intended shape for a revision conflict: DETAIL carries the current revision.
--
-- No HTTP route called set_provider_config before this batch, so nothing served today
-- changes behaviour. This is a prerequisite for landing PUT /admin/provider-config,
-- whose contract entry (r0a-openapi-v1.yaml:546) declares 409 and nothing else.
--
-- Everything else is restated from 0002:4217-4284 unchanged: the org row lock order, the
-- supersede-then-max+1 revision sequence, the signature and the audit payload. The two
-- changes are the DETAIL above and the execution attributes below, so this entry is a
-- deliberate 3-diff: probe detail, SECURITY DEFINER, and an explicit privilege restatement.
SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.set_provider_config(
  p_org_id text,
  p_subject_id text,
  p_provider text,
  p_model text,
  p_region text,
  p_endpoint text,
  p_credential_mode text,
  p_credential_id uuid,
  p_expected_revision bigint DEFAULT NULL
) RETURNS TABLE (config_id uuid, revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  credential work.provider_credential%ROWTYPE;
  current_revision bigint;
  next_revision bigint;
  new_id uuid := gen_random_uuid();
BEGIN
  PERFORM work.assert_org_owner(p_org_id, p_subject_id);
  IF p_provider NOT IN ('aliyun', 'volcengine', 'deepseek') THEN
    RAISE EXCEPTION 'invalid_request:provider' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(btrim(p_model)) NOT BETWEEN 1 AND 120
     OR p_region IS NULL OR length(btrim(p_region)) = 0
     OR p_endpoint IS NULL OR p_endpoint !~ '^https://' THEN
    RAISE EXCEPTION 'invalid_request:provider_config' USING ERRCODE = '22023';
  END IF;
  IF p_credential_mode NOT IN ('sts_role', 'managed_key') THEN
    RAISE EXCEPTION 'invalid_request:credential_mode' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO credential FROM work.provider_credential
    WHERE id = p_credential_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF credential.state <> 'active' THEN
    RAISE EXCEPTION 'provider_credential_revoked' USING ERRCODE = 'P0001';
  END IF;
  IF credential.provider <> p_provider OR credential.mode <> p_credential_mode THEN
    RAISE EXCEPTION 'provider_credential_mismatch' USING ERRCODE = '22023';
  END IF;
  -- 组织行锁序列化配置写入，保证同一时刻只有一条 active。
  PERFORM 1 FROM work.org WHERE id = p_org_id FOR UPDATE;
  SELECT c.revision INTO current_revision
  FROM work.provider_access_config c
  WHERE c.org_id = p_org_id AND c.state = 'active';
  IF p_expected_revision IS NOT NULL
     AND p_expected_revision <> COALESCE(current_revision, 0) THEN
    -- COALESCE keeps the detail present on the first write too, where no active row
    -- exists and the current revision is 0: without it the client would receive a 409
    -- whose current_revision is null and could not tell "someone configured it first"
    -- from "the detail was missing".
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = '40001',
      DETAIL = COALESCE(current_revision, 0)::text;
  END IF;
  UPDATE work.provider_access_config
  SET state = 'superseded', superseded_at = now()
  WHERE org_id = p_org_id AND state = 'active';
  SELECT COALESCE(MAX(c.revision), 0) + 1 INTO next_revision
  FROM work.provider_access_config c WHERE c.org_id = p_org_id;
  INSERT INTO work.provider_access_config
    (id, org_id, revision, provider, model, region, endpoint, credential_mode, credential_id, created_by)
  VALUES
    (new_id, p_org_id, next_revision, p_provider, btrim(p_model), btrim(p_region),
     btrim(p_endpoint), p_credential_mode, p_credential_id, p_subject_id);
  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'provider.config_changed', 'provider_access_config', new_id::text,
    jsonb_build_object('provider', p_provider, 'model', btrim(p_model), 'region', btrim(p_region),
                       'credential_mode', p_credential_mode, 'revision', next_revision)
  );
  RETURN QUERY SELECT new_id, next_revision;
END;
$$;

-- The second defect this increment has to fix to make the route implementable at all:
-- 0002 declared set_provider_config without SECURITY DEFINER while granting it to
-- work_api, and work.assert_org_owner is only executable by work_owner. So work_api
-- calling the function reached the owner assertion and died on 42501 permission denied -
-- the function was unreachable through its only granted role, which is why the missing
-- probe and the missing conflict detail were never observed. Its siblings
-- (create_provider_credential, issue_provider_probe_grant) are all SECURITY DEFINER; the
-- attribute above matches them. Privileges are restated because a definer body must not
-- be callable by PUBLIC.
REVOKE ALL ON FUNCTION work.set_provider_config(
  text, text, text, text, text, text, text, uuid, bigint
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.set_provider_config(
  text, text, text, text, text, text, text, uuid, bigint
) TO work_api;

RESET ROLE;
