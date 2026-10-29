-- Pilot defaults for new and existing organizations.
-- Customers bring their own model accounts; the soft account is a usage guard,
-- not a billing limit. These defaults can be changed by an operator later.
SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.ensure_quota_account(
  p_org_id text,
  p_account_key text,
  p_period_id text,
  p_limit_tokens bigint,
  p_enforcement text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  account_id uuid;
BEGIN
  IF p_org_id IS NULL OR p_org_id = ''
     OR p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_account_key IS NULL OR p_account_key !~ '^[a-z][a-z0-9_-]{1,31}$'
     OR p_period_id IS NULL OR p_period_id !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'invalid_request:quota_period' USING ERRCODE = '22023';
  END IF;
  IF p_enforcement NOT IN ('soft', 'hard') THEN
    RAISE EXCEPTION 'invalid_request:quota_enforcement' USING ERRCODE = '22023';
  END IF;
  IF p_limit_tokens IS NULL OR p_limit_tokens <= 0 THEN
    RAISE EXCEPTION 'invalid_request:quota_limit' USING ERRCODE = '22023';
  END IF;
  INSERT INTO work.quota_account
    (org_id, account_key, period_id, limit_tokens, enforcement)
  VALUES (p_org_id, p_account_key, p_period_id, p_limit_tokens, p_enforcement)
  ON CONFLICT (org_id, account_key, period_id) DO NOTHING;
  SELECT a.id INTO account_id
  FROM work.quota_account a
  WHERE a.org_id = p_org_id AND a.account_key = p_account_key AND a.period_id = p_period_id;
  IF account_id IS NULL THEN
    RAISE EXCEPTION 'quota_account_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN account_id;
END;
$$;

CREATE OR REPLACE FUNCTION work.provision_org_defaults(
  p_org_id text,
  p_period_id text DEFAULT to_char(now(), 'YYYY-MM')
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  policy_rows int := 0;
  account_id uuid;
  org_exists boolean;
BEGIN
  IF p_org_id IS NULL OR p_org_id = '' THEN
    RAISE EXCEPTION 'invalid_request:org_id' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  SELECT EXISTS (SELECT 1 FROM work.org WHERE id = p_org_id) INTO org_exists;
  IF NOT org_exists THEN
    RAISE EXCEPTION 'org_not_found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO work.org_policy (org_id) VALUES (p_org_id)
  ON CONFLICT (org_id) DO NOTHING;
  GET DIAGNOSTICS policy_rows = ROW_COUNT;
  account_id := work.ensure_quota_account(
    p_org_id, 'default', p_period_id, 1000000, 'soft');
  IF policy_rows > 0 THEN
    PERFORM work.append_audit(
      p_org_id, NULL, 'org.provisioned', 'org', p_org_id,
      jsonb_build_object(
        'policy_created', true,
        'quota_account_id', account_id,
        'period_id', p_period_id,
        'limit_tokens', 1000000,
        'enforcement', 'soft'
      )
    );
  END IF;
  RETURN jsonb_build_object(
    'policy_created', policy_rows > 0,
    'quota_account_id', account_id,
    'period_id', p_period_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION work.provision_org_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  PERFORM work.provision_org_defaults(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS org_provision_defaults ON work.org;
CREATE TRIGGER org_provision_defaults
  AFTER INSERT ON work.org
  FOR EACH ROW EXECUTE FUNCTION work.provision_org_after_insert();

DO $$
DECLARE
  org_id text;
BEGIN
  FOR org_id IN SELECT id FROM work.org LOOP
    PERFORM work.provision_org_defaults(org_id);
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION work.ensure_quota_account(text, text, text, bigint, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.provision_org_defaults(text, text) TO work_worker;

RESET ROLE;
