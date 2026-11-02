-- 0020: local_execution_policy - the server-side values every local gate reads.
--
-- Authority: control design §4.1 (the local_execution_policy row: every column
-- NOT NULL with its own closed set, and explicitly *not* hidden inside
-- org_policy.policy jsonb, because the effective org_policy only carries
-- force_ask_each/allow_auto_readonly/allow_plan_approval/run_cap_tokens plus an
-- unvalidated jsonb column - baseline 0002:34-44), §4.2 set_local_policy (revision
-- CAS, epoch advance, audit, and the cancellations that follow a narrowing), §1.4
-- GET/PATCH /admin/local-policy (response shape is these columns, no separate
-- DTO), and the J20/J37 opening preconditions: an organization with no usable
-- mapping is treated as "local execution not enabled" rather than "enabled but
-- mostly unusable". Validation exits: EV70, EV123.
--
-- §4.1 also says a rule set that satisfies "at least one rule" can still leave no
-- destination in use, which is the contradiction J37 closed. Both branches are
-- answers, not gates added here: local_policy_not_configured already covers "no
-- rule or no explicit default confirmation", local_policy_incomplete already
-- covers "no reachable destination". No new code and no new closed set.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- Closed-set helpers
-- ---------------------------------------------------------------------------

-- Classification is ordered by strictness, and the order is written out
-- explicitly. Comparing the strings would rank remote_excerpt_allowed as the
-- stricter value because 'l' < 'r', which is the exact mistake §4.1 constraint (2)
-- forbids.
CREATE FUNCTION work.classification_rank(p_classification text) RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_classification
    WHEN 'local_only' THEN 2
    WHEN 'remote_excerpt_allowed' THEN 1
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION work.classification_rank(text) FROM PUBLIC;

-- A closed set plus no duplicates. Written as a function because a CHECK
-- constraint may not contain a subquery, and array order must not decide whether a
-- policy is "narrower" than another.
CREATE FUNCTION work.text_array_closed_unique(p_values text[], p_allowed text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_values IS NULL
     OR (p_values <@ p_allowed
         AND array_length(p_values, 1) = (
           SELECT count(DISTINCT v) FROM unnest(p_values) AS v
         ));
$$;

REVOKE ALL ON FUNCTION work.text_array_closed_unique(text[], text[]) FROM PUBLIC;

-- A rule is (matcher, determined classification, confirmable ceiling). The ceiling
-- may be stricter than the determination but never looser: users confirm stricter,
-- they never relax. Matchers must be comparable to a device path and are stored
-- uninterpreted here - the Broker is the only component that can resolve a volume
-- serial or a path prefix, so the control plane's job is to reject malformed rules
-- and to hand them down unchanged.
CREATE FUNCTION work.local_execution_policy_rules_valid(
  p_rules jsonb,
  p_floor text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  rule jsonb;
  matcher jsonb;
BEGIN
  IF jsonb_typeof(p_rules) <> 'array'
     OR p_floor IS NULL
     OR work.classification_rank(p_floor) IS NULL THEN
    RETURN false;
  END IF;
  FOR rule IN SELECT * FROM jsonb_array_elements(p_rules) LOOP
    IF jsonb_typeof(rule) <> 'object'
       OR work.classification_rank(rule ->> 'classification') IS NULL
       OR work.classification_rank(rule ->> 'max_confirmable') IS NULL
       OR jsonb_typeof(rule -> 'matcher') <> 'object' THEN
      RETURN false;
    END IF;
    matcher := rule -> 'matcher';
    -- An empty matcher would match every path, which is how a "single rule"
    -- technically satisfies J20 while encoding nothing. At least one selector must
    -- be present.
    IF matcher ->> 'volume' IS NULL
       AND matcher ->> 'path_prefix' IS NULL
       AND matcher ->> 'name_pattern' IS NULL THEN
      RETURN false;
    END IF;
    IF work.classification_rank(rule ->> 'max_confirmable')
       < work.classification_rank(rule ->> 'classification') THEN
      RETURN false;
    END IF;
    IF work.classification_rank(rule ->> 'classification')
       < work.classification_rank(p_floor) THEN
      -- A rule may not determine a class looser than the organization's floor.
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION work.local_execution_policy_rules_valid(jsonb, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The policy row
-- ---------------------------------------------------------------------------

-- §4.1 writes the key as (org_id, revision); the reading implemented here is one
-- current row per organization, CAS-guarded by revision, matching the existing
-- work.org_policy and work.capability_snapshot shape. A history table would need a
-- second writer for the readers, and every reader in §4.2 wants the current row.
CREATE TABLE work.local_execution_policy (
  org_id text PRIMARY KEY,
  -- Empty is the strictest reading and is what an untouched row means; the gate
  -- below is what turns "no destination" into local_policy_incomplete.
  allowed_tools text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (
    work.text_array_closed_unique(allowed_tools, ARRAY[
      'workspace.list', 'workspace.read', 'workspace.search', 'artifact.write',
      'model.send_remote', 'model.send_device_local'
    ]::text[])
  ),
  allowed_destinations text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (
    work.text_array_closed_unique(allowed_destinations, ARRAY[
      'device_local', 'org_private', 'org_remote'
    ]::text[])
  ),
  classification_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  classification_default text NOT NULL DEFAULT 'local_only' CHECK (
    classification_default IN ('local_only', 'remote_excerpt_allowed')
  ),
  -- J20 requires the default to be *explicitly confirmed* by an administrator, and
  -- §4.1 gives no column for that fact: a NOT NULL DEFAULT cannot distinguish "the
  -- admin chose local_only" from "nobody ever touched it". Confirmation is also
  -- one-way, so it cannot be revoked to smuggle a later change through the gate.
  classification_default_confirmed boolean NOT NULL DEFAULT false,
  classification_floor text NOT NULL DEFAULT 'local_only' CHECK (
    classification_floor IN ('local_only', 'remote_excerpt_allowed')
  ),
  -- No defaults for the numeric bounds: every one of them is a decision the writing
  -- administrator has to make, and inventing a ceiling here is exactly the
  -- "missing means most permissive" move §4.1 forbids. Column names are kept exactly
  -- as §4.1 spells them, because §1.4 pins the local-policy response fields to this
  -- table's column names and a renamed column becomes a second name for one thing.
  readonly_max_actions int NOT NULL CHECK (readonly_max_actions >= 0),
  readonly_ttl interval NOT NULL CHECK (
    readonly_ttl BETWEEN interval '1 second' AND interval '24 hours'
  ),
  input_limit_bytes bigint NOT NULL CHECK (input_limit_bytes > 0),
  output_limit_bytes bigint NOT NULL CHECK (output_limit_bytes > 0),
  effective_epoch bigint NOT NULL DEFAULT 0 CHECK (effective_epoch >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT local_execution_policy_rules_shape CHECK (
    work.local_execution_policy_rules_valid(classification_rules, classification_floor)
  ),
  -- The strictest configured class wins over the looser one, so a floor looser
  -- than the default would be silently unreachable.
  CONSTRAINT local_execution_policy_default_shape CHECK (
    work.classification_rank(classification_default)
    >= work.classification_rank(classification_floor)
  ),
  FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.local_execution_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.local_execution_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.local_execution_policy
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.local_execution_policy_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'local_execution_policy_content_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision < OLD.revision OR NEW.effective_epoch < OLD.effective_epoch THEN
    RAISE EXCEPTION 'governance_revision_conflict' USING ERRCODE = 'P0001',
      DETAIL = OLD.revision::text;
  END IF;
  IF OLD.classification_default_confirmed AND NOT NEW.classification_default_confirmed THEN
    RAISE EXCEPTION 'local_execution_policy_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER local_execution_policy_guard BEFORE UPDATE ON work.local_execution_policy
  FOR EACH ROW EXECUTE FUNCTION work.local_execution_policy_guard();
CREATE TRIGGER local_execution_policy_no_delete BEFORE DELETE ON work.local_execution_policy
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
REVOKE ALL ON FUNCTION work.local_execution_policy_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- set_local_policy
-- ---------------------------------------------------------------------------

-- Every value arrives as one closed document; a partial patch would let two
-- administrators race on different columns of the same policy. The revision is the
-- CAS anchor, the epoch advance is what invalidates remembered readonly grants and
-- in-flight permits by comparison (policy_epoch in §4.1), and the audit row carries
-- the whole before/after pair because this is the write that opens a device face.
CREATE FUNCTION work.set_local_policy(
  p_org_id text,
  p_expected_revision bigint,
  p_policy jsonb,
  p_actor_subject_id text,
  p_request_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  policy_row work.local_execution_policy%ROWTYPE;
  v_tools text[];
  v_destinations text[];
  v_rules jsonb;
  v_default text;
  v_confirmed boolean;
  v_floor text;
  v_readonly_max int;
  v_readonly_ttl interval;
  v_input_limit bigint;
  v_output_limit bigint;
  v_exists boolean;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  -- §1.4 puts this command behind GET/PATCH /admin/local-policy with `policy.write`,
  -- and the server-side fact R0a actually has for that is assert_org_admin, which also
  -- binds p_actor_subject_id to the session subject (0002:1261-1269). Without it this
  -- function is EXECUTE-granted to work_api and every argument in it is
  -- caller-supplied: any active member of the organization could rewrite the policy
  -- that decides whether local actions leave their device, and the audit would name
  -- whoever they chose as the actor.
  PERFORM work.assert_org_admin(p_org_id, p_actor_subject_id);
  IF COALESCE(btrim(p_request_id), '') = '' THEN
    RAISE EXCEPTION 'invalid_request:request_id' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_policy) <> 'object' OR p_expected_revision IS NULL
     OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'invalid_request:policy' USING ERRCODE = '22023';
  END IF;

  v_tools := ARRAY(
    SELECT jsonb_array_elements_text(p_policy -> 'allowed_tools')
  );
  v_destinations := ARRAY(
    SELECT jsonb_array_elements_text(p_policy -> 'allowed_destinations')
  );
  IF p_policy -> 'allowed_tools' IS NULL OR jsonb_typeof(p_policy -> 'allowed_tools') <> 'array'
     OR p_policy -> 'allowed_destinations' IS NULL
     OR jsonb_typeof(p_policy -> 'allowed_destinations') <> 'array' THEN
    RAISE EXCEPTION 'invalid_request:allowed_tools' USING ERRCODE = '22023';
  END IF;
  v_rules := p_policy -> 'classification_rules';
  v_default := p_policy ->> 'classification_default';
  v_confirmed := COALESCE((p_policy ->> 'classification_default_confirmed')::boolean, false);
  v_floor := p_policy ->> 'classification_floor';
  v_readonly_max := (p_policy ->> 'readonly_max_actions')::int;
  v_readonly_ttl := (p_policy ->> 'readonly_ttl')::interval;
  v_input_limit := (p_policy ->> 'input_limit_bytes')::bigint;
  v_output_limit := (p_policy ->> 'output_limit_bytes')::bigint;
  IF v_rules IS NULL OR jsonb_typeof(v_rules) <> 'array'
     OR v_default IS NULL OR v_floor IS NULL
     OR v_readonly_max IS NULL OR v_readonly_ttl IS NULL
     OR v_input_limit IS NULL OR v_output_limit IS NULL THEN
    RAISE EXCEPTION 'invalid_request:policy' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM work.local_execution_policy WHERE org_id = p_org_id
  ) INTO v_exists;
  IF v_exists THEN
    SELECT * INTO policy_row FROM work.local_execution_policy
    WHERE org_id = p_org_id
    FOR UPDATE;
    IF policy_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'governance_revision_conflict' USING ERRCODE = 'P0001',
        DETAIL = policy_row.revision::text;
    END IF;
    -- The confirmation is one-way for the whole row: a re-write may not quietly
    -- un-confirm what an earlier write committed.
    IF policy_row.classification_default_confirmed AND NOT v_confirmed THEN
      RAISE EXCEPTION 'invalid_request:classification_default_confirmed' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_expected_revision <> 0 THEN
      RAISE EXCEPTION 'governance_revision_conflict' USING ERRCODE = 'P0001',
        DETAIL = '0';
    END IF;
  END IF;

  IF v_exists THEN
    UPDATE work.local_execution_policy
    SET allowed_tools = v_tools,
        allowed_destinations = v_destinations,
        classification_rules = v_rules,
        classification_default = v_default,
        classification_default_confirmed = v_confirmed,
        classification_floor = v_floor,
        readonly_max_actions = v_readonly_max,
        readonly_ttl = v_readonly_ttl,
        input_limit_bytes = v_input_limit,
        output_limit_bytes = v_output_limit,
        effective_epoch = policy_row.effective_epoch + 1,
        revision = policy_row.revision + 1,
        updated_at = now()
    WHERE org_id = p_org_id
    RETURNING * INTO policy_row;
  ELSE
    INSERT INTO work.local_execution_policy
      (org_id, allowed_tools, allowed_destinations, classification_rules,
       classification_default, classification_default_confirmed, classification_floor,
       readonly_max_actions, readonly_ttl, input_limit_bytes, output_limit_bytes,
       effective_epoch, revision)
    VALUES
      (p_org_id, v_tools, v_destinations, v_rules, v_default, v_confirmed, v_floor,
       v_readonly_max, v_readonly_ttl, v_input_limit, v_output_limit, 1, 1)
    RETURNING * INTO policy_row;
  END IF;

  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'local_policy.set', 'local_execution_policy', p_org_id,
    jsonb_build_object(
      'request_id', p_request_id,
      'revision', policy_row.revision,
      'effective_epoch', policy_row.effective_epoch,
      'after', to_jsonb(policy_row) - 'created_at' - 'updated_at',
      'gate', work.local_policy_gate(p_org_id)
    )
  );
  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'revision', policy_row.revision,
    'effective_epoch', policy_row.effective_epoch,
    'policy', (SELECT to_jsonb(policy_row) - 'created_at' - 'updated_at')
  );
END;
$$;

REVOKE ALL ON FUNCTION work.set_local_policy(text, bigint, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.set_local_policy(text, bigint, jsonb, text, text) TO work_api;

-- ---------------------------------------------------------------------------
-- The gate and the read surface
-- ---------------------------------------------------------------------------

-- One answer per organization, computed from the row rather than cached anywhere:
-- §1.2 BootstrapV2 (empty execution_profiles and allowed_permission_modes), the §1.4
-- pairing and grant endpoints, and §8.4 profile publication all have to agree, and
-- two derivations of the same precondition is how J37's first branch got missed.
CREATE FUNCTION work.local_policy_gate(p_org_id text) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  policy_row work.local_execution_policy%ROWTYPE;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO policy_row FROM work.local_execution_policy WHERE org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN 'local_policy_not_configured';
  END IF;
  IF jsonb_array_length(policy_row.classification_rules) = 0
     OR NOT policy_row.classification_default_confirmed THEN
    -- J20 first branch: no mapping, or a default nobody confirmed.
    RETURN 'local_policy_not_configured';
  END IF;
  IF array_length(policy_row.allowed_destinations, 1) IS NULL THEN
    -- J37's branch, as far as this increment is able to state it: a rule set that
    -- satisfies "at least one rule" while leaving no destination reachable at all is
    -- not a working configuration.
    --
    -- §9 writes the condition as a conjunction - no rule produces a
    -- `remote_excerpt_allowed` root AND the organization publishes no usable
    -- `device_local`/`org_private` profile - and only the second term can make an
    -- all-`local_only` policy legitimately ready. The profile half has no table until
    -- §8.4's ModelProfile lands with I4/I5, so this branch cannot be evaluated as
    -- written. It is deliberately not approximated by the first term alone: refusing
    -- whenever no rule maps to a remote classification would block every
    -- device_local-only organization, which is precisely the configuration J14/J15 and
    -- J39 default the demo and self-owned orgs to, and it would refuse on a term §9
    -- requires to hold *as well*. I4 therefore owns two changes together: read the
    -- published profiles, and then add the remote-root term. Until both are in place
    -- the divergence is asserted by TestR0bLocalPolicyGateHasTwoDistinctBranches, so
    -- closing it has to be a deliberate edit rather than something a later reader
    -- discovers was never implemented.
    RETURN 'local_policy_incomplete';
  END IF;
  RETURN 'ready';
END;
$$;

REVOKE ALL ON FUNCTION work.local_policy_gate(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.local_policy_gate(text) TO work_api, work_worker;

-- §1.4 says the response shape is this table's columns, so the read function
-- returns them and no DTO is introduced anywhere else.
CREATE FUNCTION work.get_local_policy(p_org_id text, p_actor_subject_id text) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  policy_row work.local_execution_policy%ROWTYPE;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  -- The read face is `policy.read` on the same /admin surface (§1.4), and the value it
  -- returns is the org's own governance configuration - tool allowlists, destination
  -- kinds and the classification mapping that decides what may leave a device. It is
  -- not ordinary member-readable data, so it asserts the same admin gate as the write.
  PERFORM work.assert_org_admin(p_org_id, p_actor_subject_id);
  SELECT * INTO policy_row FROM work.local_execution_policy WHERE org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'org_id', p_org_id,
      'configured', false,
      'gate', work.local_policy_gate(p_org_id)
    );
  END IF;
  RETURN (to_jsonb(policy_row) - 'created_at' - 'updated_at')
    || jsonb_build_object('configured', true,
                          'gate', work.local_policy_gate(p_org_id));
END;
$$;

REVOKE ALL ON FUNCTION work.get_local_policy(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.get_local_policy(text, text) TO work_api;

REVOKE ALL ON TABLE work.local_execution_policy FROM PUBLIC;
REVOKE ALL ON TABLE work.local_execution_policy FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;

RESET ROLE;
