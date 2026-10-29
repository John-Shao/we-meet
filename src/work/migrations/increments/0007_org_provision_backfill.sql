-- Backfill existing organizations. 0006's trigger covers new inserts; the
-- original loop could not see work.org because the migration role is subject
-- to FORCE RLS. Disable FORCE only for this transaction, then restore it.
SET ROLE work_owner;

ALTER TABLE work.org NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  org_id text;
BEGIN
  FOR org_id IN SELECT id FROM work.org LOOP
    PERFORM work.provision_org_defaults(org_id);
  END LOOP;
END;
$$;
ALTER TABLE work.org FORCE ROW LEVEL SECURITY;

RESET ROLE;
