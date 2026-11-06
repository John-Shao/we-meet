-- Increment 0031 (#80 = A1): discover an export whose lease expired.
--
-- The 2026-11-06 export-worker SIGKILL drill left request b9af0511 sitting in
-- status='running' with an elapsed lease forever: work.list_pending_audit_exports read
-- status='queued' only, so no worker ever asked for the row, while work.claim_audit_export
-- was always willing to hand it out (it refuses only while lease_until > now()). The same
-- asymmetry on the outbox side is what makes that channel self-heal, so this is a discovery
-- gap, not a claim gap. Increment 0028 fixed this shape for work.runtime_execution; this is
-- the audit_export counterpart.
--
-- The predicate mirrors claim_audit_export's own eligibility, including the NULL lease: a
-- running row with no lease_until is claimable there, so it must be visible here too, or
-- `running` rows with a NULL lease would be silently dropped by the comparison rather than
-- discovered. Nothing else changes: ready/expired/failed rows stay invisible to workers, and
-- the claim itself is still the only thing that moves a row into running.
CREATE OR REPLACE FUNCTION work.list_pending_audit_exports(p_org_id text)
RETURNS TABLE (export_id uuid)
LANGUAGE plpgsql AS $$
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

-- CREATE OR REPLACE keeps the published ACL (baseline 0002:5249 grants execute to
-- work_worker), so no GRANT or REVOKE appears here; stating it because 0028 had to say the
-- same thing and a reader should not have to go find the baseline.
