-- 0014: read-only worker commands required to bind an advance execution.
--
-- Authority: docs/plan/work-r0a-advance-workflow-binding-decision-2026-10-30.md
-- D-2 (freeze the route revision) and D-1 (reuse an existing committed head
-- instead of creating a second one). Both reads are SECURITY DEFINER commands
-- granted to work_worker only: the worker role still has no table SELECT on
-- runtime_checkpoint_head, and provider config remains reachable only through
-- domain functions.
--
-- The provider revision is work.provider_access_config.revision: the baseline
-- table already stores a positive bigint, unique per organization, and
-- upsert_provider_config assigns MAX(revision)+1 on every change. Its decimal
-- string therefore satisfies canonical.Route.ConfigRevision
-- (`^[1-9][0-9]{0,18}$`) without deriving a second, competing number.
SET ROLE work_owner;

-- Active provider configuration identity plus the monotonic configuration
-- revision. The runtime_org_context check keeps the same tenant boundary as
-- the 0009 runtime commands.
CREATE FUNCTION work.read_provider_config_revision(p_org_id text)
RETURNS TABLE (config_id uuid, revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  config work.provider_access_config%ROWTYPE;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  SELECT * INTO config
  FROM work.provider_access_config c
  WHERE c.org_id = p_org_id AND c.state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider_not_configured' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY SELECT config.id, config.revision;
END;
$$;

-- The committed canonical head for one Run. D-1 requires a replay to use an
-- existing head instead of writing a second revision 0, and work_worker has no
-- SELECT grant on work.runtime_checkpoint_head. A missing head is the ordinary
-- "not created yet" answer and is reported as P0002, exactly like other
-- not-found reads.
CREATE FUNCTION work.read_runtime_checkpoint_head(p_org_id text, p_run_id uuid)
RETURNS TABLE (
  checkpoint_revision bigint,
  checkpoint_ref text,
  checkpoint_hash text,
  runtime_version text,
  committed_execution_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  RETURN QUERY
  SELECT h.checkpoint_revision, h.checkpoint_ref, h.checkpoint_hash,
         h.runtime_version, h.committed_execution_id
  FROM work.runtime_checkpoint_head h
  WHERE h.org_id = p_org_id AND h.run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime_checkpoint_head_not_found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION work.read_provider_config_revision(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.read_runtime_checkpoint_head(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.read_provider_config_revision(text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.read_runtime_checkpoint_head(text, uuid) TO work_worker;

RESET ROLE;
