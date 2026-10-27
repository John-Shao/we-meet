-- Production role provisioning for the Work R0a schema (D-04).
-- Run once per cluster as a CREATEROLE/superuser identity, before the first
-- `manage.py migrate work`. Idempotent; never drops or alters existing roles.
--
-- All seven roles are NOLOGIN (D1 4.1). The platform workload identity that
-- runs migrations or the API must be a member of the target role and SET ROLE
-- to it (D1 6.1). work_migrator is a placeholder until that mapping is signed.
--
-- Migration identity needs: GRANT work_owner TO <migration_login_role>;
-- API/worker identities need: GRANT work_api TO <api_login_role>;
--                             GRANT work_worker TO <worker_login_role>;
-- (and work_directory / work_ops for their jobs).

DO $$
DECLARE
  r text;
  missing text[] := '{}';
  roles text[] := ARRAY[
    'work_owner', 'work_api', 'work_worker', 'work_ledger',
    'work_migrator', 'work_ops', 'work_directory'
  ];
BEGIN
  FOREACH r IN ARRAY roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      missing := missing || r;
    END IF;
  END LOOP;

  IF cardinality(missing) > 0 THEN
    RAISE NOTICE 'Creating Work roles: %', array_to_string(missing, ', ');
    FOREACH r IN ARRAY missing LOOP
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END LOOP;
  END IF;

  FOREACH r IN ARRAY roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND rolcanlogin) THEN
      RAISE EXCEPTION
        'Work role % already exists with LOGIN; D1 4.1 requires NOLOGIN',
        r;
    END IF;
  END LOOP;
END $$;
