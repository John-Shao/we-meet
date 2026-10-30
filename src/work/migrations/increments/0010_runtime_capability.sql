-- 0010: F0-R4 runtime capability metadata and its issue/authorize/revoke
-- commands.
--
-- Authority: D1 §5.5 "F0-R4/R5 Capability 与内容代理授权增量" (runtime_capability
-- shape, token plaintext never stored, token_hash unique, one generation per
-- (execution, audience), generations are never reused, ENABLE/FORCE RLS,
-- composite tenant FKs, fixed search_path), D4 §6.2 "F0-R4 身份签发与父子凭据
-- 隔离" (issue only for the current holder of an active fragment; token TTL =
-- min(db_now + 30s, lease_until, hard_deadline); a refresh immediately
-- invalidates the previous generation; authorization is checked online on
-- every request and never cached) and D4 §6.3 (separate content/egress
-- audiences, fail closed when the authorization backend is unavailable).
--
-- Node/egress never hold a database login. The control plane's internal
-- execution-authorization module calls these SECURITY DEFINER commands as
-- work_worker; work_api and work_directory get nothing. There is no table-level
-- DML grant: the credential table is reachable only through the commands.
--
-- The bearer token itself is NEVER stored. Only the lowercase-hex SHA-256
-- digest produced by the caller is persisted; the digest is an online lookup
-- key, not a second bearer.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Hard ceiling for a capability lifetime. The 30s policy is enforced by the
-- issuer; this bound is defense in depth and leaves room for caller/database
-- clock skew. The effective expiry is additionally clamped to the execution
-- lease and hard deadline inside issue_runtime_capability.
CREATE FUNCTION work.runtime_capability_max_seconds() RETURNS int
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
  SELECT LEAST(600, GREATEST(1,
    COALESCE(NULLIF(current_setting('work.runtime_capability_max_seconds', true), ''), '120')::int));
$$;

-- ---------------------------------------------------------------------------
-- Persistent object
-- ---------------------------------------------------------------------------

-- One issued capability. binding columns are immutable; revocation is a
-- one-way timestamp. Rows are never deleted: an old generation stays as audit
-- evidence and can never authorize again because authorize requires the
-- current (highest) generation for the (execution, audience) pair.
CREATE TABLE work.runtime_capability (
  credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  execution_id uuid NOT NULL,
  holder_id text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('work-content', 'work-egress')),
  generation int NOT NULL CHECK (generation >= 1),
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_hash),
  UNIQUE (org_id, execution_id, audience, generation),
  FOREIGN KEY (execution_id, org_id)
    REFERENCES work.runtime_execution(execution_id, org_id),
  CONSTRAINT runtime_capability_window CHECK (expires_at > issued_at),
  CONSTRAINT runtime_capability_holder_shape CHECK (holder_id <> '')
);

-- Authorisation lookups: the bearer digest resolves through the unique
-- token_hash index; the (org, execution, audience, generation) unique key
-- bounds the generation read; live rows are scanned by execution on revoke.
CREATE INDEX work_runtime_capability_live
  ON work.runtime_capability(org_id, execution_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE work.runtime_capability ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.runtime_capability FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.runtime_capability
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- ---------------------------------------------------------------------------
-- Immutability and revocation guards
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.runtime_capability_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.holder_id IS DISTINCT FROM OLD.holder_id
     OR NEW.audience IS DISTINCT FROM OLD.audience
     OR NEW.generation IS DISTINCT FROM OLD.generation
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'runtime_capability_binding_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'runtime_capability_revocation_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER runtime_capability_guard BEFORE UPDATE ON work.runtime_capability
  FOR EACH ROW EXECUTE FUNCTION work.runtime_capability_guard();
-- Generations are never reused, so a credential row is never deleted either.
CREATE TRIGGER runtime_capability_no_delete BEFORE DELETE ON work.runtime_capability
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

-- ---------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------

-- Issue a capability for the current holder of an active, unexpired fragment
-- whose Run is current. The generation for (execution, audience) advances by
-- one; the previous generation stays in place and stops authorizing
-- immediately. A replay of the latest generation with the same digest is
-- idempotent; a digest for an older generation, or a replay of a revoked or
-- expired generation, is a conflict rather than a resurrected authority.
CREATE FUNCTION work.issue_runtime_capability(
  p_org_id text,
  p_execution_id uuid,
  p_holder_id text,
  p_audience text,
  p_token_hash text,
  p_expires_at timestamptz
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  execution_row work.runtime_execution%ROWTYPE;
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  latest work.runtime_capability%ROWTYPE;
  v_credential_id uuid;
  v_now timestamptz;
  v_expires timestamptz;
  v_generation int;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  PERFORM work.assert_runtime_identifier('holder_id', p_holder_id);
  IF p_execution_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:execution_id' USING ERRCODE = '22023';
  END IF;
  IF p_audience IS NULL OR p_audience NOT IN ('work-content', 'work-egress') THEN
    RAISE EXCEPTION 'invalid_request:audience' USING ERRCODE = '22023';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request:token_hash' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Unified lock order: Task -> Run -> runtime_execution -> capability.
  run_row := work.lock_runtime_run(p_org_id, execution_row.run_id);
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id;
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id
  FOR UPDATE;
  v_now := clock_timestamp();

  IF execution_row.state <> 'active' THEN
    RAISE EXCEPTION 'runtime_capability_not_issuable' USING ERRCODE = 'P0001',
      DETAIL = execution_row.state;
  END IF;
  IF execution_row.holder_id IS DISTINCT FROM p_holder_id THEN
    RAISE EXCEPTION 'runtime_execution_holder_mismatch' USING ERRCODE = '42501';
  END IF;
  IF execution_row.lease_until <= v_now OR execution_row.hard_deadline <= v_now THEN
    -- Refuse only; the expiry is committed by renew/register.
    RAISE EXCEPTION 'runtime_execution_expired' USING ERRCODE = 'P0001';
  END IF;
  -- The content audience is the only one a plan fragment may hold; the model
  -- egress audience exists only for an execute fragment bound to an
  -- operation/attempt/request hash (D4 §6.2 item 2).
  IF (execution_row.mode = 'plan' AND p_audience <> 'work-content')
     OR (execution_row.mode = 'execute' AND p_audience <> 'work-egress') THEN
    RAISE EXCEPTION 'runtime_capability_audience_not_allowed' USING ERRCODE = 'P0001',
      DETAIL = execution_row.mode;
  END IF;
  PERFORM work.assert_org_execution_enabled(p_org_id);
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active' OR run_row.fence <> execution_row.run_fence THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= v_now
     OR p_expires_at > v_now + make_interval(secs => work.runtime_capability_max_seconds()) THEN
    RAISE EXCEPTION 'invalid_request:expires_at' USING ERRCODE = '22023';
  END IF;
  -- Token TTL = min(requested, lease_until, hard_deadline): issuance never
  -- extends the lease and never outlives the fragment.
  v_expires := LEAST(p_expires_at, execution_row.lease_until, execution_row.hard_deadline);

  SELECT * INTO latest
  FROM work.runtime_capability c
  WHERE c.org_id = p_org_id AND c.execution_id = p_execution_id
    AND c.audience = p_audience
  ORDER BY c.generation DESC
  LIMIT 1
  FOR UPDATE;

  IF latest.credential_id IS NOT NULL THEN
    IF latest.token_hash = p_token_hash THEN
      -- Same-generation replay of the same digest. A revoked or expired
      -- generation is never revived by a retry.
      IF latest.revoked_at IS NOT NULL OR latest.expires_at <= v_now THEN
        RAISE EXCEPTION 'runtime_capability_conflict' USING ERRCODE = 'P0001';
      END IF;
      RETURN latest.generation;
    END IF;
    v_generation := latest.generation + 1;
  ELSE
    v_generation := 1;
  END IF;

  -- A digest may only ever belong to one issued capability. Anything left here
  -- is a reuse of an older, revoked or foreign digest, which conflicts instead
  -- of minting a new generation.
  IF EXISTS (
    SELECT 1 FROM work.runtime_capability c
    WHERE c.token_hash = p_token_hash
  ) THEN
    RAISE EXCEPTION 'runtime_capability_token_conflict' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO work.runtime_capability
      (org_id, execution_id, holder_id, audience, generation, token_hash,
       issued_at, expires_at)
    VALUES
      (p_org_id, p_execution_id, p_holder_id, p_audience, v_generation,
       p_token_hash, v_now, v_expires)
    RETURNING credential_id INTO v_credential_id;
  EXCEPTION WHEN unique_violation THEN
    -- Another issuer claimed this generation with a different digest. Never
    -- silently turn that into the next generation.
    RAISE EXCEPTION 'runtime_capability_generation_conflict' USING ERRCODE = 'P0001';
  END;

  PERFORM work.append_audit(
    p_org_id, NULL, 'runtime.capability_issued', 'runtime_execution', p_execution_id::text,
    jsonb_build_object(
      'credential_id', v_credential_id, 'audience', p_audience,
      'generation', v_generation, 'holder_id', p_holder_id,
      'expires_at', v_expires
    )
  );
  RETURN v_generation;
END;
$$;

-- Online authorisation of one bearer. Every condition is re-read from trusted
-- records at call time; nothing about the answer is cacheable. Any failure
-- returns false and says nothing about which condition failed. Only a missing
-- or foreign tenant context is an error, because that is a caller fault.
CREATE FUNCTION work.authorize_runtime_capability(
  p_org_id text,
  p_execution_id uuid,
  p_audience text,
  p_generation int,
  p_token_hash text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  capability_row work.runtime_capability%ROWTYPE;
  execution_row work.runtime_execution%ROWTYPE;
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_now timestamptz;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  -- Malformed bearer metadata is simply not authorized.
  IF p_execution_id IS NULL OR p_audience IS NULL
     OR p_audience NOT IN ('work-content', 'work-egress')
     OR p_generation IS NULL OR p_generation < 1
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  SELECT * INTO capability_row
  FROM work.runtime_capability c
  WHERE c.org_id = p_org_id AND c.execution_id = p_execution_id
    AND c.audience = p_audience AND c.generation = p_generation
    AND c.token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  v_now := clock_timestamp();
  IF capability_row.revoked_at IS NOT NULL OR capability_row.expires_at <= v_now THEN
    RETURN false;
  END IF;
  -- Only the current generation authorizes; a superseded generation is kept
  -- for audit but is dead from the moment the next one commits.
  IF EXISTS (
    SELECT 1 FROM work.runtime_capability c
    WHERE c.org_id = p_org_id AND c.execution_id = p_execution_id
      AND c.audience = p_audience AND c.generation > p_generation
  ) THEN
    RETURN false;
  END IF;

  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF execution_row.state <> 'active'
     OR execution_row.holder_id IS DISTINCT FROM capability_row.holder_id
     OR execution_row.lease_until <= v_now
     OR execution_row.hard_deadline <= v_now THEN
    RETURN false;
  END IF;
  -- Mode narrowing is re-checked online: a plan fragment may only present the
  -- content audience, an execute fragment only the model egress audience.
  IF (execution_row.mode = 'plan' AND p_audience <> 'work-content')
     OR (execution_row.mode = 'execute' AND p_audience <> 'work-egress') THEN
    RETURN false;
  END IF;
  SELECT * INTO run_row
  FROM work.run r
  WHERE r.id = execution_row.run_id AND r.org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT * INTO task_row
  FROM work.task t
  WHERE t.id = run_row.task_id AND t.org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active' OR run_row.fence <> execution_row.run_fence THEN
    RETURN false;
  END IF;
  -- A suspended or execution-disabled organization fails closed.
  IF NOT EXISTS (
    SELECT 1 FROM work.org o
    WHERE o.id = p_org_id AND o.status = 'active'
      AND o.execution_enabled AND NOT o.operator_suspended
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- Revoke every live generation of one execution. Idempotent: the second call
-- revokes nothing. The audit row records the call either way. Revocation is
-- visible to the very next authorize call; there is no sweeper in the path.
CREATE FUNCTION work.revoke_runtime_capability(
  p_org_id text,
  p_execution_id uuid,
  p_reason text
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  execution_row work.runtime_execution%ROWTYPE;
  v_count int;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF work.reason_code(p_reason) IS NULL THEN
    RAISE EXCEPTION 'invalid_request:reason' USING ERRCODE = '22023';
  END IF;
  IF p_execution_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:execution_id' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM work.lock_runtime_run(p_org_id, execution_row.run_id);
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id
  FOR UPDATE;

  UPDATE work.runtime_capability c
  SET revoked_at = clock_timestamp(), updated_at = now()
  WHERE c.org_id = p_org_id AND c.execution_id = p_execution_id
    AND c.revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM work.append_audit(
    p_org_id, NULL, 'runtime.capability_revoked', 'runtime_execution', p_execution_id::text,
    jsonb_build_object(
      'reason', p_reason, 'revoked_generations', v_count,
      'execution_state', execution_row.state
    )
  );
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: work_worker only (the control plane's internal execution
-- authorization module). Nothing for work_api/work_directory, and no
-- table-level DML at all.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION work.runtime_capability_max_seconds() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.runtime_capability_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.issue_runtime_capability(text, uuid, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.authorize_runtime_capability(text, uuid, text, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.revoke_runtime_capability(text, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION work.issue_runtime_capability(text, uuid, text, text, text, timestamptz) TO work_worker;
GRANT EXECUTE ON FUNCTION work.authorize_runtime_capability(text, uuid, text, int, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.revoke_runtime_capability(text, uuid, text) TO work_worker;

RESET ROLE;
