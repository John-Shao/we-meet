-- ---------------------------------------------------------------------------
-- 管理只读（U2 方案 B）与 Host 目录投影写入（ADR-0021）
--
-- 方案 B 的前提是：R0a 管理读接口自己提供 role/revision/cents 账本与异步导出作业，
-- P1-A 只负责读权限与主组织上下文。因此这些数据必须在 work schema 内有真实落点，
-- 否则 OpenAPI 承诺的作业生命周期与席位/预算字段只能由服务端伪造。
--
-- ADR-0021 的落地：work.org / work.member 是 Host IdentityDirectory/Entitlement 的
-- 投影，只有 work_directory 角色能通过 sync_* 命令写入；应用与 worker 角色不能直接 DML，
-- 也不能读 work.audit_export（只能经领域函数），避免跨成员泄露导出作业元数据。
-- ---------------------------------------------------------------------------

CREATE TABLE work.audit_export (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES work.org(id),
  requested_by text NOT NULL,
  client_request_id text NOT NULL,
  request_hash text NOT NULL,
  range_from timestamptz NOT NULL,
  range_to timestamptz NOT NULL,
  format text NOT NULL CHECK (format IN ('csv', 'json')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ready', 'expired', 'failed')),
  content_ref text,
  content_hash text,
  bytes bigint CHECK (bytes IS NULL OR bytes >= 0),
  row_count bigint CHECK (row_count IS NULL OR row_count >= 0),
  error_code text,
  lease_owner text,
  lease_until timestamptz,
  ready_at timestamptz,
  expires_at timestamptz,
  download_token_hash text,
  download_expires_at timestamptz,
  downloaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, client_request_id),
  CHECK (range_from < range_to),
  CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  -- ready 作业必须有内容引用与有效期；未 ready 不得留下引用。
  CHECK ((status = 'ready') = (content_ref IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (downloaded_at IS NULL OR download_token_hash IS NOT NULL)
);

ALTER TABLE work.org ADD COLUMN name text;
CREATE INDEX work_audit_export_queued
  ON work.audit_export(org_id, created_at)
  WHERE status = 'queued';
CREATE INDEX work_audit_export_expiry ON work.audit_export(expires_at)
  WHERE status = 'ready';

-- ---------------------------------------------------------------------------
-- Host 目录投影写入（IdentityDirectory / Entitlement 适配器唯一入口）
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.sync_org_projection(
  p_org_id text,
  p_name text,
  p_status text,
  p_execution_enabled boolean,
  p_home_region text,
  p_revision bigint
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  current_revision bigint;
  applied_revision bigint;
BEGIN
  IF p_org_id IS NULL OR p_org_id = '' OR p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'directory_org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) = 0 OR char_length(p_name) > 128 THEN
    RAISE EXCEPTION 'invalid_request:org_name' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'suspended', 'archived') THEN
    RAISE EXCEPTION 'invalid_request:org_status' USING ERRCODE = '22023';
  END IF;
  IF p_execution_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid_request:execution_enabled' USING ERRCODE = '22023';
  END IF;
  IF p_home_region IS NULL OR p_home_region !~ '^[a-z0-9-]{3,64}$' THEN
    RAISE EXCEPTION 'invalid_request:home_region' USING ERRCODE = '22023';
  END IF;
  IF p_revision IS NULL OR p_revision <= 0 THEN
    RAISE EXCEPTION 'invalid_request:revision' USING ERRCODE = '22023';
  END IF;

  SELECT o.revision INTO current_revision FROM work.org o WHERE o.id = p_org_id;
  IF current_revision IS NOT NULL AND p_revision <= current_revision THEN
    RAISE EXCEPTION 'projection_revision_stale' USING ERRCODE = 'P0001';
  END IF;

  -- 只读校验挡不住并发写：两个同步可能同时读到旧修订号。
  -- 单调性由 DO UPDATE 的 WHERE 保证，读校验只用于给出更早的错误。
  INSERT INTO work.org (id, name, status, execution_enabled, home_region, revision)
  VALUES (p_org_id, btrim(p_name), p_status, p_execution_enabled, p_home_region, p_revision)
  ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        status = EXCLUDED.status,
        execution_enabled = EXCLUDED.execution_enabled,
        home_region = EXCLUDED.home_region,
        revision = EXCLUDED.revision,
        updated_at = now()
    WHERE work.org.revision < EXCLUDED.revision
  RETURNING work.org.revision INTO applied_revision;
  IF applied_revision IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION 'projection_revision_stale' USING ERRCODE = 'P0001';
  END IF;

  -- operator_suspended 只由运维停用路径设置，目录同步不得覆盖。
  PERFORM work.append_audit(
    p_org_id, NULL, 'directory.org_synced', 'org', p_org_id,
    jsonb_build_object('revision', p_revision, 'status', p_status,
                       'execution_enabled', p_execution_enabled)
  );
  RETURN p_revision;
END;
$$;

CREATE FUNCTION work.sync_member_projection(
  p_org_id text,
  p_subject_id text,
  p_status text,
  p_role text,
  p_work_seat boolean,
  p_revision bigint
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  member_row work.member%ROWTYPE;
  member_id uuid;
  entitlement_lost boolean := false;
BEGIN
  IF p_org_id IS NULL OR p_org_id = '' OR p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'directory_org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_subject_id IS NULL OR p_subject_id !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN
    RAISE EXCEPTION 'invalid_request:subject_id' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('invited', 'active', 'suspended', 'left') THEN
    RAISE EXCEPTION 'invalid_request:member_status' USING ERRCODE = '22023';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'member', 'viewer') THEN
    RAISE EXCEPTION 'invalid_request:member_role' USING ERRCODE = '22023';
  END IF;
  IF p_work_seat IS NULL THEN
    RAISE EXCEPTION 'invalid_request:work_seat' USING ERRCODE = '22023';
  END IF;
  IF p_revision IS NULL OR p_revision <= 0 THEN
    RAISE EXCEPTION 'invalid_request:revision' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO member_row
  FROM work.member m
  WHERE m.org_id = p_org_id AND m.subject_id = p_subject_id
  FOR UPDATE;
  IF FOUND THEN
    IF p_revision <= member_row.revision THEN
      RAISE EXCEPTION 'projection_revision_stale' USING ERRCODE = 'P0001';
    END IF;
    entitlement_lost := (member_row.work_seat AND NOT p_work_seat)
      OR (member_row.status = 'active' AND p_status IN ('suspended', 'left'));
  END IF;

  -- 行锁只覆盖已存在的成员：新成员的两个并发写由 DO UPDATE 的修订号守卫裁决，
  -- 否则低修订号会在读-写窗口里覆盖高修订号（投影必须单调）。
  INSERT INTO work.member
    (org_id, subject_id, status, role, work_seat, revision)
  VALUES
    (p_org_id, p_subject_id, p_status, p_role, p_work_seat, p_revision)
  ON CONFLICT (org_id, subject_id) DO UPDATE
    SET status = EXCLUDED.status,
        role = EXCLUDED.role,
        work_seat = EXCLUDED.work_seat,
        revision = EXCLUDED.revision,
        updated_at = now()
    WHERE work.member.revision < EXCLUDED.revision
  RETURNING id INTO member_id;
  IF member_id IS NULL THEN
    RAISE EXCEPTION 'projection_revision_stale' USING ERRCODE = 'P0001';
  END IF;

  -- 收窄只落投影；在途 Run 的停止走 sanctioned request_cancel（D3），
  -- 投影写入不直接杀 Run，避免目录同步与编排抢同一状态机。
  PERFORM work.append_audit(
    p_org_id, NULL, 'directory.member_synced', 'member', p_subject_id,
    jsonb_build_object(
      'revision', p_revision,
      'status', p_status,
      'role', p_role,
      'work_seat', p_work_seat,
      'entitlement_lost', entitlement_lost
    )
  );
  RETURN member_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 管理只读聚合（预算 cents、席位、策略）
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.assert_org_admin(p_org_id text, p_subject_id text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.assert_session_subject(p_subject_id);
  IF NOT EXISTS (
    SELECT 1 FROM work.member m
    WHERE m.org_id = p_org_id
      AND m.subject_id = p_subject_id
      AND m.status = 'active'
      AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'admin_access_denied' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION work.admin_overview(
  p_org_id text,
  p_subject_id text,
  p_account_key text DEFAULT 'default',
  p_period_id text DEFAULT to_char(date_trunc('month', now()), 'YYYY-MM')
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  org_row work.org%ROWTYPE;
  account work.budget_account%ROWTYPE;
  policy_row work.org_policy%ROWTYPE;
  seat_total bigint;
  seat_active bigint;
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);

  SELECT * INTO org_row FROM work.org o WHERE o.id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) FILTER (WHERE m.status <> 'left'),
         count(*) FILTER (WHERE m.status = 'active' AND m.work_seat)
    INTO seat_total, seat_active
  FROM work.member m
  WHERE m.org_id = p_org_id;

  SELECT * INTO account
  FROM work.budget_account b
  WHERE b.org_id = p_org_id AND b.account_key = p_account_key AND b.period_id = p_period_id;

  SELECT * INTO policy_row FROM work.org_policy p WHERE p.org_id = p_org_id;

  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'admin.overview_read', 'org', p_org_id,
    jsonb_build_object('account_key', p_account_key, 'period_id', p_period_id)
  );

  RETURN jsonb_build_object(
    'org_id', org_row.id,
    'name', org_row.name,
    'status', org_row.status,
    'execution_enabled', org_row.execution_enabled AND NOT org_row.operator_suspended,
    'seats', jsonb_build_object('total', seat_total, 'active', seat_active),
    'budget', jsonb_build_object(
      'currency', COALESCE(account.currency, 'CNY'),
      'limit_cents', COALESCE(account.limit_cents, 0),
      'reserved_cents', COALESCE(account.reserved_cents, 0),
      'settled_cents', COALESCE(account.settled_cents, 0)
    ),
    'budget_period_id', p_period_id,
    'org_revision', org_row.revision,
    'audit_retention_days',
      COALESCE(NULLIF(policy_row.policy->>'audit_retention_days', '')::int, 365)
  );
END;
$$;

CREATE FUNCTION work.list_seats(
  p_org_id text,
  p_subject_id text,
  p_cursor text DEFAULT NULL,
  p_limit integer DEFAULT 20
) RETURNS TABLE (
  subject_id text,
  role text,
  work_seat boolean,
  status text,
  revision bigint
)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid_pagination' USING ERRCODE = '22023';
  END IF;
  IF p_cursor IS NOT NULL AND p_cursor = '' THEN
    RAISE EXCEPTION 'invalid_pagination' USING ERRCODE = '22023';
  END IF;

  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'admin.seats_read', 'org', p_org_id,
    jsonb_build_object('limit', p_limit, 'has_cursor', p_cursor IS NOT NULL)
  );

  RETURN QUERY
  SELECT m.subject_id, m.role, m.work_seat, m.status, m.revision
  FROM work.member m
  WHERE m.org_id = p_org_id
    AND m.status <> 'left'
    AND (p_cursor IS NULL OR m.subject_id > p_cursor)
  ORDER BY m.subject_id
  LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- 异步审计导出作业（queued -> running -> ready -> expired / failed）
-- 只导出审计元数据，不含任务/成果正文；下载令牌一次性、短期、按组织绑定。
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.audit_export_view(p_row work.audit_export) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', p_row.id,
    'status', p_row.status,
    'format', p_row.format,
    'range_from', p_row.range_from,
    'range_to', p_row.range_to,
    'requested_by', p_row.requested_by,
    'requested_at', p_row.created_at,
    'ready_at', p_row.ready_at,
    'expires_at', p_row.expires_at,
    'row_count', p_row.row_count,
    'bytes', p_row.bytes,
    'error_code', p_row.error_code,
    'download_available', p_row.status = 'ready' AND p_row.downloaded_at IS NULL
      AND p_row.expires_at > now(),
    'downloaded_at', p_row.downloaded_at
  );
$$;

CREATE FUNCTION work.create_audit_export(
  p_org_id text,
  p_subject_id text,
  p_client_request_id text,
  p_range_from timestamptz,
  p_range_to timestamptz,
  p_format text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
  retention int;
  req_hash text;
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  IF p_client_request_id IS NULL OR char_length(btrim(p_client_request_id)) < 8
     OR char_length(p_client_request_id) > 128 THEN
    RAISE EXCEPTION 'invalid_request:client_request_id' USING ERRCODE = '22023';
  END IF;
  IF p_format IS NULL OR p_format NOT IN ('csv', 'json') THEN
    RAISE EXCEPTION 'invalid_request:export_format' USING ERRCODE = '22023';
  END IF;
  IF p_range_from IS NULL OR p_range_to IS NULL OR p_range_from >= p_range_to THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_range_to > now() THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(NULLIF(op.policy->>'audit_retention_days', '')::int, 365)
    INTO retention
  FROM work.org_policy op WHERE op.org_id = p_org_id;
  IF retention IS NULL THEN
    retention := 365;
  END IF;
  IF p_range_from < now() - make_interval(days => retention) THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_range_to - p_range_from > make_interval(days => 92) THEN
    RAISE EXCEPTION 'audit_export_range_invalid' USING ERRCODE = 'P0001';
  END IF;

  req_hash := work.sha256_text(jsonb_build_object(
    'client_request_id', p_client_request_id,
    'range_from', p_range_from,
    'range_to', p_range_to,
    'format', p_format
  )::text);

  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.org_id = p_org_id AND e.client_request_id = p_client_request_id
  FOR UPDATE;

  IF FOUND THEN
    IF export_row.request_hash <> req_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN work.audit_export_view(export_row);
  END IF;

  INSERT INTO work.audit_export
    (org_id, requested_by, client_request_id, request_hash, range_from, range_to, format, status)
  VALUES
    (p_org_id, p_subject_id, p_client_request_id, req_hash, p_range_from, p_range_to, p_format, 'queued')
  RETURNING * INTO export_row;

  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'audit_export.requested', 'audit_export', export_row.id::text,
    jsonb_build_object('format', p_format, 'range_from', p_range_from, 'range_to', p_range_to)
  );
  RETURN work.audit_export_view(export_row);
END;
$$;

CREATE FUNCTION work.get_audit_export(
  p_org_id text,
  p_subject_id text,
  p_export_id uuid
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.id = p_export_id AND e.org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_export_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF export_row.status = 'ready' AND export_row.expires_at <= now() THEN
    UPDATE work.audit_export e
      SET status = 'expired', expires_at = NULL, updated_at = now()
    WHERE e.id = export_row.id
    RETURNING * INTO export_row;
    PERFORM work.append_audit(
      p_org_id, NULL, 'audit_export.expired', 'audit_export', export_row.id::text, '{}'::jsonb
    );
  END IF;
  RETURN work.audit_export_view(export_row);
END;
$$;

CREATE FUNCTION work.claim_audit_export(
  p_export_id uuid,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 600
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'invalid_request:worker_id' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_request:lease_seconds' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.id = p_export_id AND e.org_id = current_setting('app.org_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_export_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF export_row.status = 'running' AND export_row.lease_until > now() THEN
    RAISE EXCEPTION 'audit_export_not_claimable' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.status NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'audit_export_not_claimable' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.audit_export e
    SET status = 'running',
        lease_owner = p_worker_id,
        lease_until = now() + make_interval(secs => p_lease_seconds),
        error_code = NULL,
        updated_at = now()
  WHERE e.id = export_row.id
  RETURNING * INTO export_row;

  PERFORM work.append_audit(
    export_row.org_id, NULL, 'audit_export.claimed', 'audit_export', export_row.id::text,
    jsonb_build_object('worker_id', p_worker_id)
  );
  RETURN work.audit_export_view(export_row);
END;
$$;

CREATE FUNCTION work.complete_audit_export(
  p_export_id uuid,
  p_worker_id text,
  p_content_ref text,
  p_content_hash text,
  p_bytes bigint,
  p_row_count bigint,
  p_ttl_seconds integer DEFAULT 86400
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  IF p_content_ref IS NULL OR p_content_ref !~ '^content://' THEN
    RAISE EXCEPTION 'invalid_request:content_ref' USING ERRCODE = '22023';
  END IF;
  IF p_content_hash IS NULL OR p_content_hash !~ '^sha256:[0-9a-f]{8,}$' THEN
    RAISE EXCEPTION 'invalid_request:content_hash' USING ERRCODE = '22023';
  END IF;
  IF p_bytes IS NULL OR p_bytes < 0 OR p_row_count IS NULL OR p_row_count < 0 THEN
    RAISE EXCEPTION 'invalid_request:export_size' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 300 OR p_ttl_seconds > 604800 THEN
    RAISE EXCEPTION 'invalid_request:ttl_seconds' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.id = p_export_id AND e.org_id = current_setting('app.org_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_export_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF export_row.status <> 'running'
     OR export_row.lease_owner IS DISTINCT FROM p_worker_id
     OR export_row.lease_until <= now() THEN
    RAISE EXCEPTION 'audit_export_lease_lost' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.audit_export e
    SET status = 'ready',
        content_ref = p_content_ref,
        content_hash = p_content_hash,
        bytes = p_bytes,
        row_count = p_row_count,
        ready_at = now(),
        expires_at = now() + make_interval(secs => p_ttl_seconds),
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = now()
  WHERE e.id = export_row.id
  RETURNING * INTO export_row;

  PERFORM work.append_audit(
    export_row.org_id, NULL, 'audit_export.completed', 'audit_export', export_row.id::text,
    jsonb_build_object('row_count', p_row_count, 'bytes', p_bytes, 'content_hash', p_content_hash)
  );
  RETURN work.audit_export_view(export_row);
END;
$$;

CREATE FUNCTION work.fail_audit_export(
  p_export_id uuid,
  p_worker_id text,
  p_error_code text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  PERFORM work.reason_code(p_error_code);
  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.id = p_export_id AND e.org_id = current_setting('app.org_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_export_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF export_row.status <> 'running'
     OR export_row.lease_owner IS DISTINCT FROM p_worker_id
     OR export_row.lease_until <= now() THEN
    RAISE EXCEPTION 'audit_export_lease_lost' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.audit_export e
    SET status = 'failed',
        error_code = p_error_code,
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = now()
  WHERE e.id = export_row.id
  RETURNING * INTO export_row;

  PERFORM work.append_audit(
    export_row.org_id, NULL, 'audit_export.failed', 'audit_export', export_row.id::text,
    jsonb_build_object('error_code', p_error_code)
  );
  RETURN work.audit_export_view(export_row);
END;
$$;

CREATE FUNCTION work.issue_audit_export_download(
  p_org_id text,
  p_subject_id text,
  p_export_id uuid,
  p_token_hash text,
  p_ttl_seconds integer DEFAULT 300
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request:token_hash' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 900 THEN
    RAISE EXCEPTION 'invalid_request:ttl_seconds' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.id = p_export_id AND e.org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_export_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF export_row.status = 'expired' THEN
    RAISE EXCEPTION 'audit_export_expired' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.status <> 'ready' THEN
    RAISE EXCEPTION 'audit_export_not_ready' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.expires_at <= now() THEN
    RAISE EXCEPTION 'audit_export_expired' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.downloaded_at IS NOT NULL THEN
    RAISE EXCEPTION 'audit_export_already_downloaded' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.audit_export e
    SET download_token_hash = p_token_hash,
        download_expires_at = now() + make_interval(secs => p_ttl_seconds),
        updated_at = now()
  WHERE e.id = export_row.id;

  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'audit_export.ticket_issued', 'audit_export', export_row.id::text,
    jsonb_build_object('expires_at', now() + make_interval(secs => p_ttl_seconds))
  );
  RETURN jsonb_build_object(
    'export_id', export_row.id,
    'expires_at', now() + make_interval(secs => p_ttl_seconds),
    'bytes', export_row.bytes,
    'row_count', export_row.row_count,
    'format', export_row.format
  );
END;
$$;

CREATE FUNCTION work.redeem_audit_export_download(
  p_org_id text,
  p_subject_id text,
  p_token_hash text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  export_row work.audit_export%ROWTYPE;
BEGIN
  PERFORM work.assert_org_admin(p_org_id, p_subject_id);
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'download_token_invalid' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO export_row
  FROM work.audit_export e
  WHERE e.org_id = p_org_id
    AND e.download_token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'download_token_invalid' USING ERRCODE = '42501';
  END IF;
  IF export_row.download_expires_at <= now() THEN
    UPDATE work.audit_export e
      SET download_token_hash = NULL, download_expires_at = NULL, updated_at = now()
    WHERE e.id = export_row.id;
    RAISE EXCEPTION 'download_token_expired' USING ERRCODE = 'P0001';
  END IF;
  IF export_row.downloaded_at IS NOT NULL THEN
    RAISE EXCEPTION 'download_token_invalid' USING ERRCODE = '42501';
  END IF;

  UPDATE work.audit_export e
    SET downloaded_at = now(), updated_at = now()
  WHERE e.id = export_row.id;

  PERFORM work.append_audit(
    p_org_id, p_subject_id, 'audit_export.downloaded', 'audit_export', export_row.id::text,
    jsonb_build_object('bytes', export_row.bytes, 'row_count', export_row.row_count)
  );
  RETURN jsonb_build_object(
    'export_id', export_row.id,
    'content_ref', export_row.content_ref,
    'content_hash', export_row.content_hash,
    'bytes', export_row.bytes,
    'row_count', export_row.row_count,
    'format', export_row.format,
    'expires_at', export_row.expires_at
  );
END;
$$;

CREATE FUNCTION work.expire_due_audit_exports(p_now timestamptz DEFAULT now()) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  affected int;
BEGIN
  UPDATE work.audit_export e
    SET status = 'expired', expires_at = NULL, updated_at = now()
  WHERE e.status = 'ready' AND e.expires_at <= p_now;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- ---------------------------------------------------------------------------
-- 留存清扫作业（D3 §11 非 Run 后台作业的数据库入口）
--
-- 与 relay 不同：这些作业**按组织逐个事务**运行（app.org_id 绑定目标组织），
-- 不需要也不允许跨组织可见性；租户公平由调度层逐轮访问组织保证。
-- 正文只进 Content Store；本库只留引用，清扫的产物是 content_shred outbox 行。
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.input_ttl_hours() RETURNS int
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(1, COALESCE(NULLIF(current_setting('work.input_ttl_hours', true), ''), '24')::int);
$$;

-- 未绑定任务的输入到期：状态落 expired，并按引用投递粉碎请求。
-- 同一 content_ref 若仍被其他未删除输入或成果引用，则只过期不粉碎（与删除路径同一规则）。
CREATE FUNCTION work.expire_due_inputs(p_now timestamptz DEFAULT now()) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  swept int := 0;
  input_row work.input_object%ROWTYPE;
  shared boolean;
BEGIN
  FOR input_row IN
    SELECT * FROM work.input_object i
    WHERE i.status = 'active'
      AND i.task_id IS NULL
      AND i.expires_at IS NOT NULL
      AND i.expires_at <= p_now
    ORDER BY i.expires_at, i.id
    FOR UPDATE
  LOOP
    UPDATE work.input_object i
      SET status = 'expired', deleted_at = now()
    WHERE i.id = input_row.id;
    swept := swept + 1;

    SELECT EXISTS (
      SELECT 1 FROM work.input_object other
      WHERE other.org_id = input_row.org_id
        AND other.content_ref = input_row.content_ref
        AND other.deleted_at IS NULL
        AND other.id <> input_row.id
    ) OR EXISTS (
      SELECT 1 FROM work.artifact_version v
      JOIN work.artifact a ON a.id = v.artifact_id AND a.org_id = v.org_id
      WHERE v.org_id = input_row.org_id
        AND v.content_ref = input_row.content_ref
        AND a.deleted_at IS NULL
    ) INTO shared;

    IF NOT shared THEN
      INSERT INTO work.outbox
        (org_id, aggregate_type, aggregate_id, event_id, payload)
      VALUES
        (input_row.org_id, 'content', input_row.id, gen_random_uuid(),
         jsonb_build_object('kind', 'content_shred', 'input_id', input_row.id,
                            'content_refs', jsonb_build_array(input_row.content_ref)));
    END IF;
  END LOOP;

  IF swept > 0 THEN
    PERFORM work.append_audit(
      current_setting('app.org_id', true), NULL, 'input.expiry_swept', 'org',
      current_setting('app.org_id', true),
      jsonb_build_object('count', swept, 'ttl_hours', work.input_ttl_hours())
    );
  END IF;
  RETURN swept;
END;
$$;

-- 审计导出文件到期后的正文清理：作业行保留（元数据是审计事实），只投递引用粉碎。
CREATE FUNCTION work.shred_due_audit_exports(p_now timestamptz DEFAULT now()) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  swept int := 0;
  export_row work.audit_export%ROWTYPE;
BEGIN
  FOR export_row IN
    SELECT * FROM work.audit_export e
    WHERE e.status = 'expired'
      AND e.content_ref IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM work.outbox o
        WHERE o.org_id = e.org_id
          AND o.aggregate_type = 'content'
          AND o.aggregate_id = e.id
          AND o.payload->>'kind' = 'content_shred'
      )
    ORDER BY e.updated_at, e.id
    FOR UPDATE
  LOOP
    INSERT INTO work.outbox
      (org_id, aggregate_type, aggregate_id, event_id, payload)
    VALUES
      (export_row.org_id, 'content', export_row.id, gen_random_uuid(),
       jsonb_build_object('kind', 'content_shred', 'audit_export_id', export_row.id,
                          'content_refs', jsonb_build_array(export_row.content_ref)));
    UPDATE work.audit_export e
      SET content_ref = NULL, content_hash = NULL, updated_at = now()
    WHERE e.id = export_row.id;
    swept := swept + 1;
  END LOOP;
  IF swept > 0 THEN
    PERFORM work.append_audit(
      current_setting('app.org_id', true), NULL, 'audit_export.shredded', 'org',
      current_setting('app.org_id', true), jsonb_build_object('count', swept)
    );
  END IF;
  RETURN swept;
END;
$$;
