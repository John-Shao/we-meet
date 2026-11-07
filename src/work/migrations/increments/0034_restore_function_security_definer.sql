-- 0034 (#87): put back the SECURITY DEFINER that CREATE OR REPLACE silently dropped.
--
-- Mechanism, because it produces no error and no drift signal: baseline/0002:5163-5177 hardens the
-- schema once, after assembling it - for every function in schema work it runs
-- `ALTER FUNCTION ... SECURITY DEFINER` and `ALTER FUNCTION ... SET search_path = work, pg_catalog`.
-- A later CREATE OR REPLACE rebuilds that pg_proc row from the statement text alone, and prosecdef
-- and proconfig are not properties the statement inherits from the row it replaces. Omitting them
-- therefore reverts the function to invoker rights with an unpinned search_path, while its ACL, its
-- owner and its grants all stay exactly as they were. The function keeps looking published and keeps
-- answering calls - until a caller that is not the owner tries one.
--
-- 0031 did that to work.list_pending_audit_exports, whose entire job is to read a table work_worker
-- may not SELECT: the baseline comment at 0002:4689 says the audit_export table stays closed to the
-- worker and the definer function is the only door. Production consequence, read on 2026-11-06:
-- work-export logged `ERROR: permission denied for table audit_export (SQLSTATE 42501)` on every
-- five-second poll from 18:44:12, which is the minute 0031 was applied as part of I-4a (29 -> 32) - 1,713 of
-- them had logged by 21:06:50, and the channel stays shut until this increment is applied. The
-- #80 behaviour 0031 was written to add - discovering a running export whose lease has elapsed -
-- became unreachable through the increment that added it, and the SIGKILL drill row b9af0511 stayed
-- undiscoverable by the worker for exactly that reason.
--
-- Scope was set by enumeration, not by the one symptom, and both reads are reproducible:
--   * the 31 catalog checkpoints this chain publishes, compared against the tail: exactly two
--     functions are recorded as SECURITY DEFINER at some version and not at the tail -
--     list_pending_audit_exports (definer through 0030, dropped by 0031) and
--     artifact_version_immutable_content (definer through 0016, dropped by 0017).
--   * production, per function: the workload roles holding EXECUTE crossed with the work tables each
--     body reads, keeping only rows where that role cannot SELECT - one row,
--     list_pending_audit_exports / work_worker / audit_export. That second read is also why 0029's
--     release_unreceipted_reservations is left alone: it is invoker rights on purpose (0029:38-43
--     says so and makes the row set depend on RLS), and every role that may execute it can read what
--     it touches, so it is a different decision rather than the same bug.
--
-- Both restorations are in one increment because they are one defect. artifact_version_immutable_content
-- is behaviour-neutral, and that is checkable rather than asserted: EXECUTE is held by work_owner
-- alone, the body reads no table (it compares NEW to OLD and raises 23514), and work_owner is already
-- the effective user of every path that updates work.artifact_version - so neither the privilege
-- resolution nor the name resolution can change what the trigger decides. The immutability cases in
-- internal/migrate/r0b_transition_test.go and internal/api/immutability_pg_test.go run against the
-- restored attribute, which is what turns that sentence into a test result.
--
-- Why a new increment instead of an edit: 0017 and 0031 are published, checksum-pinned in
-- manifest.json, and already applied to the pilot database; the chain only moves forward.
CREATE OR REPLACE FUNCTION work.list_pending_audit_exports(p_org_id text)
RETURNS TABLE (export_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT e.id FROM work.audit_export e
  WHERE e.org_id = p_org_id
    AND (e.status = 'queued'
         OR (e.status = 'running'
             AND (e.lease_until IS NULL OR e.lease_until <= clock_timestamp())))
  ORDER BY e.created_at;
END;
$$;

-- 0017 rewrote this guard to use IS DISTINCT FROM (content_ref became nullable) and lost the
-- hardening in the same statement. The body below is 0017's body, unchanged; only the two clause
-- lines are added.
CREATE OR REPLACE FUNCTION work.artifact_version_immutable_content() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.content_ref IS DISTINCT FROM OLD.content_ref
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.media_type IS DISTINCT FROM OLD.media_type
     OR NEW.location IS DISTINCT FROM OLD.location
     OR NEW.local_ref IS DISTINCT FROM OLD.local_ref
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.classification IS DISTINCT FROM OLD.classification
     OR NEW.provenance IS DISTINCT FROM OLD.provenance THEN
    RAISE EXCEPTION 'artifact_version_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- CREATE OR REPLACE keeps the published ACL, so no GRANT or REVOKE appears here: 0002:5249 still
-- grants execute on list_pending_audit_exports to work_worker and 0002 grants nothing on
-- artifact_version_immutable_content beyond work_owner. Saying it explicitly because this increment
-- exists for the opposite reason - a reader trusted the part of that pattern that survives
-- (the ACL) and not the part that does not (prosecdef, search_path).
