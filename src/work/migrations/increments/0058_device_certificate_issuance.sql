-- 0058: the device certificate issuance record and the renewal consumption face
-- (M3 GW20, device-design §2.1 steps 3-4).
--
-- 主签 2026-11-18 四项单选：① CA 私钥**从配置注入 work-api**，test CA 进 CI，生产 CA
-- 托管/轮换/TPM 企业策略继续挂 J39；② 签发时序保留 0040:1374-1377 注释的"CA 在事务外
-- 签发 → 第二次调用写序列号与到期"，并**让续期面兼作补发路径**以消除死锁；③ purpose=
-- 'renew' 的 challenge 由**新增独立函数**消费，0046 的 confirm_device_pairing 原样不动；
-- ④ 续期用独立签名域 work-device-cert-renew-v2（§2.1"签名域不跨配对/许可/receipt 复用"
-- 禁止沿用配对域；设计只命名了配对域，续期域名是实现选择，如实登记）。
--
-- WHAT WAS ALREADY LANDED. 0040 created work.device with the cert_serial/cert_not_after
-- pair (both nullable, device_cert_shape forces them null-or-set together), device_guard
-- (:244-272) refusing a cert write unless OLD.status='active', pair_device (:1233-1237)
-- refusing a second live device for one key thumbprint, confirm_device_pairing activating
-- pending->active, and renew_device_certificate (:1489-1570) minting a purpose='renew'
-- challenge inside the certificate's last hour. 0046 restated confirm for the real ES256
-- shape and added device_pairing_signing_key, scoped to purpose='pair'.
--
-- WHAT WAS MISSING — all four faces, and one dead end. No function anywhere wrote
-- cert_serial/cert_not_after, so the "second call" 0040:1374-1377 promises did not exist;
-- deviceca.IssueDeviceCert had only test callers; both confirm responses hardcoded the
-- certificate triple to null (0046:193-195, 0040:1378-1380); and purpose='renew' had a
-- producer but NO consumer, because confirm only selects purpose='pair'. The dead end:
-- a device whose issuance failed after confirm committed is active with a NULL certificate,
-- so renew refuses it (cert_not_after IS NULL, :1547) AND pair_device refuses the same key
-- (:1233) — the only escape was an operator revoke plus re-pairing. Ruling ② closes it by
-- letting the renewal face serve as the re-issuance path when no certificate exists.
--
-- WHY THE NULL BRANCH IS NOT A LOOSENING OF §2.1 STEP 4. The one-hour window exists so a
-- *valid* certificate cannot be rolled indefinitely ("提前 1h 请求"). A device with no
-- certificate has nothing to roll and cannot connect at all: activate_device_session
-- requires status='active' (:1606) but the mTLS handshake needs a CA-signed client
-- certificate, so the device is fail-closed. Refusing it permanently bricks the row. The
-- window is therefore kept verbatim whenever a certificate exists, and skipped only when
-- cert_not_after IS NULL. Every other renew precondition (active, owner, plane, epoch,
-- new one-shot challenge, current Host session) is unchanged.
--
-- WHY THE SERIAL "MUST MOVE FORWARD" CLAIM IS ONLY HALF ENFORCEABLE. 0040:260-262 says a
-- serial "may not be rewritten to a different one behind the caller's back: renewal
-- replaces it, so it must move forward, not sideways" — but the shipped trigger implemented
-- only the active gate, and until this increment no writer existed to make the claim
-- testable. The checkable half is the EXPIRY: a replacement must extend the recorded
-- validity, never roll it back, and that is now enforced for every writer. Numeric serial
-- ordering is deliberately NOT enforced: the CA mints random 128-bit serials
-- (deviceca.IssueDeviceCert), which are not monotonic, so a "greater serial" rule would
-- refuse legitimate renewals. This is a correction of the comment's overclaim, not a new
-- weakening.
--
-- WHY record_device_certificate BINDS A CONSUMED PAIRING. Writing the certificate pair is
-- an authority-bearing act, so it is not enough to be the device's owner: the caller must
-- present the pairing whose challenge the device just signed, consumed, for this device and
-- this subject. One pairing yields one certificate (a second request_id against an already
-- recorded pairing is idempotency_key_conflict).
--
-- WHY THE REQUEST HASH EXCLUDES THE CERTIFICATE MATERIAL. Everywhere else the request hash
-- binds the client's payload so a reused request_id with different content is a conflict.
-- Here the serial, expiry and PEM are produced by the SERVER's CA, not sent by the client:
-- a retry after a lost response necessarily re-signs and gets a fresh random serial, and
-- hashing that in would turn every honest retry into idempotency_key_conflict. The hash
-- therefore binds the identity scope (device + pairing) only, and a replay returns the
-- recorded certificate rather than the freshly signed one, so the response and the row can
-- never disagree. The certificate PEM is public credential material, not user content, so
-- storing it in the audit response does not touch invariant 9 (PG holds no body text).
--
-- §4.3: the CA call itself stays OUTSIDE every transaction here. These functions only
-- record what the CA already answered; none of them signs anything.
--
-- New public code: device_cert_must_advance (SQLSTATE 23514, so it keeps the 400
-- invalid_request fallback its sibling device_cert_requires_active already has). No table
-- privilege is granted; every new function is REVOKEd from PUBLIC before its role grant.

SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- device_guard: restate 0040:244-272 verbatim and add the expiry-advance check.
-- A trigger function carries neither SECURITY DEFINER nor search_path, so there
-- is nothing to restate beyond the body; CREATE OR REPLACE keeps the existing
-- REVOKE and the three triggers attached to it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work.device_guard() RETURNS trigger
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
  -- The enforceable half of "forward, not sideways" (see the header): a replacement
  -- certificate must extend the recorded validity. A NULL expiry is left to
  -- device_cert_shape, which owns the null-or-set-together rule.
  IF OLD.cert_serial IS NOT NULL
     AND NEW.cert_serial IS DISTINCT FROM OLD.cert_serial
     AND NEW.cert_not_after <= OLD.cert_not_after THEN
    RAISE EXCEPTION 'device_cert_must_advance' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'device_revoked_at_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- device_renewal_signing_key: the in-DB public key for the actor's RENEW-purpose
-- pairing. Mirrors 0046's device_pairing_signing_key exactly, with purpose='renew';
-- that getter is left untouched so the shipped pairing path does not move. The Go
-- handler needs the key BEFORE the domain command to verify ES256, and the key must
-- never come from the request body (m1a §12 judgment 5). Pairing state is not
-- filtered here for the same reason 0046 gives: the confirm command owns the CAS.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.device_renewal_signing_key(
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
    AND p.owner_subject_id = p_actor_subject_id AND p.purpose = 'renew';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_jwk;
END;
$$;

REVOKE ALL ON FUNCTION work.device_renewal_signing_key(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.device_renewal_signing_key(text, text, uuid) TO work_api;

-- ---------------------------------------------------------------------------
-- confirm_device_certificate_renewal: the missing consumer of purpose='renew'.
-- Same judgment order as confirm_device_pairing (0046:104-203) — org context,
-- session subject, idempotency receipt, signature shape, locks, plane/epoch, status,
-- one-shot CAS, challenge hash, audit. Differences, all deliberate:
--   * purpose='renew' instead of 'pair';
--   * the device must already be active (renewal never activates anything);
--   * the covered string uses work-device-cert-renew-v2, so a pairing signature
--     cannot be replayed as a renewal signature (§2.1 domain separation);
--   * no status transition and no certificate write: the CA signs outside the
--     transaction and record_device_certificate writes the pair afterwards.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.confirm_device_certificate_renewal(
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

  v_request_hash := work.sha256_text('device.cert.renew_confirm|' || p_pairing_id::text
    || '|' || COALESCE(p_challenge, '') || '|' || COALESCE(p_signature, ''));

  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'device.cert.renew_confirm'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF p_signature IS NULL OR p_signature !~ '^[A-Za-z0-9_-]{86}$'
     OR p_challenge IS NULL OR p_challenge !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request:signature' USING ERRCODE = '22023';
  END IF;

  -- §4.3 lock order is parent before child, so the DEVICE row is locked first even
  -- though the pairing is what identifies it: FOR UPDATE OF d locks only the device
  -- side of the join, and the pairing is locked afterwards. (0046:134-144 states this
  -- order in its comment but implements pairing-first; that shipped inversion is left
  -- untouched here and registered as a defect rather than copied.)
  SELECT d.* INTO v_device FROM work.device d
    JOIN work.device_pairing p ON p.org_id = d.org_id AND p.device_id = d.id
    WHERE p.org_id = p_org_id AND p.id = p_pairing_id
      AND p.owner_subject_id = p_actor_subject_id AND p.purpose = 'renew'
    FOR UPDATE OF d;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_pairing FROM work.device_pairing
    WHERE org_id = p_org_id AND id = p_pairing_id
      AND owner_subject_id = p_actor_subject_id AND purpose = 'renew'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_pairing.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_pairing.auth_epoch IS DISTINCT FROM p_auth_epoch
     OR v_device.auth_plane IS DISTINCT FROM p_auth_plane
     OR v_device.auth_epoch IS DISTINCT FROM p_auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  IF v_device.status <> 'active' THEN
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
  IF work.sha256_text(p_challenge) IS DISTINCT FROM v_pairing.challenge_hash THEN
    RAISE EXCEPTION 'invalid_request:signature' USING ERRCODE = '22023';
  END IF;

  v_canonical := 'work-device-cert-renew-v2|' || p_pairing_id::text || '|' || p_challenge
    || '|' || v_pairing.public_key_thumbprint || '|' || p_org_id || '|'
    || p_actor_subject_id;

  UPDATE work.device_pairing
    SET state = 'consumed', consumed_at = now(), updated_at = now(),
        revision = revision + 1
    WHERE org_id = p_org_id AND id = p_pairing_id AND state = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  v_response := jsonb_build_object('device_id', v_device.id, 'status', 'active',
    'cert_serial', null, 'cert_not_after', null, 'certificate_pem', null,
    'auth_plane', p_auth_plane, 'auth_epoch', p_auth_epoch);

  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'device.cert.renew_confirm',
    'device', v_device.id::text,
    jsonb_build_object('request_id', p_client_request_id, 'pairing_id', p_pairing_id,
      'request_hash', v_request_hash, 'signed_string_hash', work.sha256_text(v_canonical),
      'signature', p_signature, 'response', v_response));

  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION work.confirm_device_certificate_renewal(
  text, text, text, bigint, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.confirm_device_certificate_renewal(
  text, text, text, bigint, uuid, text, text, text) TO work_api;

-- ---------------------------------------------------------------------------
-- record_device_certificate: the "second call" 0040:1374-1377 promised. The CA has
-- already answered outside any transaction; this writes the serial and expiry, and
-- stores the certificate PEM in the audit response so a replay returns the SAME
-- certificate the row records. It never signs and never activates.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.record_device_certificate(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_device_id uuid,
  p_pairing_id uuid,
  p_client_request_id text,
  p_cert_serial text,
  p_cert_not_after timestamptz,
  p_certificate_pem text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_device work.device%ROWTYPE;
  v_pairing work.device_pairing%ROWTYPE;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  -- The certificate material is server-generated, so it is deliberately NOT in the
  -- hash (see the header): an honest retry re-signs and must still replay.
  v_request_hash := work.sha256_text('device.cert.record|' || p_device_id::text
    || '|' || p_pairing_id::text);

  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'device.cert.recorded'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_auth_plane IS DISTINCT FROM 'bearer'
     OR p_auth_epoch IS NULL OR p_auth_epoch < 0
     OR p_cert_serial IS NULL OR p_cert_serial !~ '^[1-9][0-9]{0,38}$'
     OR p_cert_not_after IS NULL
     OR p_certificate_pem IS NULL OR p_certificate_pem = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- §2.1 step 4 fixes the lifetime at 24h. The bound is measured against the DATABASE
  -- clock while the expiry comes from the CA's certificate, which the API host stamped:
  -- the two differ (68ms measured locally, and deviceca.IssueDeviceCert additionally
  -- backdates NotBefore by one minute for peer clock skew), so an exact 24h bound
  -- refuses every honestly issued certificate. Five minutes of tolerance keeps the
  -- check discriminating — a 25h or a 100-year expiry is still refused — without making
  -- it a clock-race. An already-expired certificate is refused outright.
  IF p_cert_not_after <= now()
     OR p_cert_not_after > now() + interval '24 hours' + interval '5 minutes' THEN
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

  SELECT * INTO v_pairing FROM work.device_pairing
    WHERE org_id = p_org_id AND id = p_pairing_id
      AND device_id = p_device_id AND owner_subject_id = p_actor_subject_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_pairing.state <> 'consumed' THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  -- One pairing yields one certificate. A replay with the SAME request_id already
  -- returned above; reaching here with a different one means a second issuance
  -- against a pairing that has spent its authority.
  IF EXISTS (SELECT 1 FROM work.audit_event
      WHERE org_id = p_org_id AND action = 'device.cert.recorded'
        AND metadata ->> 'pairing_id' = p_pairing_id::text) THEN
    RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
  END IF;
  -- A pairing may not overwrite a certificate it did not issue: first issuance
  -- requires an empty pair, replacement is the renewal path's job.
  IF v_pairing.purpose = 'pair' AND v_device.cert_serial IS NOT NULL THEN
    RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.device
    SET cert_serial = p_cert_serial, cert_not_after = p_cert_not_after,
        updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND id = p_device_id;

  v_response := jsonb_build_object('device_id', p_device_id, 'status', 'active',
    'cert_serial', p_cert_serial, 'cert_not_after', p_cert_not_after,
    'certificate_pem', p_certificate_pem,
    'auth_plane', p_auth_plane, 'auth_epoch', p_auth_epoch);

  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'device.cert.recorded',
    'device', p_device_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'pairing_id', p_pairing_id,
      'purpose', v_pairing.purpose, 'request_hash', v_request_hash,
      'previous_cert_serial', v_device.cert_serial, 'response', v_response));

  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION work.record_device_certificate(
  text, text, text, bigint, uuid, uuid, text, text, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.record_device_certificate(
  text, text, text, bigint, uuid, uuid, text, text, timestamptz, text) TO work_api;

-- ---------------------------------------------------------------------------
-- renew_device_certificate: restate 0040:1489-1570 verbatim, changing ONLY the
-- NULL branch (ruling ②). CREATE OR REPLACE preserves privileges but inherits
-- neither SECURITY DEFINER nor search_path, so both are restated (0041:17-19).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work.renew_device_certificate(
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
  -- A device with NO certificate is exempt (0058, ruling ②): it cannot connect at
  -- all, pair_device refuses its key while it is live, and refusing it here too
  -- would leave an operator revoke as the only escape. This face is therefore also
  -- the re-issuance path for an issuance that failed after confirm committed.
  IF v_device.cert_not_after IS NOT NULL
     AND v_device.cert_not_after - now() > interval '1 hour' THEN
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

RESET ROLE;