-- Local-only role bootstrap for E1 draft. Production role provisioning is D-04.
-- Run as a superuser/CREATEROLE role in a disposable database only.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['work_owner','work_api','work_worker','work_ledger','work_migrator','work_ops','work_directory'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;
