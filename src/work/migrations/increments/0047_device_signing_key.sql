-- 0047: device signing key getter for gateway hello frame verification (M3 GW3).
--
-- The device gateway (work.device.v2.DeviceGateway/Connect, mTLS gRPC) verifies the
-- ES256 signature on every device frame BEFORE calling the domain command, exactly
-- as the pairing confirm handler does (0046, 0040:1135, 0021 precedent): plpgsql
-- cannot verify ES256, so the cryptography is the Go gateway's job and SQL only
-- shape-checks and binds. To verify the hello frame the gateway needs the device's
-- public_key_jwk, and work_worker has no SELECT on work.device (0040:2418 revokes
-- every table privilege under the 0024 house rule). This SECURITY DEFINER getter is
-- therefore the in-DB public key source for the gateway, keyed by device_id.
--
-- The public key is not secret; the org scope keeps the read inside the tenant the
-- gateway already mapped the mTLS certificate to. Device state is deliberately not
-- filtered here: activate_device_session owns the status='active' CAS (0040:1604),
-- and reading a public key for a revoked device is harmless — the domain command
-- refuses it. The gateway is a machine workload (work_worker), not an end-user
-- session, so there is no assert_session_subject: the mTLS certificate, not a
-- subject claim, is the caller identity (device-design §2.1 step 4, m1a §12.8 ①).
--
-- No new public error code is registered: org_context_mismatch is an internal guard
-- and not_found is already mapped. No table privilege is granted.

SET ROLE work_owner;

CREATE FUNCTION work.device_signing_key(
  p_org_id text,
  p_device_id uuid
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

  SELECT public_key_jwk INTO v_jwk
  FROM work.device
  WHERE org_id = p_org_id AND id = p_device_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_jwk;
END;
$$;

REVOKE ALL ON FUNCTION work.device_signing_key(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.device_signing_key(text, uuid) TO work_worker;

RESET ROLE;