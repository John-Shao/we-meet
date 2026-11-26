-- 0078: allow the Bearer API face to verify PossessionProof signatures.
-- 0047's SECURITY DEFINER getter already returns only the org-scoped public JWK;
-- the acceptance command still owns device/session/owner checks. Granting execute
-- to work_api adds no table privilege and no private-key surface (0024 house rule).
SET ROLE work_owner;

GRANT EXECUTE ON FUNCTION work.device_signing_key(text, uuid) TO work_api;

RESET ROLE;
