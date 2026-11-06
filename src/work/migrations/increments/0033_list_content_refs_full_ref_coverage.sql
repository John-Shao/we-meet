-- 0033: list_content_refs has to know every column that stores a content URI.
--
-- 0032 shipped the read-only orphan report (#80 second half) scanning four tables. On its first
-- production run (2026-11-06) it reported content_objects=1352 content_orphans=178, and the number
-- was wrong in the unsafe direction: 163 of those objects are referenced, just from columns 0032
-- never looked at. Intersecting the on-disk ids with the union of every ref-bearing column gives 15
-- true orphans, and the drill object 267c8708... is legitimately among them.
--
-- Which columns qualify was decided by counting rows whose value actually starts with
-- 'content://work/', not by column name: intent_ref 157/316, dispatch_delivery.receipt_ref 126/148
-- and operation.receipt_ref 126/164 carry them; artifact_version.local_ref, task_event.payload_ref,
-- submission_dedup.result_ref, runtime_checkpoint_head.checkpoint_ref and
-- runtime_execution.input_checkpoint_ref carry none (the last two plus content_reference.ref_id hold
-- uuids), so they stay out - adding a branch that cannot match only invites the next reader to trust
-- a list that was never evidenced.
--
-- Direction of this change matters for the duty rule: widening the reference set can only REMOVE
-- reported orphans, never add them, so an over-report stops being a false alarm while the
-- under-report risk (deleting something still referenced) is what §5.30 forbids. The reading stays
-- report-only and stays out of the exit code.
CREATE OR REPLACE FUNCTION work.list_content_refs(p_org_id text) RETURNS SETOF text
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
  WHERE c.org_id = p_org_id AND c.content_ref IS NOT NULL
  UNION ALL
  -- 0033: three more columns really carry content URIs (counts read in production on
  -- 2026-11-06, rows shaped 'content://work/%' over all rows): runtime_execution.intent_ref
  -- 157/316, dispatch_delivery.receipt_ref 126/148, operation.receipt_ref 126/164. Missing
  -- them is what made the first production reading report 178 orphans when 15 were real.
  SELECT split_part(regexp_replace(x.intent_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.runtime_execution x
  WHERE x.org_id = p_org_id AND x.intent_ref LIKE 'content://work/%'
  UNION ALL
  SELECT split_part(regexp_replace(d.receipt_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.dispatch_delivery d
  WHERE d.org_id = p_org_id AND d.receipt_ref LIKE 'content://work/%'
  UNION ALL
  SELECT split_part(regexp_replace(o.receipt_ref, '^content://work/[^/]*/', ''), '?', 1)
  FROM work.operation o
  WHERE o.org_id = p_org_id AND o.receipt_ref LIKE 'content://work/%';
END;
$$;

-- CREATE OR REPLACE keeps the published object's ACL, so 0033 repeats no GRANT or
-- REVOKE: EXECUTE stays granted to work_worker alone and still revoked from PUBLIC, as
-- 0032 set it. Re-issuing them here would also be the wrong signal - it would read as
-- if the privilege had to be re-established after a replacement.
