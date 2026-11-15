-- 0046: device pairing real-signature reconciliation (M3 gateway GW1, P0 #1).
--
-- The device agent (src/device) produces a real ES256 signature: fixed 64-byte
-- R||S, base64url without padding (86 characters), over the pipe-delimited pairing
-- covered string `work-device-pair-v2|pairing_id|challenge|thumbprint|org|subject`
-- (device-design §2.1 step 3). Until now confirm_device_pairing only shape-checked
-- a `sha256:<64hex>` PLACEHOLDER (0040:1314) because plpgsql cannot verify ES256
-- (pgcrypto has no ECDSA verify); the cryptographic check is the Go/gateway layer's
-- job (0040:1135, 0021 precedent). This increment reconciles the SQL shape with the
-- real signature and adds the read path the Go layer needs to verify BEFORE calling
-- the domain command.
--
-- Two changes, both keeping the shipped judgment order intact:
--   * device_pairing_signing_key: a SECURITY DEFINER getter returning the device's
--     public_key_jwk for the actor's own pair-purpose pairing. work_api has no table
--     privilege (0024 house rule), so the Go handler reaches the in-DB public key
--     only through this function. The design forbids taking the public key from the
--     request body (m1a §12 judgment 5); this getter is the in-DB source.
--   * confirm_device_pairing: CREATE OR REPLACE restating every 0040 check verbatim,
--     changing ONLY the signature shape from the placeholder `^sha256:[0-9a-f]{64}$`
--     to the real ES256 form `^[A-Za-z0-9_-]{86}$`. The function still binds the
--     signature into the request hash and the audit row; it does NOT verify the
--     cryptography (the Go handler does, before calling). CREATE OR REPLACE preserves
--     privileges but inherits neither SECURITY DEFINER nor search_path, so both are
--     restated in the body (0041:17-19 house rule).
--
-- No new public error code is registered: the getter raises not_found and the
-- restated command keeps invalid_request:signature / unauthorized / device_revoked /
-- idempotency_key_conflict, all already mapped. No table privilege is granted.

SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- device_pairing_signing_key: the in-DB public key for the actor's pairing.
-- Scoped to org + owner subject + purpose='pair' so a caller cannot read another
-- subject's pairing key. The public key is not secret, but the scope keeps the
-- judgment order (m1a §12) and avoids a cross-subject read oracle. The pairing
-- state is deliberately not filtered here: confirm_device_pairing owns the state
-- CAS, and reading a public key for a consumed pairing is harmless.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.device_pairing_signing_key(
  p_org_id text,
  p_actor_subject_id text,
  p_pairing_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_jwk jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  SELECT d.public_key_jwk INTO v_jwk
  FROM work.device_pairing p
  JOIN work.device d ON d.org_id = p.org_id AND d.id = p.device_id
  WHERE p.org_id = p_org_id AND p.id = p_pairing_id
    AND p.owner_subject_id = p_actor_subject_id AND p.purpose = 'pair';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_jwk;
END;
$$;

REVOKE ALL ON FUNCTION work.device_pairing_signing_key(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.device_pairing_signing_key(text, text, uuid) TO work_api;

-- ---------------------------------------------------------------------------
-- confirm_device_pairing: restated verbatim from 0040:1270-1390 with ONLY the
-- signature shape reconciled to the real ES256 form. Every other check, the lock
-- order, the idempotency receipt, the lazy expiry, the challenge-hash comparison,
-- the covered-string reconstruction, the CAS consume/activate and the audit row are
-- unchanged. The Go handler verifies the ES256 signature over v_canonical before
-- this command runs; SQL still only binds the value.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work.confirm_device_pairing(
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

  -- The signature is the real ES256 R||S in base64url without padding (64 bytes ->
  -- 86 characters). The Go/gateway layer verifies the cryptography before calling;
  -- this shape check only rejects anything that is not that encoding.
  IF p_signature IS NULL OR p_signature !~ '^[A-Za-z0-9_-]{86}$'
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

RESET ROLE;