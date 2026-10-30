-- 0008: serialize run-cap reservations, bind absence to a snapshot revision,
-- make usage recording independently idempotent, and close function grants.
SET ROLE work_owner;

ALTER TABLE work.operation ADD COLUMN usage_recorded_at timestamptz;

-- Per-organization directory sync health. New work is allowed only after a
-- successful sync and while no failure is recorded.
CREATE TABLE work.directory_sync_state (
  org_id text PRIMARY KEY,
  last_attempt_at timestamptz NOT NULL,
  last_success_at timestamptz,
  last_mode text NOT NULL CHECK (last_mode IN ('incremental', 'full')),
  last_revision bigint,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work.directory_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.directory_sync_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON work.directory_sync_state
  FOR ALL
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.record_directory_sync(
  p_org_id text,
  p_mode text,
  p_success boolean,
  p_revision bigint,
  p_error text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id = ''
     OR p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'directory_org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('incremental', 'full') THEN
    RAISE EXCEPTION 'invalid_request:sync_mode' USING ERRCODE = '22023';
  END IF;
  IF p_success IS NULL THEN
    RAISE EXCEPTION 'invalid_request:sync_success' USING ERRCODE = '22023';
  END IF;
  IF p_revision IS NOT NULL AND p_revision < 0 THEN
    RAISE EXCEPTION 'invalid_request:sync_revision' USING ERRCODE = '22023';
  END IF;
  INSERT INTO work.directory_sync_state
    (org_id, last_attempt_at, last_success_at, last_mode, last_revision, last_error)
  VALUES
    (p_org_id, now(), CASE WHEN p_success THEN now() ELSE NULL END,
     p_mode, p_revision,
     CASE WHEN p_success THEN NULL ELSE COALESCE(NULLIF(btrim(p_error), ''), 'sync_failed') END)
  ON CONFLICT (org_id) DO UPDATE
  SET last_attempt_at = now(),
      last_success_at = CASE WHEN p_success THEN now() ELSE work.directory_sync_state.last_success_at END,
      last_mode = p_mode,
      last_revision = p_revision,
      last_error = CASE WHEN p_success THEN NULL
                        ELSE COALESCE(NULLIF(btrim(p_error), ''), 'sync_failed') END,
      updated_at = now();
END;
$$;

CREATE FUNCTION work.directory_sync_fresh(
  p_org_id text,
  p_max_age_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id = ''
     OR p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'directory_org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_max_age_seconds IS NULL OR p_max_age_seconds < 60 OR p_max_age_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid_request:max_age' USING ERRCODE = '22023';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM work.directory_sync_state s
    WHERE s.org_id = p_org_id
      AND s.last_error IS NULL
      AND s.last_success_at IS NOT NULL
      AND s.last_success_at >= now() - make_interval(secs => p_max_age_seconds)
  );
END;
$$;

REVOKE ALL ON FUNCTION work.record_directory_sync(text, text, boolean, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.record_directory_sync(text, text, boolean, bigint, text) TO work_directory;
REVOKE ALL ON FUNCTION work.directory_sync_fresh(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.directory_sync_fresh(text, integer) TO work_api;

-- Reserve quota with the same Task -> Run -> Operation lock order as
-- claim_dispatch. The Run lock makes the cumulative cap check atomic.
CREATE OR REPLACE FUNCTION work.reserve_quota(
  p_org_id text,
  p_account_key text,
  p_period_id text,
  p_operation_id uuid,
  p_amount_tokens bigint
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  account work.quota_account%ROWTYPE;
  operation_row work.operation%ROWTYPE;
  policy_row work.org_policy%ROWTYPE;
  existing work.quota_reservation%ROWTYPE;
  reservation_id uuid := gen_random_uuid();
  next_seq int;
  run_cumulative_tokens bigint;
  v_task_id uuid;
BEGIN
  IF p_amount_tokens IS NULL OR p_amount_tokens <= 0 THEN
    RAISE EXCEPTION 'invalid_reservation_amount' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO policy_row FROM work.org_policy WHERE org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_policy_missing' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_tokens > policy_row.run_cap_tokens THEN
    RAISE EXCEPTION 'run_cap_exceeded' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO operation_row
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT r.task_id INTO v_task_id
  FROM work.run r
  WHERE r.id = operation_row.run_id AND r.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task t
  WHERE t.id = v_task_id AND t.org_id = p_org_id
  FOR UPDATE;
  PERFORM 1 FROM work.run r
  WHERE r.id = operation_row.run_id AND r.org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO operation_row
  FROM work.operation o
  WHERE o.id = p_operation_id AND o.org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO existing
  FROM work.quota_reservation br
  WHERE br.operation_id = p_operation_id AND br.state IN ('held', 'unknown');
  IF FOUND THEN
    IF existing.amount_tokens = p_amount_tokens THEN
      RETURN existing.id;
    END IF;
    RAISE EXCEPTION 'operation_has_active_reservation' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(SUM(br.settled_tokens), 0) + COALESCE(SUM(
    CASE WHEN br.state IN ('held', 'unknown') THEN br.amount_tokens ELSE 0 END
  ), 0) INTO run_cumulative_tokens
  FROM work.quota_reservation br
  JOIN work.operation o ON o.id = br.operation_id
  WHERE o.run_id = operation_row.run_id AND o.org_id = p_org_id;
  IF run_cumulative_tokens + p_amount_tokens > policy_row.run_cap_tokens THEN
    RAISE EXCEPTION 'run_cap_exceeded' USING ERRCODE = 'P0001';
  END IF;
  IF operation_row.state NOT IN ('prepared', 'waiting_approval', 'authorized') THEN
    RAISE EXCEPTION 'operation_not_reservable' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(MAX(br.reservation_seq), 0) + 1 INTO next_seq
  FROM work.quota_reservation br
  WHERE br.operation_id = p_operation_id;
  SELECT * INTO account
  FROM work.quota_account ba
  WHERE ba.org_id = p_org_id AND ba.account_key = p_account_key AND ba.period_id = p_period_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quota_account_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF account.enforcement = 'hard'
     AND account.limit_tokens - account.settled_tokens - account.reserved_tokens < p_amount_tokens THEN
    RAISE EXCEPTION 'quota_exhausted' USING ERRCODE = 'P0001';
  END IF;
  UPDATE work.quota_account ba
  SET reserved_tokens = ba.reserved_tokens + p_amount_tokens,
      version = ba.version + 1,
      updated_at = now()
  WHERE ba.id = account.id;
  INSERT INTO work.quota_reservation
    (id, org_id, account_id, operation_id, reservation_seq, amount_tokens, state)
  VALUES
    (reservation_id, p_org_id, account.id, p_operation_id, next_seq, p_amount_tokens, 'held');
  INSERT INTO work.quota_entry
    (org_id, account_id, reservation_id, operation_id, kind, amount_tokens)
  VALUES
    (p_org_id, account.id, reservation_id, p_operation_id, 'reserve', p_amount_tokens);
  RETURN reservation_id;
END;
$$;

-- Usage gets its own persistent idempotency marker. A settle entry is not a
-- substitute: record_usage can run before settle and can be replayed after an
-- ACK loss.
CREATE OR REPLACE FUNCTION work.record_usage(
  p_org_id text,
  p_subject_id text,
  p_operation_id uuid,
  p_provider text,
  p_model text,
  p_usage_date date,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cached_input_tokens bigint,
  p_runs int DEFAULT 1
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF p_provider NOT IN ('aliyun', 'volcengine', 'deepseek') THEN
    RAISE EXCEPTION 'invalid_request:provider' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(btrim(p_model)) = 0 THEN
    RAISE EXCEPTION 'invalid_request:model' USING ERRCODE = '22023';
  END IF;
  IF p_usage_date IS NULL OR p_input_tokens < 0 OR p_output_tokens < 0
     OR p_cached_input_tokens < 0 OR p_runs < 0 THEN
    RAISE EXCEPTION 'invalid_request:usage' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.operation o
    WHERE o.id = p_operation_id AND o.org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE work.operation o
  SET usage_recorded_at = now(), updated_at = now()
  WHERE o.id = p_operation_id AND o.org_id = p_org_id
    AND o.usage_recorded_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO work.usage_daily AS u
    (org_id, subject_id, provider, model, usage_date,
     input_tokens, output_tokens, cached_input_tokens, run_count, revision)
  VALUES
    (p_org_id, p_subject_id, p_provider, btrim(p_model), p_usage_date,
     p_input_tokens, p_output_tokens, p_cached_input_tokens, p_runs, 1)
  ON CONFLICT (org_id, subject_id, provider, model, usage_date) DO UPDATE
  SET input_tokens = u.input_tokens + EXCLUDED.input_tokens,
      output_tokens = u.output_tokens + EXCLUDED.output_tokens,
      cached_input_tokens = u.cached_input_tokens + EXCLUDED.cached_input_tokens,
      run_count = u.run_count + EXCLUDED.run_count,
      revision = u.revision + 1,
      updated_at = now();
END;
$$;

-- Absence is evaluated against the Host snapshot revision that produced the
-- present set, not the latest ORG revision. An older full snapshot therefore
-- cannot borrow a newer watermark and mark a newly added member absent.
DROP FUNCTION IF EXISTS work.mark_members_absent(text, text[], boolean);
CREATE FUNCTION work.mark_members_absent(
  p_org_id text,
  p_present_subjects text[],
  p_allow_mass_absence boolean,
  p_snapshot_revision bigint
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  member_row work.member%ROWTYPE;
  current_revision bigint;
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
    RAISE EXCEPTION 'invalid_request:mass_absence' USING ERRCODE = '22023';
  END IF;
  IF p_snapshot_revision IS NULL OR p_snapshot_revision < 1 THEN
    RAISE EXCEPTION 'invalid_request:snapshot_revision' USING ERRCODE = '22023';
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

  SELECT o.revision INTO current_revision
  FROM work.org o
  WHERE o.id = p_org_id
  FOR UPDATE;
  IF current_revision IS NULL THEN
    RAISE EXCEPTION 'directory_org_missing' USING ERRCODE = 'P0001';
  END IF;
  IF p_snapshot_revision > current_revision THEN
    RAISE EXCEPTION 'directory_snapshot_ahead' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO total_members
  FROM work.member
  WHERE org_id = p_org_id
    AND status <> 'left'
    AND revision < p_snapshot_revision;
  SELECT count(*) INTO absent_count
  FROM work.member
  WHERE org_id = p_org_id
    AND status <> 'left'
    AND revision < p_snapshot_revision
    AND NOT (subject_id = ANY (p_present_subjects));
  threshold := GREATEST(10, CEIL(total_members * 0.20)::integer);

  IF NOT p_allow_mass_absence AND absent_count >= threshold THEN
    PERFORM work.append_audit(
      p_org_id, NULL, 'directory.member_absence_blocked', 'org', p_org_id,
      jsonb_build_object(
        'revision', p_snapshot_revision,
        'current_revision', current_revision,
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
      AND revision < p_snapshot_revision
      AND NOT (subject_id = ANY (p_present_subjects))
    ORDER BY subject_id
    FOR UPDATE
  LOOP
    UPDATE work.member
    SET status = 'left',
        work_seat = false,
        revision = p_snapshot_revision,
        updated_at = now()
    WHERE id = member_row.id;
    PERFORM work.append_audit(
      p_org_id, NULL, 'directory.member_absent', 'member', member_row.subject_id,
      jsonb_build_object(
        'revision', p_snapshot_revision,
        'current_revision', current_revision,
        'previous_status', member_row.status,
        'work_seat_revoked', member_row.work_seat,
        'entitlement_lost', member_row.status = 'active' OR member_row.work_seat
      )
    );
    affected := affected + 1;
  END LOOP;

  PERFORM work.append_audit(
    p_org_id, NULL, 'directory.member_absence_applied', 'org', p_org_id,
    jsonb_build_object(
      'revision', p_snapshot_revision,
      'current_revision', current_revision,
      'absent', affected,
      'total', total_members,
      'threshold', threshold,
      'allow_mass_absence', p_allow_mass_absence
    )
  );
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION work.reserve_quota(text, text, text, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.reserve_quota(text, text, text, uuid, bigint) TO work_worker;
REVOKE ALL ON FUNCTION work.record_usage(text, text, uuid, text, text, date, bigint, bigint, bigint, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.record_usage(text, text, uuid, text, text, date, bigint, bigint, bigint, int) TO work_worker;
REVOKE ALL ON FUNCTION work.mark_members_absent(text, text[], boolean, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.mark_members_absent(text, text[], boolean, bigint) TO work_directory;

-- 0006 opened these functions to PUBLIC. Keep only the worker entry point.
REVOKE ALL ON FUNCTION work.ensure_quota_account(text, text, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.provision_org_defaults(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.provision_org_after_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.ensure_quota_account(text, text, text, bigint, text) TO work_worker;

RESET ROLE;
