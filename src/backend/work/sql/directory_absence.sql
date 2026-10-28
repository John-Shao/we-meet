-- Host directory absence reconciliation (HW-03).
-- Only work_directory may call these commands; both write/read under the
-- tenant context set by the caller and never cancel runs.
SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.directory_watermark(p_org_id text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  current_revision bigint;
BEGIN
  IF p_org_id IS NULL OR p_org_id = ''
     OR p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'directory_org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  SELECT o.revision INTO current_revision FROM work.org o WHERE o.id = p_org_id;
  RETURN current_revision;
END;
$$;

-- Returns -1 when the mass-absence gate blocks the snapshot; no rows change.
CREATE OR REPLACE FUNCTION work.mark_members_absent(
  p_org_id text,
  p_present_subjects text[],
  p_allow_mass_absence boolean
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  member_row work.member%ROWTYPE;
  snapshot_revision bigint;
  total_members integer;
  absent_count integer;
  threshold integer;
  affected integer := 0;
BEGIN
  IF p_org_id IS NULL OR p_org_id = ''
     OR p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'directory_org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_present_subjects IS NULL THEN
    RAISE EXCEPTION 'invalid_request:present_subjects' USING ERRCODE = '22023';
  END IF;
  IF p_allow_mass_absence IS NULL THEN
    RAISE EXCEPTION 'invalid_request:allow_mass_absence' USING ERRCODE = '22023';
  END IF;
  IF array_length(p_present_subjects, 1) > 10000 THEN
    RAISE EXCEPTION 'invalid_request:present_subjects' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_present_subjects) AS subject
    WHERE subject IS NULL OR subject !~ '^[A-Za-z0-9_.:@-]{1,128}$'
  ) THEN
    RAISE EXCEPTION 'invalid_request:subject_id' USING ERRCODE = '22023';
  END IF;

  SELECT o.revision INTO snapshot_revision
    FROM work.org o
   WHERE o.id = p_org_id
   FOR UPDATE;
  IF snapshot_revision IS NULL THEN
    RAISE EXCEPTION 'directory_org_missing' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO total_members
    FROM work.member
   WHERE org_id = p_org_id
     AND status <> 'left'
     AND revision < snapshot_revision;
  SELECT count(*) INTO absent_count
    FROM work.member
   WHERE org_id = p_org_id
     AND status <> 'left'
     AND revision < snapshot_revision
     AND NOT (subject_id = ANY (p_present_subjects));
  threshold := GREATEST(10, CEIL(total_members * 0.20)::integer);

  IF NOT p_allow_mass_absence AND absent_count >= threshold THEN
    PERFORM work.append_audit(
      p_org_id,
      NULL,
      'directory.member_absence_blocked',
      'org',
      p_org_id,
      jsonb_build_object(
        'revision', snapshot_revision,
        'absent', absent_count,
        'total', total_members,
        'threshold', threshold,
        'allow_mass_absence', false
      )
    );
    RETURN -1;
  END IF;

  IF absent_count = 0 THEN
    RETURN 0;
  END IF;

  FOR member_row IN
    SELECT * FROM work.member
    WHERE org_id = p_org_id
      AND status <> 'left'
      AND revision < snapshot_revision
      AND NOT (subject_id = ANY (p_present_subjects))
    ORDER BY subject_id
    FOR UPDATE
  LOOP
    UPDATE work.member
       SET status = 'left',
           work_seat = false,
           revision = snapshot_revision,
           updated_at = now()
     WHERE id = member_row.id;
    PERFORM work.append_audit(
      p_org_id,
      NULL,
      'directory.member_absent',
      'member',
      member_row.subject_id,
      jsonb_build_object(
        'revision', snapshot_revision,
        'previous_status', member_row.status,
        'work_seat_revoked', member_row.work_seat,
        'entitlement_lost', member_row.status = 'active' OR member_row.work_seat
      )
    );
    affected := affected + 1;
  END LOOP;

  PERFORM work.append_audit(
    p_org_id,
    NULL,
    'directory.member_absence_applied',
    'org',
    p_org_id,
    jsonb_build_object(
      'revision', snapshot_revision,
      'absent', affected,
      'total', total_members,
      'threshold', threshold,
      'allow_mass_absence', p_allow_mass_absence
    )
  );
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION work.directory_watermark(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.mark_members_absent(text, text[], boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.directory_watermark(text) TO work_directory;
GRANT EXECUTE ON FUNCTION work.mark_members_absent(text, text[], boolean) TO work_directory;

RESET ROLE;
