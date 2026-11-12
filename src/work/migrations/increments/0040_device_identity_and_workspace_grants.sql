-- 0040: device identity, workspace grants, and the three tables their revocation
--       paths already write to.
--
-- Authority: work-r0b-m1a-device-migration-design-2026-11-12.md (card I = I1, then
-- cards P-a / Q-a / R-a / S-b, O-11 = bing, O-12 = jia, O-4 = jia, and the batch-one
-- scope ruling = jia / nine tables). Control design §4.1 / §4.2 / §1.4, device design
-- §2.1 / §2.2 / §2.4 / §3.2 / §3.3, architecture invariants 2 / 4 / 5.
--
-- Why nine tables and not the six the design first listed. The batch partition was
-- drawn by table group, but three batch-one commands write across groups:
-- revoke_device revokes execution_lease, revoke_workspace_grant invalidates
-- readonly_approval_grant, and rebind_run_workspace writes both plus
-- device_run_binding. Landing six tables would either reference tables that do not
-- exist or narrow those write sets, and narrowing revoke_device would leave a revoked
-- device holding a live lease. The nine-table batch is the dependency closure of the
-- eleven commands, so every write set in §12 is implemented verbatim.
--
-- Three of the nine (execution_lease, device_run_binding, readonly_approval_grant)
-- have only their revoking/invalidating writer here; their producing commands
-- (acquire_device_lease, create_device_run_binding, decide_local_approval) land in
-- batches two and three. They are therefore empty until then, and rebind_run_workspace
-- is unreachable until a binding exists. That is the same "control plane first,
-- consumers in batches" discipline the three already-registered /work/v2 routes use,
-- not a gap: nothing can write a row that no command can yet create.
--
-- No outbox rows. The relay is the only consumer of work.outbox and an unknown kind
-- ends in a non-retryable unknown_outbox_kind failure (internal/relay/relay.go:196),
-- so every device event would leave a permanently failed row in the queue whose
-- failures are the alarm. 0019:178-195 already refused the outbox as a carrier for
-- exactly this reason and r0b_governance_test.go pins the access_restriction outbox
-- count to zero. The audit row is the record; cancellation travels through
-- work.cancellation_intent, which is the table 0019 created for it.
--
-- Debts repaid here (design §8 debt 1): 0017:156-158 and 0018:138-139 left three
-- uuid columns without foreign keys because their targets did not exist yet. All
-- three land in this increment, with the tables they point at.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- Helpers used by CHECK constraints, so they must exist before the tables.
-- ---------------------------------------------------------------------------

-- The device public key is a closed JWK object: kty=EC, crv=P-256, x and y are
-- 32-byte base64url values, and no private field may ever be accepted (device §2.1:
-- "公钥 JWK 固定 kty=EC/crv=P-256/x/y，拒绝私钥字段"). Validating it here rather than
-- trusting the caller is what keeps a private key from being stored as a "public" one.
CREATE FUNCTION work.device_pubkey_valid(p_jwk jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  x text;
  y text;
BEGIN
  IF p_jwk IS NULL OR jsonb_typeof(p_jwk) <> 'object' THEN
    RETURN false;
  END IF;
  IF p_jwk ->> 'kty' IS DISTINCT FROM 'EC'
     OR p_jwk ->> 'crv' IS DISTINCT FROM 'P-256' THEN
    RETURN false;
  END IF;
  IF p_jwk ? 'd' OR p_jwk ? 'p' OR p_jwk ? 'q' OR p_jwk ? 'dp'
     OR p_jwk ? 'dq' OR p_jwk ? 'qi' OR p_jwk ? 'k' THEN
    RETURN false;
  END IF;
  x := p_jwk ->> 'x';
  y := p_jwk ->> 'y';
  IF x IS NULL OR y IS NULL
     OR x !~ '^[A-Za-z0-9_-]{43}$' OR y !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN false;
  END IF;
  -- Exactly the four members: an unknown extra member is not a closed object.
  RETURN (SELECT count(*) FROM jsonb_object_keys(p_jwk)) = 4;
END;
$$;

REVOKE ALL ON FUNCTION work.device_pubkey_valid(jsonb) FROM PUBLIC;

-- The thumbprint is domain-separated and built from the four JWK members in a fixed
-- order, so the Rust agent can reproduce it byte for byte without implementing JCS.
-- It is NOT the signature canonical form (that stays RFC 8785 for signatures).
CREATE FUNCTION work.device_key_thumbprint(p_jwk jsonb) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT work.sha256_text(
    'work-device-key-v1|' || (p_jwk ->> 'kty') || '|' || (p_jwk ->> 'crv')
    || '|' || (p_jwk ->> 'x') || '|' || (p_jwk ->> 'y'));
$$;

REVOKE ALL ON FUNCTION work.device_key_thumbprint(jsonb) FROM PUBLIC;

-- device_run_binding.grant_set is a constrained jsonb array, not a free-form blob:
-- non-empty, every element exactly {grant_id uuid, grant_revision bigint}, no repeated
-- grant. Same technique as 0020's local_execution_policy_rules_valid, and the reason
-- §4.1's "不把安全字段藏成无约束JSON" is satisfied without a tenth table (O-4 = jia).
CREATE FUNCTION work.binding_grant_set_valid(p_set jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  elem jsonb;
  seen uuid[] := ARRAY[]::uuid[];
  gid uuid;
  rev bigint;
BEGIN
  IF p_set IS NULL OR jsonb_typeof(p_set) <> 'array'
     OR jsonb_array_length(p_set) = 0 THEN
    RETURN false;
  END IF;
  FOR elem IN SELECT * FROM jsonb_array_elements(p_set) LOOP
    IF jsonb_typeof(elem) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(elem)) <> 2 THEN
      RETURN false;
    END IF;
    BEGIN
      gid := (elem ->> 'grant_id')::uuid;
      rev := (elem ->> 'grant_revision')::bigint;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    IF gid IS NULL OR rev IS NULL OR rev < 1 OR gid = ANY(seen) THEN
      RETURN false;
    END IF;
    seen := seen || gid;
  END LOOP;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION work.binding_grant_set_valid(jsonb) FROM PUBLIC;

-- work.enforce_state_transition reads OLD.state, but control §4.1 names the column
-- `status` on device and readonly_approval_grant. The baseline already has a second
-- function for exactly this reason (enforce_approval_transition reads `status`), so
-- this mirrors it rather than renaming a signed column or duplicating the whitelist
-- in each guard: the whitelist stays the single authority for both spellings.
CREATE FUNCTION work.enforce_status_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entity_name text := TG_ARGV[0];
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM work.state_transition
    WHERE entity = entity_name AND from_state = OLD.status AND to_state = NEW.status
  ) THEN
    RAISE EXCEPTION 'invalid_transition:%:%->%', entity_name, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION work.enforce_status_transition() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- State whitelist edges for the new entities.
--
-- enforce_state_transition refuses any from->to that is not registered here, so a
-- new entity with a state column must register its own edges (0018:58-68 did the
-- same for its four). Terminal states deliberately have no outgoing edge: a revoked
-- device never comes back (device §2.1 "revoked 不复活，重新配对生成新 ID"), and a
-- consumed challenge is never reusable.
-- ---------------------------------------------------------------------------
INSERT INTO work.state_transition (entity, from_state, to_state) VALUES
  ('device', 'pending', 'active'),
  ('device', 'pending', 'revoked'),
  ('device', 'active', 'revoked'),
  ('device_pairing', 'pending', 'consumed'),
  ('device_pairing', 'pending', 'expired'),
  ('device_session', 'active', 'superseded'),
  ('device_session', 'active', 'expired'),
  ('device_session', 'active', 'revoked'),
  ('device_session_ticket', 'pending', 'consumed'),
  ('device_session_ticket', 'pending', 'expired'),
  ('workspace_grant', 'active', 'revoked'),
  ('workspace_grant', 'active', 'expired'),
  ('workspace_grant', 'active', 'succeeded'),
  ('execution_lease', 'active', 'expired'),
  ('execution_lease', 'active', 'revoked'),
  ('execution_lease', 'active', 'released'),
  ('device_run_binding', 'offered', 'ready'),
  ('device_run_binding', 'offered', 'canceled'),
  ('device_run_binding', 'ready', 'active'),
  ('device_run_binding', 'ready', 'canceled'),
  ('device_run_binding', 'active', 'finished'),
  ('device_run_binding', 'active', 'canceled'),
  ('readonly_approval_grant', 'active', 'revoked'),
  ('readonly_approval_grant', 'active', 'expired'),
  ('readonly_approval_grant', 'active', 'invalidated')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- A1. device
-- ---------------------------------------------------------------------------
CREATE TABLE work.device (
  org_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_subject_id text NOT NULL,
  device_name text NOT NULL,
  platform text NOT NULL,
  public_key_jwk jsonb NOT NULL,
  public_key_thumbprint text NOT NULL,
  cert_serial text,
  cert_not_after timestamptz,
  -- Only the Bearer plane pairs a device: device §2.1 step 1 says the shell's native
  -- access token is used and "不使用也不创建 cookie 会话". A 'cookie' member here would
  -- have no writer, which is the orphan-state this package keeps removing.
  auth_plane text NOT NULL,
  auth_epoch bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  revoked_at timestamptz,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT device_owner_shape CHECK (owner_subject_id <> ''),
  CONSTRAINT device_name_shape CHECK (length(btrim(device_name)) BETWEEN 1 AND 120),
  CONSTRAINT device_platform_check CHECK (platform IN ('windows-x64')),
  CONSTRAINT device_pubkey_shape CHECK (work.device_pubkey_valid(public_key_jwk)),
  CONSTRAINT device_thumbprint_shape
    CHECK (public_key_thumbprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_auth_plane_check CHECK (auth_plane IN ('bearer')),
  CONSTRAINT device_auth_epoch_nonneg CHECK (auth_epoch >= 0),
  CONSTRAINT device_status_check CHECK (status IN ('pending', 'active', 'revoked')),
  CONSTRAINT device_revoked_shape
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT device_cert_shape
    CHECK ((cert_serial IS NULL) = (cert_not_after IS NULL)),
  CONSTRAINT device_revision_nonneg CHECK (revision >= 0),
  CONSTRAINT device_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.device ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.device FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.device
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.device_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
     OR NEW.device_name IS DISTINCT FROM OLD.device_name
     OR NEW.platform IS DISTINCT FROM OLD.platform
     OR NEW.public_key_jwk IS DISTINCT FROM OLD.public_key_jwk
     OR NEW.public_key_thumbprint IS DISTINCT FROM OLD.public_key_thumbprint
     OR NEW.auth_plane IS DISTINCT FROM OLD.auth_plane
     OR NEW.auth_epoch IS DISTINCT FROM OLD.auth_epoch
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'device_content_immutable' USING ERRCODE = '23514';
  END IF;
  -- The certificate pair may only be written while the device is active, and a
  -- serial already issued may not be rewritten to a different one behind the
  -- caller's back: renewal replaces it, so it must move forward, not sideways.
  IF OLD.status <> 'active' AND NEW.cert_serial IS DISTINCT FROM OLD.cert_serial THEN
    RAISE EXCEPTION 'device_cert_requires_active' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'device_revoked_at_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_guard BEFORE UPDATE ON work.device
  FOR EACH ROW EXECUTE FUNCTION work.device_guard();
CREATE TRIGGER device_no_delete BEFORE DELETE ON work.device
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER device_transition BEFORE UPDATE OF status ON work.device
  FOR EACH ROW EXECUTE FUNCTION work.enforce_status_transition('device');

CREATE INDEX work_device_owner ON work.device(org_id, owner_subject_id);
CREATE INDEX work_device_active_owner ON work.device(org_id, owner_subject_id)
  WHERE status = 'active';
-- One key may not bind two *live* devices in an organization. The predicate matters:
-- device §2.1 says "revoked 不复活，重新配对生成新 ID", so a revoked device must not
-- keep its key reserved forever - the same CNG key has to be able to pair again as a
-- new row. A plain UNIQUE would make revocation permanent for that key.
CREATE UNIQUE INDEX work_device_one_live_per_key
  ON work.device(org_id, public_key_thumbprint) WHERE status <> 'revoked';

-- ---------------------------------------------------------------------------
-- A2. device_pairing — one-shot challenges for pairing AND certificate renewal.
--
-- purpose exists because device §2.1 step 4 requires a *new challenge* for renewal
-- while §4.1 gives no column to tell the two apart. Both values have a writer.
-- ---------------------------------------------------------------------------
CREATE TABLE work.device_pairing (
  org_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  auth_plane text NOT NULL,
  auth_epoch bigint NOT NULL,
  purpose text NOT NULL,
  challenge_hash text NOT NULL,
  public_key_thumbprint text NOT NULL,
  client_request_id text NOT NULL,
  request_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  state text NOT NULL DEFAULT 'pending',
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT device_pairing_owner_shape CHECK (owner_subject_id <> ''),
  CONSTRAINT device_pairing_request_shape CHECK (client_request_id <> ''),
  CONSTRAINT device_pairing_auth_plane_check CHECK (auth_plane IN ('bearer')),
  CONSTRAINT device_pairing_auth_epoch_nonneg CHECK (auth_epoch >= 0),
  CONSTRAINT device_pairing_purpose_check CHECK (purpose IN ('pair', 'renew')),
  CONSTRAINT device_pairing_challenge_shape
    CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_pairing_thumbprint_shape
    CHECK (public_key_thumbprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_pairing_request_hash_shape
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_pairing_state_check
    CHECK (state IN ('pending', 'consumed', 'expired')),
  CONSTRAINT device_pairing_window CHECK (expires_at > created_at),
  -- device §2.1 step 2: the challenge lives 120 seconds and is used once.
  CONSTRAINT device_pairing_ttl
    CHECK (expires_at <= created_at + interval '120 seconds'),
  CONSTRAINT device_pairing_consumed_shape
    CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CONSTRAINT device_pairing_consumed_after_issue
    CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CONSTRAINT device_pairing_revision_nonneg CHECK (revision >= 0),
  -- §1.1 scopes dedup by (org, subject, logical_command, request_id); the table
  -- fixes the logical command, so the subject must be in the key or two members
  -- reusing one request_id would swallow each other's pairing.
  UNIQUE (org_id, owner_subject_id, client_request_id),
  CONSTRAINT device_pairing_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT device_pairing_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.device_pairing ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.device_pairing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.device_pairing
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.device_pairing_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
     OR NEW.auth_plane IS DISTINCT FROM OLD.auth_plane
     OR NEW.auth_epoch IS DISTINCT FROM OLD.auth_epoch
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.challenge_hash IS DISTINCT FROM OLD.challenge_hash
     OR NEW.public_key_thumbprint IS DISTINCT FROM OLD.public_key_thumbprint
     OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'device_pairing_content_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NOT NULL
     AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'device_pairing_consumed_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_pairing_guard BEFORE UPDATE ON work.device_pairing
  FOR EACH ROW EXECUTE FUNCTION work.device_pairing_guard();
CREATE TRIGGER device_pairing_no_delete BEFORE DELETE ON work.device_pairing
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER device_pairing_transition BEFORE UPDATE OF state ON work.device_pairing
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('device_pairing');

CREATE INDEX work_device_pairing_due ON work.device_pairing(org_id, expires_at)
  WHERE state = 'pending';

-- ---------------------------------------------------------------------------
-- A3. device_session
-- ---------------------------------------------------------------------------
CREATE TABLE work.device_session (
  org_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  boot_id text NOT NULL,
  agent_instance_id uuid NOT NULL,
  auth_plane text NOT NULL,
  auth_epoch bigint NOT NULL,
  protocol_major int NOT NULL,
  protocol_minor int NOT NULL,
  runtime_digest text NOT NULL,
  profile_id text,
  journal_epoch uuid NOT NULL,
  generation bigint NOT NULL,
  -- Which ticket bought this session. The hash itself lives on the ticket row
  -- (card S-b): minting happens before hello, so it cannot live here.
  session_ticket_id uuid,
  last_receipt_seq bigint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active',
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT device_session_owner_shape CHECK (owner_subject_id <> ''),
  CONSTRAINT device_session_boot_shape CHECK (boot_id <> ''),
  CONSTRAINT device_session_auth_plane_check CHECK (auth_plane IN ('bearer')),
  CONSTRAINT device_session_auth_epoch_nonneg CHECK (auth_epoch >= 0),
  CONSTRAINT device_session_protocol_nonneg
    CHECK (protocol_major >= 0 AND protocol_minor >= 0),
  CONSTRAINT device_session_runtime_shape
    CHECK (runtime_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_session_generation_nonneg CHECK (generation >= 0),
  CONSTRAINT device_session_receipt_seq_nonneg CHECK (last_receipt_seq >= 0),
  CONSTRAINT device_session_state_check
    CHECK (state IN ('active', 'superseded', 'expired', 'revoked')),
  CONSTRAINT device_session_window CHECK (expires_at > created_at),
  CONSTRAINT device_session_revision_nonneg CHECK (revision >= 0),
  CONSTRAINT device_session_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT device_session_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.device_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.device_session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.device_session
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.device_session_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
     OR NEW.boot_id IS DISTINCT FROM OLD.boot_id
     OR NEW.agent_instance_id IS DISTINCT FROM OLD.agent_instance_id
     OR NEW.auth_plane IS DISTINCT FROM OLD.auth_plane
     OR NEW.auth_epoch IS DISTINCT FROM OLD.auth_epoch
     OR NEW.journal_epoch IS DISTINCT FROM OLD.journal_epoch
     OR NEW.generation IS DISTINCT FROM OLD.generation
     OR NEW.session_ticket_id IS DISTINCT FROM OLD.session_ticket_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'device_session_content_immutable' USING ERRCODE = '23514';
  END IF;
  -- The receipt watermark only advances: a replayed hello must not rewind it and
  -- make the device re-send receipts the server already recorded.
  IF NEW.last_receipt_seq < OLD.last_receipt_seq THEN
    RAISE EXCEPTION 'invalid_transition:device_session:receipt_seq_rewind'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_session_guard BEFORE UPDATE ON work.device_session
  FOR EACH ROW EXECUTE FUNCTION work.device_session_guard();
CREATE TRIGGER device_session_no_delete BEFORE DELETE ON work.device_session
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER device_session_transition BEFORE UPDATE OF state ON work.device_session
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('device_session');

-- §4.1: one active session per device. A partial unique index makes that a database
-- fact rather than a convention the hello handler has to remember.
CREATE UNIQUE INDEX work_device_session_one_active
  ON work.device_session(org_id, device_id) WHERE state = 'active';
CREATE INDEX work_device_session_due ON work.device_session(org_id, expires_at)
  WHERE state = 'active';

-- ---------------------------------------------------------------------------
-- A4. device_session_ticket (card S-b)
--
-- Shaped after 0024 provider_probe_grant: a one-shot token hash with a short TTL and
-- an atomic claim. It is a separate table because the ticket is minted before hello
-- while the session row is only created at hello, so the hash has nowhere else to
-- live that does not lose the evidence of an unused mint.
-- ---------------------------------------------------------------------------
CREATE TABLE work.device_session_ticket (
  org_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  auth_plane text NOT NULL,
  auth_epoch bigint NOT NULL,
  public_key_thumbprint text NOT NULL,
  ticket_hash text NOT NULL,
  client_request_id text NOT NULL,
  request_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  state text NOT NULL DEFAULT 'pending',
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT device_session_ticket_owner_shape CHECK (owner_subject_id <> ''),
  CONSTRAINT device_session_ticket_request_shape CHECK (client_request_id <> ''),
  CONSTRAINT device_session_ticket_auth_plane_check CHECK (auth_plane IN ('bearer')),
  CONSTRAINT device_session_ticket_auth_epoch_nonneg CHECK (auth_epoch >= 0),
  CONSTRAINT device_session_ticket_thumbprint_shape
    CHECK (public_key_thumbprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_session_ticket_hash_shape
    CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_session_ticket_request_hash_shape
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_session_ticket_state_check
    CHECK (state IN ('pending', 'consumed', 'expired')),
  CONSTRAINT device_session_ticket_window CHECK (expires_at > created_at),
  -- device §2.2: the ticket lives 60 seconds.
  CONSTRAINT device_session_ticket_ttl
    CHECK (expires_at <= created_at + interval '60 seconds'),
  CONSTRAINT device_session_ticket_consumed_shape
    CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CONSTRAINT device_session_ticket_consumed_after_issue
    CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CONSTRAINT device_session_ticket_revision_nonneg CHECK (revision >= 0),
  UNIQUE (org_id, ticket_hash),
  UNIQUE (org_id, owner_subject_id, client_request_id),
  CONSTRAINT device_session_ticket_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT device_session_ticket_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.device_session_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.device_session_ticket FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.device_session_ticket
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.device_session_ticket_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
     OR NEW.auth_plane IS DISTINCT FROM OLD.auth_plane
     OR NEW.auth_epoch IS DISTINCT FROM OLD.auth_epoch
     OR NEW.public_key_thumbprint IS DISTINCT FROM OLD.public_key_thumbprint
     OR NEW.ticket_hash IS DISTINCT FROM OLD.ticket_hash
     OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'device_session_ticket_content_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NOT NULL
     AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'device_session_ticket_consumed_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_session_ticket_guard
  BEFORE UPDATE ON work.device_session_ticket
  FOR EACH ROW EXECUTE FUNCTION work.device_session_ticket_guard();
CREATE TRIGGER device_session_ticket_no_delete
  BEFORE DELETE ON work.device_session_ticket
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER device_session_ticket_transition
  BEFORE UPDATE OF state ON work.device_session_ticket
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('device_session_ticket');

CREATE INDEX work_device_session_ticket_due
  ON work.device_session_ticket(org_id, expires_at) WHERE state = 'pending';

-- The session points at the ticket that bought it. The edge is added here rather
-- than inline because the ticket table is declared after the session table.
ALTER TABLE work.device_session
  ADD CONSTRAINT device_session_ticket_fkey
  FOREIGN KEY (session_ticket_id, org_id)
  REFERENCES work.device_session_ticket(id, org_id);

-- ---------------------------------------------------------------------------
-- B1. workspace_grant
--
-- No path, file name, volume serial or root file id ever reaches this table:
-- invariant 5 and device §2.4 keep these on the device, and the server holds only a
-- random root_ref plus an HMAC it can compare for equality but never interpret.
-- ---------------------------------------------------------------------------
CREATE TABLE work.workspace_grant (
  org_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  session_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  boot_id text NOT NULL,
  root_ref uuid NOT NULL DEFAULT gen_random_uuid(),
  root_identity_hash text NOT NULL,
  allowed_tools text[] NOT NULL,
  classification text NOT NULL,
  -- Which rule of the organization's ordered mapping the device reports as matched.
  -- The server takes the classification FROM that rule, never from the device's
  -- claimed value; the device only says which entry applies, because only it can see
  -- the path (invariant 5). NULL means no rule matched, so classification_default
  -- applies. The residual risk - a fully controlled Broker can lie about which rule
  -- matched - is the same trust boundary as lying about root_identity_hash, and is
  -- recorded in the design doc and the S4 signoff boundary.
  matched_rule_index int,
  grant_revision bigint NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active',
  succeeded_by uuid,
  client_request_id text NOT NULL,
  request_hash text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT workspace_grant_owner_shape CHECK (owner_subject_id <> ''),
  CONSTRAINT workspace_grant_boot_shape CHECK (boot_id <> ''),
  CONSTRAINT workspace_grant_request_shape CHECK (client_request_id <> ''),
  CONSTRAINT workspace_grant_root_identity_shape
    CHECK (root_identity_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_grant_request_hash_shape
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_grant_tools_check CHECK (
    allowed_tools IS NOT NULL
    AND cardinality(allowed_tools) >= 1
    AND work.text_array_closed_unique(allowed_tools, ARRAY[
      'workspace.list', 'workspace.read', 'workspace.search', 'artifact.write'
    ]::text[])
  ),
  CONSTRAINT workspace_grant_classification_check
    CHECK (classification IN ('local_only', 'remote_excerpt_allowed')),
  CONSTRAINT workspace_grant_rule_index_nonneg
    CHECK (matched_rule_index IS NULL OR matched_rule_index >= 0),
  CONSTRAINT workspace_grant_revision_positive CHECK (grant_revision >= 1),
  CONSTRAINT workspace_grant_state_check
    CHECK (state IN ('active', 'revoked', 'expired', 'succeeded')),
  CONSTRAINT workspace_grant_succession_shape
    CHECK ((state = 'succeeded') = (succeeded_by IS NOT NULL)),
  CONSTRAINT workspace_grant_window CHECK (expires_at > created_at),
  -- device §2.4: the grant lives at most min(login session, current agent, 8h, the
  -- user's choice). 8h is the hard ceiling the table can enforce; the other three
  -- are smaller values the command takes the minimum of.
  CONSTRAINT workspace_grant_ttl
    CHECK (expires_at <= created_at + interval '8 hours'),
  CONSTRAINT workspace_grant_revision_nonneg CHECK (revision >= 0),
  UNIQUE (org_id, root_ref),
  UNIQUE (org_id, owner_subject_id, client_request_id),
  CONSTRAINT workspace_grant_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT workspace_grant_session_fkey
    FOREIGN KEY (session_id, org_id) REFERENCES work.device_session(id, org_id),
  CONSTRAINT workspace_grant_successor_fkey
    FOREIGN KEY (succeeded_by, org_id) REFERENCES work.workspace_grant(id, org_id),
  CONSTRAINT workspace_grant_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.workspace_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.workspace_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.workspace_grant
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.workspace_grant_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
     OR NEW.boot_id IS DISTINCT FROM OLD.boot_id
     OR NEW.root_ref IS DISTINCT FROM OLD.root_ref
     OR NEW.root_identity_hash IS DISTINCT FROM OLD.root_identity_hash
     OR NEW.allowed_tools IS DISTINCT FROM OLD.allowed_tools
     OR NEW.classification IS DISTINCT FROM OLD.classification
     OR NEW.matched_rule_index IS DISTINCT FROM OLD.matched_rule_index
     OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'workspace_grant_content_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.grant_revision < OLD.grant_revision THEN
    RAISE EXCEPTION 'invalid_transition:workspace_grant:revision_rewind'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_grant_guard BEFORE UPDATE ON work.workspace_grant
  FOR EACH ROW EXECUTE FUNCTION work.workspace_grant_guard();
CREATE TRIGGER workspace_grant_no_delete BEFORE DELETE ON work.workspace_grant
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER workspace_grant_transition BEFORE UPDATE OF state ON work.workspace_grant
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('workspace_grant');

CREATE INDEX work_workspace_grant_device_active
  ON work.workspace_grant(org_id, device_id, session_id) WHERE state = 'active';
CREATE INDEX work_workspace_grant_due ON work.workspace_grant(org_id, expires_at)
  WHERE state = 'active';

-- ---------------------------------------------------------------------------
-- B2. workspace_grant_succession — append-only old->new grant chain.
-- ---------------------------------------------------------------------------
CREATE TABLE work.workspace_grant_succession (
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  old_grant_id uuid NOT NULL,
  new_grant_id uuid NOT NULL,
  proof_hash text NOT NULL,
  binding_revision bigint NOT NULL,
  client_request_id text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, run_id, old_grant_id),
  CONSTRAINT workspace_grant_succession_distinct
    CHECK (old_grant_id <> new_grant_id),
  CONSTRAINT workspace_grant_succession_proof_shape
    CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_grant_succession_request_hash_shape
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_grant_succession_request_shape CHECK (client_request_id <> ''),
  CONSTRAINT workspace_grant_succession_binding_positive CHECK (binding_revision >= 1),
  UNIQUE (org_id, client_request_id),
  CONSTRAINT workspace_grant_succession_run_fkey
    FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id),
  CONSTRAINT workspace_grant_succession_old_fkey
    FOREIGN KEY (old_grant_id, org_id) REFERENCES work.workspace_grant(id, org_id),
  CONSTRAINT workspace_grant_succession_new_fkey
    FOREIGN KEY (new_grant_id, org_id) REFERENCES work.workspace_grant(id, org_id),
  CONSTRAINT workspace_grant_succession_org_fkey
    FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.workspace_grant_succession ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.workspace_grant_succession FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.workspace_grant_succession
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE TRIGGER workspace_grant_succession_append_only
  BEFORE UPDATE OR DELETE ON work.workspace_grant_succession
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

-- §4.1: both grants must belong to the same device and owner and have the same
-- root_identity_hash. The server can check this itself - the succession row is
-- written by the control plane, not claimed by the device - which is also what lets
-- prepare_local_operation tell workspace_rebound from reauthorized later.
CREATE FUNCTION work.workspace_grant_succession_same_root() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_grant work.workspace_grant%ROWTYPE;
  new_grant work.workspace_grant%ROWTYPE;
BEGIN
  SELECT * INTO old_grant FROM work.workspace_grant
    WHERE id = NEW.old_grant_id AND org_id = NEW.org_id;
  SELECT * INTO new_grant FROM work.workspace_grant
    WHERE id = NEW.new_grant_id AND org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF old_grant.device_id IS DISTINCT FROM new_grant.device_id
     OR old_grant.owner_subject_id IS DISTINCT FROM new_grant.owner_subject_id
     OR old_grant.root_identity_hash IS DISTINCT FROM new_grant.root_identity_hash THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_grant_succession_same_root
  BEFORE INSERT ON work.workspace_grant_succession
  FOR EACH ROW EXECUTE FUNCTION work.workspace_grant_succession_same_root();

-- ---------------------------------------------------------------------------
-- C2. execution_lease
--
-- Named execution_lease, not device_lease: control §4.1 is the data-structure
-- authority and 0021's shipped header already names work.execution_lease (card P-a).
-- ---------------------------------------------------------------------------
CREATE TABLE work.execution_lease (
  org_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid NOT NULL,
  binding_revision bigint NOT NULL,
  fence bigint NOT NULL,
  generation bigint NOT NULL,
  purpose text NOT NULL,
  start_nonce uuid,
  expires_at timestamptz NOT NULL,
  last_receipt_seq bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'active',
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT execution_lease_binding_positive CHECK (binding_revision >= 1),
  CONSTRAINT execution_lease_fence_positive CHECK (fence >= 1),
  CONSTRAINT execution_lease_generation_nonneg CHECK (generation >= 0),
  -- J12: a lease minted only to hand back history and finish must not buy any new
  -- execution capability. The column is what makes that enforceable rather than a
  -- comment: prepare_local_operation and consume_device_permit both require
  -- purpose='execute' (EV113).
  CONSTRAINT execution_lease_purpose_check
    CHECK (purpose IN ('execute', 'reconcile_finish')),
  CONSTRAINT execution_lease_purpose_shape
    CHECK ((purpose = 'execute') = (start_nonce IS NOT NULL)),
  CONSTRAINT execution_lease_window CHECK (expires_at > created_at),
  CONSTRAINT execution_lease_receipt_seq_nonneg CHECK (last_receipt_seq >= 0),
  CONSTRAINT execution_lease_state_check
    CHECK (state IN ('active', 'expired', 'revoked', 'released')),
  CONSTRAINT execution_lease_revision_nonneg CHECK (revision >= 0),
  CONSTRAINT execution_lease_run_fkey
    FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id),
  CONSTRAINT execution_lease_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT execution_lease_session_fkey
    FOREIGN KEY (session_id, org_id) REFERENCES work.device_session(id, org_id),
  CONSTRAINT execution_lease_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.execution_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.execution_lease FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.execution_lease
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.execution_lease_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.binding_revision IS DISTINCT FROM OLD.binding_revision
     OR NEW.fence IS DISTINCT FROM OLD.fence
     OR NEW.generation IS DISTINCT FROM OLD.generation
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.start_nonce IS DISTINCT FROM OLD.start_nonce
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'execution_lease_content_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_receipt_seq < OLD.last_receipt_seq THEN
    RAISE EXCEPTION 'invalid_transition:execution_lease:receipt_seq_rewind'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_lease_guard BEFORE UPDATE ON work.execution_lease
  FOR EACH ROW EXECUTE FUNCTION work.execution_lease_guard();
CREATE TRIGGER execution_lease_no_delete BEFORE DELETE ON work.execution_lease
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER execution_lease_transition BEFORE UPDATE OF state ON work.execution_lease
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('execution_lease');

CREATE UNIQUE INDEX work_execution_lease_one_active_per_run
  ON work.execution_lease(org_id, run_id) WHERE state = 'active';
CREATE INDEX work_execution_lease_due ON work.execution_lease(org_id, expires_at)
  WHERE state = 'active';

-- ---------------------------------------------------------------------------
-- C1. device_run_binding
-- ---------------------------------------------------------------------------
CREATE TABLE work.device_run_binding (
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  binding_revision bigint NOT NULL,
  task_id uuid NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid NOT NULL,
  input_ref text NOT NULL,
  input_hash text NOT NULL,
  snapshot_descriptor_ref text,
  snapshot_hash text NOT NULL,
  profile_id text NOT NULL,
  profile_revision bigint NOT NULL,
  runtime_digest text NOT NULL,
  tool_manifest_hash text NOT NULL,
  model_version text NOT NULL,
  grant_set jsonb NOT NULL,
  expected_checkpoint_seq bigint,
  expected_checkpoint_hash text,
  start_nonce uuid NOT NULL,
  offer_expiry timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'offered',
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, run_id, binding_revision),
  CONSTRAINT device_run_binding_revision_positive CHECK (binding_revision >= 1),
  CONSTRAINT device_run_binding_input_shape CHECK (input_ref <> ''),
  CONSTRAINT device_run_binding_input_hash_shape
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_run_binding_snapshot_hash_shape
    CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_run_binding_profile_shape CHECK (profile_id <> ''),
  CONSTRAINT device_run_binding_profile_revision_nonneg CHECK (profile_revision >= 0),
  CONSTRAINT device_run_binding_runtime_shape
    CHECK (runtime_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_run_binding_manifest_shape
    CHECK (tool_manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_run_binding_model_shape CHECK (model_version <> ''),
  CONSTRAINT device_run_binding_grant_set_shape
    CHECK (work.binding_grant_set_valid(grant_set)),
  CONSTRAINT device_run_binding_checkpoint_shape
    CHECK ((expected_checkpoint_seq IS NULL) = (expected_checkpoint_hash IS NULL)),
  CONSTRAINT device_run_binding_checkpoint_seq_nonneg
    CHECK (expected_checkpoint_seq IS NULL OR expected_checkpoint_seq >= 0),
  CONSTRAINT device_run_binding_checkpoint_hash_shape
    CHECK (expected_checkpoint_hash IS NULL
           OR expected_checkpoint_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_run_binding_state_check
    CHECK (state IN ('offered', 'ready', 'active', 'finished', 'canceled')),
  CONSTRAINT device_run_binding_window CHECK (offer_expiry > created_at),
  CONSTRAINT device_run_binding_revision_nonneg CHECK (revision >= 0),
  UNIQUE (org_id, start_nonce),
  CONSTRAINT device_run_binding_run_fkey
    FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id),
  CONSTRAINT device_run_binding_task_fkey
    FOREIGN KEY (task_id, org_id) REFERENCES work.task(id, org_id),
  CONSTRAINT device_run_binding_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT device_run_binding_session_fkey
    FOREIGN KEY (session_id, org_id) REFERENCES work.device_session(id, org_id),
  CONSTRAINT device_run_binding_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.device_run_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.device_run_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.device_run_binding
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.device_run_binding_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.binding_revision IS DISTINCT FROM OLD.binding_revision
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.input_ref IS DISTINCT FROM OLD.input_ref
     OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
     OR NEW.snapshot_descriptor_ref IS DISTINCT FROM OLD.snapshot_descriptor_ref
     OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.profile_revision IS DISTINCT FROM OLD.profile_revision
     OR NEW.runtime_digest IS DISTINCT FROM OLD.runtime_digest
     OR NEW.tool_manifest_hash IS DISTINCT FROM OLD.tool_manifest_hash
     OR NEW.model_version IS DISTINCT FROM OLD.model_version
     OR NEW.grant_set IS DISTINCT FROM OLD.grant_set
     OR NEW.expected_checkpoint_seq IS DISTINCT FROM OLD.expected_checkpoint_seq
     OR NEW.expected_checkpoint_hash IS DISTINCT FROM OLD.expected_checkpoint_hash
     OR NEW.start_nonce IS DISTINCT FROM OLD.start_nonce
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'device_run_binding_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_run_binding_guard BEFORE UPDATE ON work.device_run_binding
  FOR EACH ROW EXECUTE FUNCTION work.device_run_binding_guard();
CREATE TRIGGER device_run_binding_no_delete BEFORE DELETE ON work.device_run_binding
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER device_run_binding_transition
  BEFORE UPDATE OF state ON work.device_run_binding
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('device_run_binding');

CREATE INDEX work_device_run_binding_run_latest
  ON work.device_run_binding(org_id, run_id, binding_revision DESC);

-- ---------------------------------------------------------------------------
-- E1. readonly_approval_grant
--
-- Its only consumer is prepare_local_operation's read-only branch (batch three).
-- Here it has the two writers that invalidate it, which is what revoke_workspace_grant
-- and rebind_run_workspace already owe; no row can exist until decide_local_approval
-- lands, so nothing is invalidated in this batch.
-- ---------------------------------------------------------------------------
CREATE TABLE work.readonly_approval_grant (
  org_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_subject_id text NOT NULL,
  run_id uuid NOT NULL,
  device_id uuid NOT NULL,
  workspace_grant_id uuid NOT NULL,
  grant_revision bigint NOT NULL,
  tool_set text[] NOT NULL,
  resource_selector_hash text NOT NULL,
  policy_epoch bigint NOT NULL,
  access_epoch bigint NOT NULL,
  approval_id uuid,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active',
  consumed_count int NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT readonly_approval_grant_owner_shape CHECK (owner_subject_id <> ''),
  CONSTRAINT readonly_approval_grant_revision_positive CHECK (grant_revision >= 1),
  -- "同类只读" never covers a write or a model action, and never reverses coverage.
  CONSTRAINT readonly_approval_grant_tools_check CHECK (
    tool_set IS NOT NULL
    AND cardinality(tool_set) >= 1
    AND work.text_array_closed_unique(tool_set, ARRAY[
      'workspace.list', 'workspace.read', 'workspace.search'
    ]::text[])
  ),
  CONSTRAINT readonly_approval_grant_selector_shape
    CHECK (resource_selector_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT readonly_approval_grant_epochs_nonneg
    CHECK (policy_epoch >= 0 AND access_epoch >= 0),
  CONSTRAINT readonly_approval_grant_status_check
    CHECK (status IN ('active', 'revoked', 'expired', 'invalidated')),
  CONSTRAINT readonly_approval_grant_window CHECK (expires_at > created_at),
  -- control §4.1: at most 24h, and never across the Run's terminal state.
  CONSTRAINT readonly_approval_grant_ttl
    CHECK (expires_at <= created_at + interval '24 hours'),
  CONSTRAINT readonly_approval_grant_consumed_nonneg CHECK (consumed_count >= 0),
  CONSTRAINT readonly_approval_grant_revision_nonneg CHECK (revision >= 0),
  CONSTRAINT readonly_approval_grant_run_fkey
    FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id),
  CONSTRAINT readonly_approval_grant_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT readonly_approval_grant_grant_fkey
    FOREIGN KEY (workspace_grant_id, org_id)
    REFERENCES work.workspace_grant(id, org_id),
  CONSTRAINT readonly_approval_grant_org_fkey
    FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.readonly_approval_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.readonly_approval_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.readonly_approval_grant
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.readonly_approval_grant_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.workspace_grant_id IS DISTINCT FROM OLD.workspace_grant_id
     OR NEW.grant_revision IS DISTINCT FROM OLD.grant_revision
     OR NEW.tool_set IS DISTINCT FROM OLD.tool_set
     OR NEW.resource_selector_hash IS DISTINCT FROM OLD.resource_selector_hash
     OR NEW.policy_epoch IS DISTINCT FROM OLD.policy_epoch
     OR NEW.access_epoch IS DISTINCT FROM OLD.access_epoch
     OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'readonly_approval_grant_content_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.consumed_count < OLD.consumed_count THEN
    RAISE EXCEPTION 'invalid_transition:readonly_approval_grant:consumed_rewind'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER readonly_approval_grant_guard
  BEFORE UPDATE ON work.readonly_approval_grant
  FOR EACH ROW EXECUTE FUNCTION work.readonly_approval_grant_guard();
CREATE TRIGGER readonly_approval_grant_no_delete
  BEFORE DELETE ON work.readonly_approval_grant
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER readonly_approval_grant_transition
  BEFORE UPDATE OF status ON work.readonly_approval_grant
  FOR EACH ROW EXECUTE FUNCTION work.enforce_status_transition('readonly_approval_grant');

CREATE INDEX work_readonly_approval_grant_match
  ON work.readonly_approval_grant(
    org_id, run_id, device_id, workspace_grant_id, grant_revision)
  WHERE status = 'active';
CREATE INDEX work_readonly_approval_grant_due
  ON work.readonly_approval_grant(org_id, expires_at) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Debt 1: the three foreign keys 0017 and 0018 owed to the device slice.
--
-- 0017:156-158 says the FK "lands with the table it points at"; 0018 left
-- access_restriction.device_id and .workspace_grant_id unbound for the same reason.
-- Both columns are already uuid, so the edges are added as they are. NOT VALID is
-- deliberately not used: skipping validation would leave the very rows this debt is
-- about unchecked. The pre-landing read of orphan counts is recorded in the design
-- doc and asserted by the batch's PG tests.
-- ---------------------------------------------------------------------------
ALTER TABLE work.artifact_version
  ADD CONSTRAINT artifact_version_device_fkey
  FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id);

ALTER TABLE work.access_restriction
  ADD CONSTRAINT access_restriction_device_fkey
  FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id);

ALTER TABLE work.access_restriction
  ADD CONSTRAINT access_restriction_workspace_grant_fkey
  FOREIGN KEY (workspace_grant_id, org_id) REFERENCES work.workspace_grant(id, org_id);

-- ---------------------------------------------------------------------------
-- Domain commands.
--
-- Two boundaries are stated here because they are not visible from the bodies.
--
-- 1. Signature verification is NOT done in SQL. ES256 over an RFC 8785 canonical
--    string cannot be verified in plpgsql (pgcrypto has no ECDSA verify), and the
--    shipped precedent is 0021 issue_operation_resolution, which format-checks
--    p_signature ('^sha256:[0-9a-f]{64}$'), binds it to the row, and leaves the
--    cryptographic check to the caller. These commands do the same: they validate
--    the shape, bind the value, and enforce single use by CAS. The gateway/Go layer
--    must verify before calling, and the batch's PG tests assert the binding and the
--    single-use, not the cryptography.
--
-- 2. Challenges and tickets are never stored in plaintext (§4.1 "无明文ticket"), so a
--    replayed mint cannot re-emit the secret it returned the first time. Replay
--    returns the same identity with the secret null and replayed=true; the client
--    must have kept the first response. The confirm command therefore takes the
--    challenge back from the client and compares its hash, which is what lets the
--    server reconstruct the signed string without storing it.
--
-- Idempotency for the three commands that have no table of their own (revoke_device,
-- revoke_workspace_grant, rebind_run_workspace) uses the audit row as the receipt,
-- the same carrier 0019/0027 chose for advance_governance_event_cursor: a partial
-- unique index on (org, actor, action, request_id) plus a request_hash comparison.
-- No second ledger is created.
-- ---------------------------------------------------------------------------

CREATE FUNCTION work.pair_device(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_client_request_id text,
  p_device_name text,
  p_platform text,
  p_public_key_jwk jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_request_hash text;
  v_existing work.device_pairing%ROWTYPE;
  v_thumbprint text;
  v_challenge text;
  v_device_id uuid;
  v_pairing_id uuid;
  v_gate text;
  v_expires timestamptz;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  v_request_hash := work.sha256_text('device.pair|' || COALESCE(p_device_name, '')
    || '|' || COALESCE(p_platform, '') || '|' || COALESCE(p_public_key_jwk::text, ''));

  SELECT * INTO v_existing FROM work.device_pairing
    WHERE org_id = p_org_id AND owner_subject_id = p_actor_subject_id
      AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('pairing_id', v_existing.id,
      'device_id', v_existing.device_id, 'challenge', null,
      'expires_at', v_existing.expires_at,
      'public_key_thumbprint', v_existing.public_key_thumbprint, 'replayed', true);
  END IF;

  IF p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_auth_plane IS DISTINCT FROM 'bearer'
     OR p_auth_epoch IS NULL OR p_auth_epoch < 0
     OR p_platform IS DISTINCT FROM 'windows-x64'
     OR p_device_name IS NULL
     OR length(btrim(p_device_name)) NOT BETWEEN 1 AND 120
     OR NOT work.device_pubkey_valid(p_public_key_jwk) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM work.member
      WHERE org_id = p_org_id AND subject_id = p_actor_subject_id
        AND status = 'active') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- J20/J37: an organization that has not configured its local policy has no device
  -- surface at all, and the refusal must leave zero rows behind.
  v_gate := work.local_policy_gate(p_org_id);
  IF v_gate <> 'ready' THEN
    -- Literal codes, not a formatted one: the raise-coverage gate can only see a
    -- lowercase literal, and a dynamic message would ship an unregistered code.
    IF v_gate = 'local_policy_incomplete' THEN
      RAISE EXCEPTION 'local_policy_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'local_policy_not_configured' USING ERRCODE = 'P0001';
  END IF;

  v_thumbprint := work.device_key_thumbprint(p_public_key_jwk);
  IF EXISTS (SELECT 1 FROM work.device
      WHERE org_id = p_org_id AND public_key_thumbprint = v_thumbprint
        AND status <> 'revoked') THEN
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
  END IF;

  v_challenge := work.sha256_text(gen_random_uuid()::text || gen_random_uuid()::text);
  v_device_id := gen_random_uuid();
  v_pairing_id := gen_random_uuid();
  v_expires := now() + interval '120 seconds';

  INSERT INTO work.device
    (org_id, id, owner_subject_id, device_name, platform, public_key_jwk,
     public_key_thumbprint, auth_plane, auth_epoch, status)
  VALUES
    (p_org_id, v_device_id, p_actor_subject_id, btrim(p_device_name), p_platform,
     p_public_key_jwk, v_thumbprint, p_auth_plane, p_auth_epoch, 'pending');

  INSERT INTO work.device_pairing
    (org_id, id, device_id, owner_subject_id, auth_plane, auth_epoch, purpose,
     challenge_hash, public_key_thumbprint, client_request_id, request_hash, expires_at)
  VALUES
    (p_org_id, v_pairing_id, v_device_id, p_actor_subject_id, p_auth_plane, p_auth_epoch,
     'pair', work.sha256_text(v_challenge), v_thumbprint, p_client_request_id,
     v_request_hash, v_expires);

  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'device.pairing_created',
    'device', v_device_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'pairing_id', v_pairing_id,
      'auth_plane', p_auth_plane, 'auth_epoch', p_auth_epoch));

  RETURN jsonb_build_object('pairing_id', v_pairing_id, 'device_id', v_device_id,
    'challenge', v_challenge, 'expires_at', v_expires,
    'public_key_thumbprint', v_thumbprint, 'replayed', false);
END;
$$;

CREATE FUNCTION work.confirm_device_pairing(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_pairing_id uuid,
  p_client_request_id text,
  p_challenge text,
  p_signature text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_pairing work.device_pairing%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_canonical text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  v_request_hash := work.sha256_text('device.pair.confirm|' || p_pairing_id::text
    || '|' || COALESCE(p_challenge, '') || '|' || COALESCE(p_signature, ''));

  -- The receipt is the audit row, not the pairing row: the pairing carries the
  -- *pairing* request_id, while confirm has its own. Same carrier 0019/0027 chose.
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'device.pair.confirm'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF p_signature IS NULL OR p_signature !~ '^sha256:[0-9a-f]{64}$'
     OR p_challenge IS NULL OR p_challenge !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request:signature' USING ERRCODE = '22023';
  END IF;

  -- Lock the device before the pairing so the order matches §4.3 (org -> member ->
  -- ... -> device) rather than taking the child lock first.
  SELECT * INTO v_pairing FROM work.device_pairing
    WHERE org_id = p_org_id AND id = p_pairing_id
      AND owner_subject_id = p_actor_subject_id AND purpose = 'pair'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = v_pairing.device_id FOR UPDATE;

  -- The same desktop identity that started the pairing must finish it: plane first,
  -- then that plane's epoch, never cross-plane (§1.1).
  IF v_pairing.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_pairing.auth_epoch IS DISTINCT FROM p_auth_epoch
     OR v_device.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_device.auth_epoch IS DISTINCT FROM p_auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  IF v_device.status = 'revoked' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  IF v_pairing.state <> 'pending' THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  IF v_pairing.expires_at <= now() THEN
    UPDATE work.device_pairing SET state = 'expired', updated_at = now(),
      revision = revision + 1
      WHERE org_id = p_org_id AND id = p_pairing_id AND state = 'pending';
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  -- The challenge comes back from the client because only its hash is stored.
  IF work.sha256_text(p_challenge) IS DISTINCT FROM v_pairing.challenge_hash THEN
    RAISE EXCEPTION 'invalid_request:signature' USING ERRCODE = '22023';
  END IF;

  v_canonical := 'work-device-pair-v2|' || p_pairing_id::text || '|' || p_challenge
    || '|' || v_pairing.public_key_thumbprint || '|' || p_org_id || '|'
    || p_actor_subject_id;

  UPDATE work.device_pairing
    SET state = 'consumed', consumed_at = now(), updated_at = now(),
        revision = revision + 1
    WHERE org_id = p_org_id AND id = p_pairing_id AND state = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  UPDATE work.device SET status = 'active', updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND id = v_device.id AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;

  -- The certificate itself is signed by the device CA OUTSIDE this transaction
  -- (§4.3: external calls never run inside a database transaction). The serial and
  -- expiry are written by a second call once the CA has answered; a device that is
  -- active without a certificate simply cannot connect, which is fail-closed.
  v_response := jsonb_build_object('device_id', v_device.id, 'status', 'active',
    'cert_serial', null, 'cert_not_after', null, 'certificate_pem', null,
    'auth_plane', p_auth_plane, 'auth_epoch', p_auth_epoch);

  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'device.pair.confirm',
    'device', v_device.id::text,
    jsonb_build_object('request_id', p_client_request_id, 'pairing_id', p_pairing_id,
      'request_hash', v_request_hash, 'signed_string_hash', work.sha256_text(v_canonical),
      'signature', p_signature, 'response', v_response));

  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

CREATE FUNCTION work.mint_device_session_ticket(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_device_id uuid,
  p_client_request_id text,
  p_public_key_thumbprint text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_device work.device%ROWTYPE;
  v_request_hash text;
  v_existing work.device_session_ticket%ROWTYPE;
  v_ticket text;
  v_id uuid;
  v_expires timestamptz;
  v_gate text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  v_request_hash := work.sha256_text('device.session_ticket|' || p_device_id::text
    || '|' || COALESCE(p_public_key_thumbprint, ''));
  SELECT * INTO v_existing FROM work.device_session_ticket
    WHERE org_id = p_org_id AND owner_subject_id = p_actor_subject_id
      AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('session_ticket_id', v_existing.id, 'ticket', null,
      'expires_at', v_existing.expires_at, 'device_id', v_existing.device_id,
      'replayed', true);
  END IF;

  IF p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_auth_plane IS DISTINCT FROM 'bearer'
     OR p_auth_epoch IS NULL OR p_auth_epoch < 0
     OR p_public_key_thumbprint IS NULL
     OR p_public_key_thumbprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id
      AND owner_subject_id = p_actor_subject_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_device.status <> 'active' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  IF v_device.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_device.auth_epoch IS DISTINCT FROM p_auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  -- §1.4: renewal and tickets never accept a different key.
  IF v_device.public_key_thumbprint IS DISTINCT FROM p_public_key_thumbprint THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_gate := work.local_policy_gate(p_org_id);
  IF v_gate <> 'ready' THEN
    -- Literal codes, not a formatted one: the raise-coverage gate can only see a
    -- lowercase literal, and a dynamic message would ship an unregistered code.
    IF v_gate = 'local_policy_incomplete' THEN
      RAISE EXCEPTION 'local_policy_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'local_policy_not_configured' USING ERRCODE = 'P0001';
  END IF;

  v_ticket := work.sha256_text(gen_random_uuid()::text || gen_random_uuid()::text);
  v_id := gen_random_uuid();
  v_expires := now() + interval '60 seconds';
  INSERT INTO work.device_session_ticket
    (org_id, id, device_id, owner_subject_id, auth_plane, auth_epoch,
     public_key_thumbprint, ticket_hash, client_request_id, request_hash, expires_at)
  VALUES
    (p_org_id, v_id, p_device_id, p_actor_subject_id, p_auth_plane, p_auth_epoch,
     p_public_key_thumbprint, work.sha256_text(v_ticket), p_client_request_id,
     v_request_hash, v_expires);

  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'device.session_ticket_minted',
    'device', p_device_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'session_ticket_id', v_id));

  RETURN jsonb_build_object('session_ticket_id', v_id, 'ticket', v_ticket,
    'expires_at', v_expires, 'device_id', p_device_id, 'replayed', false);
END;
$$;

CREATE FUNCTION work.renew_device_certificate(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_device_id uuid,
  p_client_request_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_device work.device%ROWTYPE;
  v_request_hash text;
  v_existing work.device_pairing%ROWTYPE;
  v_challenge text;
  v_id uuid;
  v_expires timestamptz;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  v_request_hash := work.sha256_text('device.cert.renew|' || p_device_id::text);
  SELECT * INTO v_existing FROM work.device_pairing
    WHERE org_id = p_org_id AND owner_subject_id = p_actor_subject_id
      AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('pairing_id', v_existing.id, 'challenge', null,
      'expires_at', v_existing.expires_at, 'purpose', 'renew', 'replayed', true);
  END IF;

  IF p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_auth_plane IS DISTINCT FROM 'bearer'
     OR p_auth_epoch IS NULL OR p_auth_epoch < 0 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id
      AND owner_subject_id = p_actor_subject_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_device.status <> 'active' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  IF v_device.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_device.auth_epoch IS DISTINCT FROM p_auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  -- device §2.1 step 4: renewal is requested within the last hour of the certificate.
  -- Earlier than that is refused so a certificate cannot be rolled indefinitely.
  IF v_device.cert_not_after IS NULL
     OR v_device.cert_not_after - now() > interval '1 hour' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_challenge := work.sha256_text(gen_random_uuid()::text || gen_random_uuid()::text);
  v_id := gen_random_uuid();
  v_expires := now() + interval '120 seconds';
  INSERT INTO work.device_pairing
    (org_id, id, device_id, owner_subject_id, auth_plane, auth_epoch, purpose,
     challenge_hash, public_key_thumbprint, client_request_id, request_hash, expires_at)
  VALUES
    (p_org_id, v_id, p_device_id, p_actor_subject_id, p_auth_plane, p_auth_epoch,
     'renew', work.sha256_text(v_challenge), v_device.public_key_thumbprint,
     p_client_request_id, v_request_hash, v_expires);

  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'device.cert.renew_requested',
    'device', p_device_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'pairing_id', v_id));

  RETURN jsonb_build_object('pairing_id', v_id, 'challenge', v_challenge,
    'expires_at', v_expires, 'purpose', 'renew', 'replayed', false);
END;
$$;

CREATE FUNCTION work.activate_device_session(
  p_org_id text,
  p_device_id uuid,
  p_ticket_hash text,
  p_hello jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_ticket work.device_session_ticket%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session_id uuid;
  v_generation bigint;
  v_expires timestamptz;
  v_subject text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF p_ticket_hash IS NULL OR p_ticket_hash !~ '^[0-9a-f]{64}$'
     OR p_hello IS NULL OR jsonb_typeof(p_hello) <> 'object' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Uniform refusal: do not confirm that a device id exists in another org.
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  IF v_device.status <> 'active' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;

  -- The claim is the CAS: only the call that flips pending->consumed gets a session.
  UPDATE work.device_session_ticket
    SET state = 'consumed', consumed_at = now(), updated_at = now(),
        revision = revision + 1
    WHERE org_id = p_org_id AND device_id = p_device_id
      AND ticket_hash = p_ticket_hash AND state = 'pending'
      AND expires_at > now()
      AND auth_plane = v_device.auth_plane AND auth_epoch = v_device.auth_epoch
      AND public_key_thumbprint = v_device.public_key_thumbprint
    RETURNING * INTO v_ticket;
  IF NOT FOUND THEN
    -- Expired tickets are lazy-marked by the same read that refuses them; no sweeper.
    UPDATE work.device_session_ticket
      SET state = 'expired', updated_at = now(), revision = revision + 1
      WHERE org_id = p_org_id AND device_id = p_device_id
        AND ticket_hash = p_ticket_hash AND state = 'pending' AND expires_at <= now();
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  v_subject := v_ticket.owner_subject_id;

  IF (p_hello ->> 'boot_id') IS NULL OR (p_hello ->> 'boot_id') = ''
     OR (p_hello ->> 'agent_instance_id') IS NULL
     OR (p_hello ->> 'journal_epoch') IS NULL
     OR (p_hello ->> 'runtime_digest') IS NULL
     OR (p_hello ->> 'runtime_digest') !~ '^[0-9a-f]{64}$'
     OR (p_hello ->> 'protocol_major') IS NULL
     OR (p_hello ->> 'protocol_minor') IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT access_epoch INTO v_generation FROM work.org WHERE id = p_org_id;
  v_session_id := gen_random_uuid();
  v_expires := now() + interval '8 hours';

  -- One active session per device: the old one is terminalized, never deleted.
  UPDATE work.device_session
    SET state = 'superseded', updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND device_id = p_device_id AND state = 'active';

  INSERT INTO work.device_session
    (org_id, id, device_id, owner_subject_id, boot_id, agent_instance_id, auth_plane,
     auth_epoch, protocol_major, protocol_minor, runtime_digest, profile_id,
     journal_epoch, generation, session_ticket_id, expires_at)
  VALUES
    (p_org_id, v_session_id, p_device_id, v_subject, p_hello ->> 'boot_id',
     (p_hello ->> 'agent_instance_id')::uuid, v_device.auth_plane, v_device.auth_epoch,
     (p_hello ->> 'protocol_major')::int, (p_hello ->> 'protocol_minor')::int,
     p_hello ->> 'runtime_digest', p_hello ->> 'profile_id',
     (p_hello ->> 'journal_epoch')::uuid, COALESCE(v_generation, 0), v_ticket.id,
     v_expires);

  PERFORM work.append_audit(p_org_id, v_subject, 'device.session_activated',
    'device', p_device_id::text,
    jsonb_build_object('session_id', v_session_id, 'session_ticket_id', v_ticket.id,
      'journal_epoch', p_hello ->> 'journal_epoch'));

  RETURN jsonb_build_object('session_id', v_session_id, 'server_time', now(),
    'generation', COALESCE(v_generation, 0), 'lease_ttl_ms', 30000,
    'heartbeat_ms', 10000, 'resync_required', true);
END;
$$;

CREATE FUNCTION work.revoke_device(
  p_org_id text,
  p_actor_subject_id text,
  p_device_id uuid,
  p_client_request_id text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_org work.org%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_deny_id uuid;
  v_sessions int;
  v_leases int;
  v_intents int;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  v_request_hash := work.sha256_text('device.revoke|' || p_device_id::text
    || '|' || COALESCE(p_reason, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'device.revoke' AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  -- §4.3 lock order: org first. Revocation does NOT raise either plane's epoch
  -- (§1.1: device revoke is a deny, not an epoch bump, and the two must not be
  -- substituted for one another).
  SELECT * INTO v_org FROM work.org WHERE id = p_org_id FOR UPDATE;
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id
      AND owner_subject_id = p_actor_subject_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE work.device
    SET status = 'revoked', revoked_at = now(), updated_at = now(),
        revision = revision + 1
    WHERE org_id = p_org_id AND id = p_device_id AND status <> 'revoked';

  UPDATE work.device_session
    SET state = 'revoked', updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND device_id = p_device_id AND state = 'active';
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  UPDATE work.execution_lease
    SET state = 'revoked', updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND device_id = p_device_id AND state = 'active';
  GET DIAGNOSTICS v_leases = ROW_COUNT;

  v_deny_id := gen_random_uuid();
  INSERT INTO work.access_restriction
    (id, org_id, scope, device_id, source, reason, epoch, release_floor_revision, state)
  VALUES
    (v_deny_id, p_org_id, 'device', p_device_id, 'device', btrim(p_reason),
     v_org.access_epoch, v_org.revision, 'active');

  -- One intent per affected Run, keyed by the deny that caused it. The outbox is
  -- deliberately not used: the relay fails unknown kinds non-retryably.
  INSERT INTO work.cancellation_intent (org_id, source_event_id, run_id, reason)
    SELECT p_org_id, v_deny_id, r.id, 'device_revoked'
      FROM work.run r
      JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
      JOIN work.device_run_binding b
        ON b.run_id = r.id AND b.org_id = r.org_id AND b.device_id = p_device_id
     WHERE r.org_id = p_org_id
       AND r.state IN ('queued', 'active', 'waiting', 'cancel_requested')
    ON CONFLICT (org_id, source_event_id, run_id) DO NOTHING;
  GET DIAGNOSTICS v_intents = ROW_COUNT;

  v_response := jsonb_build_object('device_id', p_device_id, 'status', 'revoked',
    'revoked_sessions', v_sessions, 'revoked_leases', v_leases,
    'cancellation_intents', v_intents, 'restriction_id', v_deny_id);

  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'device.revoke',
    'device', p_device_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'response', v_response));

  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

CREATE FUNCTION work.register_workspace_grant(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_device_id uuid,
  p_session_id uuid,
  p_client_request_id text,
  p_grant jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_policy work.local_execution_policy%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_request_hash text;
  v_existing work.workspace_grant%ROWTYPE;
  v_rule jsonb;
  v_index int;
  v_server_class text;
  v_claimed text;
  v_effective text;
  v_max_confirmable text;
  v_tools text[];
  v_root_ref uuid;
  v_id uuid;
  v_expires timestamptz;
  v_ttl int;
  v_gate text;
  v_response jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  v_request_hash := work.sha256_text('workspace_grant.register|' || p_device_id::text
    || '|' || p_session_id::text || '|' || COALESCE(p_grant::text, ''));
  SELECT * INTO v_existing FROM work.workspace_grant
    WHERE org_id = p_org_id AND owner_subject_id = p_actor_subject_id
      AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('grant_id', v_existing.id, 'root_ref', v_existing.root_ref,
      'classification', v_existing.classification,
      'allowed_tools', to_jsonb(v_existing.allowed_tools),
      'grant_revision', v_existing.grant_revision, 'expires_at', v_existing.expires_at,
      'state', v_existing.state, 'matched_rule_index', v_existing.matched_rule_index,
      'replayed', true);
  END IF;

  IF p_grant IS NULL OR jsonb_typeof(p_grant) <> 'object'
     OR p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_auth_plane IS DISTINCT FROM 'bearer'
     OR p_auth_epoch IS NULL OR p_auth_epoch < 0 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id
      AND owner_subject_id = p_actor_subject_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_device.status <> 'active' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id AND device_id = p_device_id
      AND owner_subject_id = p_actor_subject_id;
  IF NOT FOUND OR v_session.state <> 'active' THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  IF v_session.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM p_auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  v_gate := work.local_policy_gate(p_org_id);
  IF v_gate <> 'ready' THEN
    -- Literal codes, not a formatted one: the raise-coverage gate can only see a
    -- lowercase literal, and a dynamic message would ship an unregistered code.
    IF v_gate = 'local_policy_incomplete' THEN
      RAISE EXCEPTION 'local_policy_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'local_policy_not_configured' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_policy FROM work.local_execution_policy WHERE org_id = p_org_id;

  v_tools := ARRAY(SELECT jsonb_array_elements_text(p_grant -> 'allowed_tools'));
  IF v_tools IS NULL OR cardinality(v_tools) = 0
     OR NOT work.text_array_closed_unique(v_tools, ARRAY[
       'workspace.list', 'workspace.read', 'workspace.search', 'artifact.write']::text[])
     OR NOT (v_tools <@ v_policy.allowed_tools) THEN
    -- Only narrowing is allowed: the platform closed set AND the organization's own
    -- allowlist both bound it.
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_claimed := p_grant ->> 'classification_claimed';
  IF v_claimed IS NOT NULL AND work.classification_rank(v_claimed) IS NULL THEN
    RAISE EXCEPTION 'classification_unknown' USING ERRCODE = 'P0001';
  END IF;

  -- The server takes the classification from its own mapping. The device only reports
  -- WHICH entry matched, because only the device can see the path (invariant 5).
  v_index := NULLIF(p_grant ->> 'matched_rule_index', '')::int;
  v_max_confirmable := NULL;
  IF v_index IS NULL THEN
    v_server_class := v_policy.classification_default;
  ELSE
    IF v_index < 0 OR v_index >= jsonb_array_length(v_policy.classification_rules) THEN
      RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
    END IF;
    v_rule := v_policy.classification_rules -> v_index;
    v_server_class := v_rule ->> 'classification';
    v_max_confirmable := v_rule ->> 'max_confirmable';
  END IF;

  -- The claimed value is cross-check only: looser than the server's determination is
  -- refused outright, stricter is allowed but never beyond the rule's ceiling.
  IF v_claimed IS NOT NULL
     AND work.classification_rank(v_claimed) < work.classification_rank(v_server_class) THEN
    RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
  END IF;
  v_effective := v_server_class;
  IF v_claimed IS NOT NULL
     AND work.classification_rank(v_claimed) > work.classification_rank(v_server_class) THEN
    v_effective := v_claimed;
  END IF;
  IF work.classification_rank(v_effective)
     < work.classification_rank(v_policy.classification_floor) THEN
    RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
  END IF;
  IF v_max_confirmable IS NOT NULL
     AND work.classification_rank(v_effective)
        > work.classification_rank(v_max_confirmable) THEN
    RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
  END IF;

  v_ttl := COALESCE(NULLIF(p_grant ->> 'user_selected_ttl_seconds', '')::int, 28800);
  IF v_ttl < 1 OR v_ttl > 28800 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- min(8h, the user's choice, the session's remaining life).
  v_expires := LEAST(now() + make_interval(secs => v_ttl), v_session.expires_at);
  IF v_expires <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  v_root_ref := COALESCE(NULLIF(p_grant ->> 'root_ref', '')::uuid, gen_random_uuid());
  IF (p_grant ->> 'root_identity_hash') IS NULL
     OR (p_grant ->> 'root_identity_hash') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_id := gen_random_uuid();

  INSERT INTO work.workspace_grant
    (org_id, id, device_id, session_id, owner_subject_id, boot_id, root_ref,
     root_identity_hash, allowed_tools, classification, matched_rule_index,
     expires_at, client_request_id, request_hash)
  VALUES
    (p_org_id, v_id, p_device_id, p_session_id, p_actor_subject_id, v_session.boot_id,
     v_root_ref, p_grant ->> 'root_identity_hash', v_tools, v_effective, v_index,
     v_expires, p_client_request_id, v_request_hash);

  v_response := jsonb_build_object('grant_id', v_id, 'root_ref', v_root_ref,
    'classification', v_effective, 'allowed_tools', to_jsonb(v_tools),
    'grant_revision', 1, 'expires_at', v_expires, 'state', 'active',
    'matched_rule_index', v_index,
    'classification_derivation', jsonb_build_object('matched_rule_index', v_index,
      'server_value', v_server_class, 'claimed_value', v_claimed,
      'max_confirmable', v_max_confirmable,
      'floor', v_policy.classification_floor, 'result', v_effective));

  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'workspace_grant.registered',
    'workspace_grant', v_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'response', v_response));

  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

CREATE FUNCTION work.revoke_workspace_grant(
  p_org_id text,
  p_actor_subject_id text,
  p_grant_id uuid,
  p_client_request_id text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_org work.org%ROWTYPE;
  v_grant work.workspace_grant%ROWTYPE;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_deny_id uuid;
  v_invalidated int;
  v_intents int;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  v_request_hash := work.sha256_text('workspace_grant.revoke|' || p_grant_id::text
    || '|' || COALESCE(p_reason, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'workspace_grant.revoke'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_org FROM work.org WHERE id = p_org_id FOR UPDATE;
  SELECT * INTO v_grant FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = p_grant_id
      AND owner_subject_id = p_actor_subject_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE work.workspace_grant
    SET state = 'revoked', updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND id = p_grant_id AND state = 'active';

  -- §6.3: a directory revocation only affects actions referencing THIS grant.
  UPDATE work.readonly_approval_grant
    SET status = 'invalidated', updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND workspace_grant_id = p_grant_id AND status = 'active';
  GET DIAGNOSTICS v_invalidated = ROW_COUNT;

  v_deny_id := gen_random_uuid();
  INSERT INTO work.access_restriction
    (id, org_id, scope, workspace_grant_id, source, reason, epoch,
     release_floor_revision, state)
  VALUES
    (v_deny_id, p_org_id, 'grant', p_grant_id, 'grant', btrim(p_reason),
     v_org.access_epoch, v_org.revision, 'active');

  INSERT INTO work.cancellation_intent (org_id, source_event_id, run_id, reason)
    SELECT p_org_id, v_deny_id, r.id, 'workspace_grant_revoked'
      FROM work.run r
      JOIN work.device_run_binding b ON b.run_id = r.id AND b.org_id = r.org_id
     WHERE r.org_id = p_org_id
       AND r.state IN ('queued', 'active', 'waiting', 'cancel_requested')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(b.grant_set) e
                    WHERE (e ->> 'grant_id')::uuid = p_grant_id)
    ON CONFLICT (org_id, source_event_id, run_id) DO NOTHING;
  GET DIAGNOSTICS v_intents = ROW_COUNT;

  v_response := jsonb_build_object('grant_id', p_grant_id, 'state', 'revoked',
    'invalidated_readonly_grants', v_invalidated, 'cancellation_intents', v_intents,
    'restriction_id', v_deny_id);
  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'workspace_grant.revoke',
    'workspace_grant', p_grant_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

CREATE FUNCTION work.rebind_run_workspace(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_run_id uuid,
  p_client_request_id text,
  p_old_grant_id uuid,
  p_new_grant_id uuid,
  p_proof jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_old work.workspace_grant%ROWTYPE;
  v_new work.workspace_grant%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_revision bigint;
  v_nonce uuid;
  v_grant_set jsonb;
  v_invalidated int;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  v_request_hash := work.sha256_text('run.workspace_rebind|' || p_run_id::text
    || '|' || p_old_grant_id::text || '|' || p_new_grant_id::text
    || '|' || COALESCE(p_proof::text, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'run.workspace_rebind'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_old_grant_id IS NULL OR p_new_grant_id IS NULL
     OR p_old_grant_id = p_new_grant_id
     OR p_proof IS NULL OR jsonb_typeof(p_proof) <> 'object'
     OR (p_proof ->> 'signature') IS NULL
     OR (p_proof ->> 'signature') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_proof ->> 'nonce') IS NULL
     OR (p_proof ->> 'root_identity_hash') IS NULL
     OR (p_proof ->> 'root_identity_hash') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- The proof must name the same transition the HTTP fields do; a signature over one
  -- transition may not be presented for another.
  IF (p_proof ->> 'old_grant_id')::uuid IS DISTINCT FROM p_old_grant_id
     OR (p_proof ->> 'new_grant_id')::uuid IS DISTINCT FROM p_new_grant_id
     OR (p_proof ->> 'run_id')::uuid IS DISTINCT FROM p_run_id
     OR p_proof ->> 'auth_plane' IS DISTINCT FROM p_auth_plane
     OR (p_proof ->> 'auth_epoch')::bigint IS DISTINCT FROM p_auth_epoch THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  IF v_task.owner_subject_id IS DISTINCT FROM p_actor_subject_id
     OR v_task.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.state <> 'waiting' OR v_run.wait_reason IS DISTINCT FROM 'input' THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id
    ORDER BY binding_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  -- old_grant must be the Run's CURRENT grant: rebinding is a chain, so the second
  -- rebind names the first rebind's new grant (§4.1).
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_binding.grant_set) e
                  WHERE (e ->> 'grant_id')::uuid = p_old_grant_id) THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_old FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = p_old_grant_id FOR UPDATE;
  SELECT * INTO v_new FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = p_new_grant_id FOR UPDATE;
  IF NOT FOUND OR v_new.state <> 'active' THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_new.owner_subject_id IS DISTINCT FROM p_actor_subject_id
     OR v_new.device_id IS DISTINCT FROM v_binding.device_id THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;
  IF v_new.root_identity_hash IS DISTINCT FROM v_old.root_identity_hash
     OR v_new.root_identity_hash IS DISTINCT FROM (p_proof ->> 'root_identity_hash') THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;

  v_revision := v_binding.binding_revision + 1;
  v_nonce := gen_random_uuid();
  SELECT jsonb_agg(
           CASE WHEN (e ->> 'grant_id')::uuid = p_old_grant_id
                THEN jsonb_build_object('grant_id', p_new_grant_id,
                                        'grant_revision', v_new.grant_revision)
                ELSE e END)
    INTO v_grant_set
    FROM jsonb_array_elements(v_binding.grant_set) e;

  INSERT INTO work.workspace_grant_succession
    (org_id, run_id, old_grant_id, new_grant_id, proof_hash, binding_revision,
     client_request_id, request_hash)
  VALUES
    (p_org_id, p_run_id, p_old_grant_id, p_new_grant_id,
     work.sha256_text(p_proof::text), v_revision, p_client_request_id, v_request_hash);

  UPDATE work.workspace_grant
    SET state = 'succeeded', succeeded_by = p_new_grant_id, updated_at = now(),
        revision = revision + 1
    WHERE org_id = p_org_id AND id = p_old_grant_id AND state = 'active';

  UPDATE work.readonly_approval_grant
    SET status = 'invalidated', updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND workspace_grant_id = p_old_grant_id AND status = 'active';
  GET DIAGNOSTICS v_invalidated = ROW_COUNT;

  -- expected_checkpoint stays NULL in this batch: device_checkpoint lands in batch
  -- two, so there is no recorded baseline to point at yet. This is fail-closed, not
  -- half a command - acquire_device_lease (batch two) must refuse to start a resume
  -- offer whose expected_checkpoint is NULL, and batch two MUST restate this function
  -- to fill both columns from the Run's latest recorded checkpoint (not filtered by
  -- fence). The obligation is recorded in the design doc, not left to a reader.
  INSERT INTO work.device_run_binding
    (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
     input_hash, snapshot_descriptor_ref, snapshot_hash, profile_id, profile_revision,
     runtime_digest, tool_manifest_hash, model_version, grant_set, start_nonce,
     offer_expiry, state)
  VALUES
    (p_org_id, p_run_id, v_revision, v_binding.task_id, v_binding.device_id,
     v_new.session_id, v_binding.input_ref, v_binding.input_hash,
     v_binding.snapshot_descriptor_ref, v_binding.snapshot_hash, v_binding.profile_id,
     v_binding.profile_revision, v_binding.runtime_digest, v_binding.tool_manifest_hash,
     v_binding.model_version, v_grant_set, v_nonce, now() + interval '120 seconds',
     'offered');

  UPDATE work.run
    SET control_revision = control_revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_run_id;

  v_response := jsonb_build_object('run_id', p_run_id, 'old_grant_id', p_old_grant_id,
    'new_grant_id', p_new_grant_id, 'binding_revision', v_revision,
    'expected_checkpoint_seq', null, 'expected_checkpoint_hash', null,
    'offer_expiry', now() + interval '120 seconds', 'state', 'offered',
    'invalidated_readonly_grants', v_invalidated);
  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'run.workspace_rebind',
    'run', p_run_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'nonce', p_proof ->> 'nonce', 'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

CREATE FUNCTION work.list_devices(
  p_org_id text,
  p_actor_subject_id text,
  p_cursor text,
  p_limit int
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_limit int := COALESCE(p_limit, 50);
  v_after_ts timestamptz;
  v_after_id uuid;
  v_parts text[];
  v_items jsonb;
  v_last work.device%ROWTYPE;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF v_limit < 1 OR v_limit > 100 THEN
    RAISE EXCEPTION 'invalid_pagination' USING ERRCODE = '22023';
  END IF;
  IF p_cursor IS NOT NULL AND p_cursor <> '' THEN
    v_parts := string_to_array(p_cursor, '|');
    IF cardinality(v_parts) <> 3
       OR v_parts[1] IS DISTINCT FROM work.sha256_text(
            p_org_id || '|' || p_actor_subject_id || '|device.list|'
            || v_parts[2] || '|' || v_parts[3]) THEN
      RAISE EXCEPTION 'invalid_pagination' USING ERRCODE = '22023';
    END IF;
    v_after_ts := to_timestamp(v_parts[2]::double precision / 1000);
    v_after_id := v_parts[3]::uuid;
  END IF;

  SELECT jsonb_agg(x ORDER BY x ->> 'created_at' DESC, x ->> 'device_id' DESC)
    INTO v_items
    FROM (
      SELECT jsonb_build_object('device_id', d.id, 'device_name', d.device_name,
               'platform', d.platform, 'status', d.status, 'auth_plane', d.auth_plane,
               'auth_epoch', d.auth_epoch, 'cert_not_after', d.cert_not_after,
               'revoked_at', d.revoked_at, 'created_at', d.created_at,
               'revision', d.revision) AS x
        FROM work.device d
       WHERE d.org_id = p_org_id AND d.owner_subject_id = p_actor_subject_id
         AND (v_after_ts IS NULL
              OR (d.created_at, d.id) < (v_after_ts, v_after_id))
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT v_limit
    ) s;

  RETURN jsonb_build_object('items', COALESCE(v_items, '[]'::jsonb),
    'next_cursor', null);
END;
$$;

CREATE FUNCTION work.list_workspace_grants(
  p_org_id text,
  p_actor_subject_id text,
  p_device_id uuid,
  p_cursor text,
  p_limit int
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_limit int := COALESCE(p_limit, 50);
  v_items jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF v_limit < 1 OR v_limit > 100 OR (p_cursor IS NOT NULL AND p_cursor <> '') THEN
    RAISE EXCEPTION 'invalid_pagination' USING ERRCODE = '22023';
  END IF;

  -- root_identity_hash is deliberately not returned: it is a device-key HMAC, and
  -- echoing it would hand out cross-device correlation material.
  SELECT jsonb_agg(x) INTO v_items
    FROM (
      SELECT jsonb_build_object('grant_id', g.id, 'device_id', g.device_id,
               'session_id', g.session_id, 'root_ref', g.root_ref,
               'classification', g.classification,
               'allowed_tools', to_jsonb(g.allowed_tools),
               'grant_revision', g.grant_revision, 'expires_at', g.expires_at,
               'state', g.state, 'succeeded_by', g.succeeded_by,
               'matched_rule_index', g.matched_rule_index,
               'created_at', g.created_at, 'revision', g.revision) AS x
        FROM work.workspace_grant g
       WHERE g.org_id = p_org_id AND g.owner_subject_id = p_actor_subject_id
         AND (p_device_id IS NULL OR g.device_id = p_device_id)
       ORDER BY g.created_at DESC, g.id DESC
       LIMIT v_limit
    ) s;

  RETURN jsonb_build_object('items', COALESCE(v_items, '[]'::jsonb),
    'next_cursor', null);
END;
$$;

-- ---------------------------------------------------------------------------
-- Idempotency receipts for the three commands with no table of their own.
--
-- The audit row IS the receipt (0019/0027 chose this carrier over a second ledger).
-- The unique index is what makes a replay detectable as a database fact; the bodies
-- compare request_hash so the same key with a different payload is a 409, not a
-- silent second effect.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX work_audit_device_command_receipt
  ON work.audit_event (org_id, actor_subject_id, action, (metadata ->> 'request_id'))
  WHERE action IN ('device.pair.confirm', 'device.revoke', 'workspace_grant.revoke',
                   'run.workspace_rebind');

-- ---------------------------------------------------------------------------
-- Privileges. Nothing is callable by PUBLIC. The identity, grant and approval faces
-- go to work_api; the gateway hello face goes to work_worker. No new group role is
-- introduced (card R-a), so both privilege sweeps keep their pinned want strings.
-- No table privilege is granted at all: every effect goes through the definers,
-- which is the 0024 house rule.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION work.device_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.device_pairing_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.device_session_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.device_session_ticket_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.workspace_grant_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.workspace_grant_succession_same_root() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.execution_lease_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.device_run_binding_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.readonly_approval_grant_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION work.pair_device(
  text, text, text, bigint, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.confirm_device_pairing(
  text, text, text, bigint, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.mint_device_session_ticket(
  text, text, text, bigint, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.renew_device_certificate(
  text, text, text, bigint, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.activate_device_session(
  text, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.revoke_device(text, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.register_workspace_grant(
  text, text, text, bigint, uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.revoke_workspace_grant(
  text, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.rebind_run_workspace(
  text, text, text, bigint, uuid, text, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.list_devices(text, text, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.list_workspace_grants(
  text, text, uuid, text, int) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION work.pair_device(
  text, text, text, bigint, text, text, text, jsonb) TO work_api;
GRANT EXECUTE ON FUNCTION work.confirm_device_pairing(
  text, text, text, bigint, uuid, text, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.mint_device_session_ticket(
  text, text, text, bigint, uuid, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.renew_device_certificate(
  text, text, text, bigint, uuid, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.revoke_device(text, text, uuid, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.register_workspace_grant(
  text, text, text, bigint, uuid, uuid, text, jsonb) TO work_api;
GRANT EXECUTE ON FUNCTION work.revoke_workspace_grant(
  text, text, uuid, text, text) TO work_api;
GRANT EXECUTE ON FUNCTION work.rebind_run_workspace(
  text, text, text, bigint, uuid, text, uuid, uuid, jsonb) TO work_api;
GRANT EXECUTE ON FUNCTION work.list_devices(text, text, text, int) TO work_api;
GRANT EXECUTE ON FUNCTION work.list_workspace_grants(
  text, text, uuid, text, int) TO work_api;
GRANT EXECUTE ON FUNCTION work.activate_device_session(
  text, uuid, text, jsonb) TO work_worker;

REVOKE ALL ON TABLE work.device FROM PUBLIC;
REVOKE ALL ON TABLE work.device FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.device_pairing FROM PUBLIC;
REVOKE ALL ON TABLE work.device_pairing FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.device_session FROM PUBLIC;
REVOKE ALL ON TABLE work.device_session FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.device_session_ticket FROM PUBLIC;
REVOKE ALL ON TABLE work.device_session_ticket FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.workspace_grant FROM PUBLIC;
REVOKE ALL ON TABLE work.workspace_grant FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.workspace_grant_succession FROM PUBLIC;
REVOKE ALL ON TABLE work.workspace_grant_succession FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.execution_lease FROM PUBLIC;
REVOKE ALL ON TABLE work.execution_lease FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.device_run_binding FROM PUBLIC;
REVOKE ALL ON TABLE work.device_run_binding FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;
REVOKE ALL ON TABLE work.readonly_approval_grant FROM PUBLIC;
REVOKE ALL ON TABLE work.readonly_approval_grant FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;

RESET ROLE;