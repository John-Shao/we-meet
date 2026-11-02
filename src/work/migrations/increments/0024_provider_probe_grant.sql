-- 0024: a producer for the provider connectivity probe, and the detail its conflict
-- response has always owed.
--
-- Authority: contract r0a-openapi-v1.yaml:523-547 (`setProviderConfig` - "保存前网关会发
-- 一次最小真实请求做连通探测，失败不生效"), D-08b (可即时吊销 + 强审计), and §7.5
-- per-organization credential resolution.
--
-- Three obligations had no producer.
--
--   * The probe itself. Egress is the only process allowed to make an upstream model
--     call - the Go-direct runtime path was deleted by the 2026-10-29 P0 fix - but every
--     request it serves is bound to a dispatch gate, so an admin write that has no Run
--     and no Operation had no way to ask it anything. The probe cannot ride on
--     `work.runtime_capability`: its `execution_id` carries a composite FK to
--     `work.runtime_execution` (0010:88-90) and `audience` is the closed enum
--     ('work-content', 'work-egress'), so a grant belonging to no model execution cannot
--     be represented there without weakening both. This increment gives the ask its own
--     row, its own token and a one-shot consume.
--
--   * No bounded read path for secret material. Consume returns the candidate
--     credential's ciphertext itself, so there is deliberately no standalone
--     "resolve a credential by id" function: ciphertext leaves the database only by
--     presenting a token that an authenticated org owner just minted for this org, this
--     provider and this endpoint, and that has not been used before.
--
--   * 0002:4265 raises `revision_conflict` with no DETAIL while the catalogue maps that
--     code to `version_conflict`, which apierr refuses without a numeric detail - the
--     same failure 0018:114-115 avoids by writing DETAIL = OLD.revision::text, and the
--     same class already fixed once for run_not_quiescent. That raise is unreachable
--     today only because no HTTP route calls set_provider_config. It is deliberately NOT
--     patched here: replacing a SECURITY DEFINER body means restating all of it, and the
--     catalog embeds prosrc, so that change belongs in the same commit that lands
--     setProviderConfig and can prove the 409 end to end. Until then this grant is the
--     only new surface, and nothing here alters a served response.
SET ROLE work_owner;

CREATE TABLE work.provider_probe_grant (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  subject_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  endpoint text NOT NULL,
  credential_id uuid NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT provider_probe_grant_subject_shape CHECK (subject_id <> ''),
  CONSTRAINT provider_probe_grant_provider_check
    CHECK (provider IN ('aliyun', 'volcengine', 'deepseek')),
  CONSTRAINT provider_probe_grant_shape_check
    CHECK (length(btrim(model)) BETWEEN 1 AND 120 AND endpoint ~ '^https://'),
  CONSTRAINT provider_probe_grant_window CHECK (expires_at > issued_at),
  CONSTRAINT provider_probe_grant_consumed_after_issue
    CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CONSTRAINT provider_probe_grant_credential_fkey
    FOREIGN KEY (credential_id, org_id)
    REFERENCES work.provider_credential(id, org_id),
  CONSTRAINT provider_probe_grant_org_fkey
    FOREIGN KEY (org_id) REFERENCES work.org(id),
  UNIQUE (org_id, token_hash)
);

ALTER TABLE work.provider_probe_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.provider_probe_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.provider_probe_grant
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- A grant is a single-use nonce whose binding columns ARE the authorisation: allowing
-- them to be rewritten would let a consumed grant be re-pointed at another endpoint or
-- another credential. Only consumed_at may ever change, and only once.
CREATE FUNCTION work.provider_probe_grant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
     OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'provider_probe_grant_binding_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NOT NULL
     AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'provider_probe_grant_consumed_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_probe_grant_guard
  BEFORE UPDATE ON work.provider_probe_grant
  FOR EACH ROW EXECUTE FUNCTION work.provider_probe_grant_guard();

-- Mint one probe grant. Every binding column is validated here rather than trusted from
-- the caller, because the same values are what egress will dial and what consume will
-- hand back as ciphertext. The credential checks mirror work.set_provider_config
-- exactly, so a grant can only ever exist for a config that could actually be saved.
CREATE FUNCTION work.issue_provider_probe_grant(
  p_org_id text,
  p_subject_id text,
  p_provider text,
  p_model text,
  p_endpoint text,
  p_credential_id uuid,
  p_token_hash text,
  p_ttl_seconds int
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  credential work.provider_credential%ROWTYPE;
  new_id uuid := gen_random_uuid();
BEGIN
  PERFORM work.assert_org_owner(p_org_id, p_subject_id);
  IF p_provider NOT IN ('aliyun', 'volcengine', 'deepseek') THEN
    RAISE EXCEPTION 'invalid_request:provider' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(btrim(p_model)) NOT BETWEEN 1 AND 120
     OR p_endpoint IS NULL OR p_endpoint !~ '^https://' THEN
    RAISE EXCEPTION 'invalid_request:provider_config' USING ERRCODE = '22023';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request:token_hash' USING ERRCODE = '22023';
  END IF;
  -- A probe is a connectivity check, not a session: the window is bounded so a grant
  -- cannot outlive the admin action that asked for it.
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'invalid_request:ttl' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  SELECT * INTO credential FROM work.provider_credential
    WHERE id = p_credential_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF credential.state <> 'active' THEN
    RAISE EXCEPTION 'provider_credential_revoked' USING ERRCODE = 'P0001';
  END IF;
  IF credential.provider <> p_provider THEN
    RAISE EXCEPTION 'provider_credential_mismatch' USING ERRCODE = '22023';
  END IF;
  INSERT INTO work.provider_probe_grant
    (grant_id, org_id, subject_id, provider, model, endpoint, credential_id,
     token_hash, expires_at)
  VALUES
    (new_id, p_org_id, p_subject_id, p_provider, btrim(p_model), btrim(p_endpoint),
     p_credential_id, p_token_hash, now() + make_interval(secs => p_ttl_seconds));
  RETURN new_id;
END;
$$;

-- Spend a grant and return what one upstream call needs, in one statement. The claim is
-- atomic: the row is only returned if this call is the one that flipped consumed_at from
-- NULL, so a replayed token reads as invalid rather than as a second provider call.
-- Expired, consumed, unknown and wrong-token all collapse to the same code on purpose -
-- distinguishing them would make this an oracle over grant ids.
CREATE FUNCTION work.consume_provider_probe_grant(
  p_org_id text,
  p_grant_id uuid,
  p_token_hash text
) RETURNS TABLE (
  provider text,
  model text,
  endpoint text,
  credential_mode text,
  secret_ciphertext bytea,
  wrapped_dek bytea,
  kms_key_ref text,
  secret_fingerprint text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  PERFORM set_config('app.org_id', p_org_id, true);
  -- The claim and the read are one statement: UPDATE...RETURNING yields a row only for
  -- the call that flipped consumed_at, so a replayed token claims nothing. Every
  -- reference is table-qualified because the OUT columns share names with the rows.
  RETURN QUERY
  WITH claimed AS (
    UPDATE work.provider_probe_grant g
       SET consumed_at = now()
      FROM work.provider_credential c
     WHERE g.grant_id = p_grant_id
       AND g.org_id = p_org_id
       AND g.token_hash = p_token_hash
       AND g.consumed_at IS NULL
       AND g.expires_at > now()
       AND c.id = g.credential_id
       AND c.org_id = g.org_id
       AND c.state = 'active'
    RETURNING g.org_id AS claim_org, g.grant_id AS claim_id, g.provider AS claim_provider,
              g.model AS claim_model, g.endpoint AS claim_endpoint,
              g.credential_id AS claim_credential
  )
  SELECT k.claim_provider, k.claim_model, k.claim_endpoint, c.mode,
         c.secret_ciphertext, c.wrapped_dek, c.kms_key_ref, c.secret_fingerprint
    FROM claimed k
    JOIN work.provider_credential c
      ON c.id = k.claim_credential AND c.org_id = k.claim_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'probe_grant_invalid' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: nothing is callable by PUBLIC, and each role gets exactly the half
-- it owns - the API mints, the worker role (which egress connects as, the same
-- identity that already resolves provider context) spends. No role holds the
-- trigger's owner privileges, and no table privilege is granted at all: every
-- effect goes through the definer bodies above.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION work.provider_probe_grant_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.issue_provider_probe_grant(
  text, text, text, text, text, uuid, text, int
) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.consume_provider_probe_grant(text, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION work.issue_provider_probe_grant(
  text, text, text, text, text, uuid, text, int
) TO work_api;
GRANT EXECUTE ON FUNCTION work.consume_provider_probe_grant(text, uuid, text) TO work_worker;

RESET ROLE;
