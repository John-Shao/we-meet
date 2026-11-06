-- Increment 0032 (#80 = A1, second half): a worker-readable view of which content objects the
-- database still refers to, so the hourly retention scan can REPORT objects that exist on disk
-- with no referrer. Report-only by design: nothing in this file deletes, expires or rewrites a
-- row, and the wrapper deliberately keeps the resulting count out of its exit code.
--
-- Why a function instead of a SELECT in the scan script, measured rather than assumed:
-- has_table_privilege('work_worker', ...) on this tip reads
--   audit_export=false, content_reference=false, input_object=true, artifact_version=true,
-- and the runner connects as work_worker with ON_ERROR_STOP=1 - which is what the retention
-- timer already uses. A raw UNION over those four tables would therefore raise 42501 every
-- hour and mark a working sweep FAILED: an invisible "read-only metric" that stops the sweep
-- is worse than no metric. SECURITY DEFINER is the same channel the neighbouring gauges
-- (expire_due_audit_exports, shred_due_audit_exports) already use.
--
-- The definer bypasses row security, so the org filter is written out per branch rather than
-- left to policy - the standing rule for owner-perspective reads in this schema.
--
-- Shape of the answer: content_ref is not a bare object id. The writer emits
-- "content://work/<url-escaped org>/<32 hex id>?v=<key version>" (internal/content/local.go:178)
-- while the object lives at <sha256(org) first 16 bytes>/<id>.enc (same file, :95-99). This
-- returns only the id part, matched by PREFIX PATTERN: a hardcoded character offset would
-- silently turn every file into an "orphan" the moment refPrefix changes.
CREATE FUNCTION work.list_content_refs(p_org_id text) RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id = '' THEN
    RAISE EXCEPTION 'invalid_request:org_id' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT split_part(regexp_replace(e.content_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.audit_export e
  WHERE e.org_id = p_org_id AND e.content_ref IS NOT NULL
  UNION ALL
  SELECT split_part(regexp_replace(i.content_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.input_object i
  WHERE i.org_id = p_org_id AND i.content_ref IS NOT NULL
  UNION ALL
  SELECT split_part(regexp_replace(a.content_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.artifact_version a
  WHERE a.org_id = p_org_id AND a.content_ref IS NOT NULL
  UNION ALL
  SELECT split_part(regexp_replace(c.content_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.content_reference c
  WHERE c.org_id = p_org_id AND c.content_ref IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION work.list_content_refs(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.list_content_refs(text) TO work_worker;
