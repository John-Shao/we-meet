-- 0036: audit export content prefetch without burning the ticket.
--
-- Commit aedeb2e71 changed the download handler to read the content_ref before consuming
-- the one-time ticket, so a storage failure does not burn the grant. The handler executed
-- a direct SELECT on work.audit_export filtered by download_token_hash, but the work_api
-- role has no SELECT privilege on that table (baseline 0002:5186 revokes it to enforce the
-- "only through domain functions" rule). The result was `permission denied for table
-- audit_export (SQLSTATE 42501)` on every download attempt, surfacing as 503 service_degraded.
--
-- The fix is a SECURITY DEFINER function that reads the two columns the handler needs
-- (content_ref and format) by token_hash, with the same org_id gate the handler already
-- applies. The function returns no more than the handler would see after redeeming the
-- ticket - content_ref is already present in the redeem payload, and format is request-time
-- metadata - so it does not widen the information available to the caller.
--
-- The function checks status='ready' before returning, matching the redeem half's contract:
-- a token for a non-ready export is invalid regardless of whether the ticket has been
-- consumed. This keeps the prefetch and the redeem semantically equivalent on the happy path,
-- and the handler still falls through to the redeem call (which will return the appropriate
-- error code) if the prefetch returns no row.
SET ROLE work_owner;

CREATE FUNCTION work.prefetch_audit_export_content(
  p_org_id text,
  p_subject_id text,
  p_token_hash text
) RETURNS TABLE (content_ref text, format text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'download_token_invalid' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.content_ref, e.format
  FROM work.audit_export e
  WHERE e.org_id = p_org_id
    AND e.download_token_hash = p_token_hash
    AND e.status = 'ready';
END;
$$;

-- prefetch_audit_export_content is reached only through the download handler as work_api,
-- and a definer body must not be callable by PUBLIC.
REVOKE ALL ON FUNCTION work.prefetch_audit_export_content(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.prefetch_audit_export_content(text, text, text) TO work_api;

RESET ROLE;
