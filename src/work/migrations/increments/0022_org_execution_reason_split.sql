-- 0022: split the organization-execution guard by trigger condition.
--
-- Authority: control design §9 (the two rows this makes necessary) and §3.3's rule that
-- operator suspension is a deliberate act while enabled/status are provisioning states.
-- Validation exit: none signed; this is the decision recorded on 2026-11-02 (work-project
-- ledger, 第十八轮 #41).
--
-- 0009:123-136 raised one code, org_execution_disabled, for three different situations:
-- the organization is archived or suspended, execution was never enabled, or an operator
-- suspended it. The first two are states that can change on their own; the third is a
-- person who decided to stop this organization and will not be surprised by anything
-- unless it keeps being served. Because the guard raises P0001 and the code was not in the
-- catalogue, all three surfaced as a retryable 503 - the response says "call again",
-- including when the answer is "an operator said stop".
--
-- The names are now split, which is the decision; what a caller then does with them is a
-- separate, already-existing mechanism (Temporal's per-activity retry policy for the
-- worker, and the HTTP status for any client-facing surface), so this increment changes
-- what can be distinguished, not any retry loop by itself.
--
-- 0009 is a published increment, so the body is replaced here rather than edited there:
-- the checksum in manifest.json pins the published text, and rewriting it would make every
-- already-applied database disagree with its own ledger row. The replacement repeats both
-- clauses the original carried - SECURITY DEFINER and the fixed search_path - because
-- CREATE OR REPLACE does not inherit security settings from the function it replaces.
SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.assert_org_execution_enabled(p_org_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  org_row work.org%ROWTYPE;
BEGIN
  SELECT * INTO org_row FROM work.org o WHERE o.id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Checked first on purpose: an organization that is both archived and operator-suspended
  -- should report the human decision, because that is the one somebody has to act on.
  IF org_row.operator_suspended THEN
    RAISE EXCEPTION 'org_operator_suspended' USING ERRCODE = 'P0001';
  END IF;
  IF org_row.status <> 'active' OR NOT org_row.execution_enabled THEN
    RAISE EXCEPTION 'org_execution_disabled' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- The original grant was a REVOKE from PUBLIC with no grantee: this function is only ever
-- reached from inside the four SECURITY DEFINER runtime gates. Stated again here because
-- CREATE OR REPLACE does not restore an ACL it did not change, and leaving the old grant
-- attached to a narrowed body is how a tightening is silently undone.
REVOKE ALL ON FUNCTION work.assert_org_execution_enabled(text) FROM PUBLIC;

RESET ROLE;
