-- 0017: R0b transition authority, plus the columns that existing entities need
-- before any local Run can be written.
--
-- Authority: control design §4.1 (the three state_transition judgments, the
-- `operation` increment, the `artifact_version` increment, the classification
-- closed set and its backfill order) and the `resolution.state ->
-- operation.state` mapping, which §4.1 requires to be a table rather than
-- prose. Validation exits: EV97 (classification floor, the cloud read path and
-- the "backfill before SET NOT NULL" order) and EV113 (a direct
-- waiting->succeeded proposal must fail with invalid_transition).
--
-- This increment registers no new edge for `task`/`run`/`operation`/
-- `artifact_version`. Every R0b verdict lands on an edge the baseline already
-- pins: `unknown -> reconciled` for both degradation paths,
-- `waiting -> active -> succeeded` for the local finish,
-- `prepared|waiting_approval|authorized -> canceled` for supersede. Two edges
-- deliberately stay absent and are asserted absent rather than commented:
-- `waiting -> succeeded` (it would skip the task-level gate inside
-- `finish_run`) and `dispatching -> canceled` (a dispatched action has no
-- server-side proof of non-execution, so §4.1 judgment 3 refuses the claim).
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- resolution.state -> operation.state
-- ---------------------------------------------------------------------------

-- The two vocabularies are not interchangeable. `operation_resolution.state`
-- is a settlement and delivery verdict; the Operation row keeps its own state.
-- A degradation issued while the Operation is `unknown` may only land
-- `reconciled`, because that is the sole registered target from `unknown`.
CREATE TABLE work.resolution_state_map (
  resolution_state text NOT NULL CHECK (resolution_state IN (
    'succeeded', 'failed', 'canceled', 'rejected_not_executed',
    'undelivered', 'sealed_not_sent'
  )),
  operation_state text NOT NULL CHECK (operation_state IN (
    'prepared', 'waiting_approval', 'authorized', 'dispatching', 'unknown',
    'succeeded', 'failed', 'canceled', 'reconciled', 'unresolved'
  )),
  PRIMARY KEY (resolution_state, operation_state)
);

INSERT INTO work.resolution_state_map (resolution_state, operation_state) VALUES
  ('succeeded', 'succeeded'),
  ('failed', 'reconciled'),
  ('failed', 'failed'),
  ('canceled', 'canceled'),
  ('rejected_not_executed', 'canceled'),
  ('rejected_not_executed', 'failed'),
  ('undelivered', 'succeeded'),
  ('sealed_not_sent', 'canceled');

-- Mirrors `work.state_transition`: a global whitelist, so no tenant column and
-- no RLS. It is read inside SECURITY DEFINER commands and by the two service
-- roles for pre-validation only; no role gets DML.
REVOKE ALL ON TABLE work.resolution_state_map FROM PUBLIC;
GRANT SELECT ON TABLE work.resolution_state_map TO work_api, work_worker;

-- ---------------------------------------------------------------------------
-- operation: step identity, supersede chain, reconcile clock
-- ---------------------------------------------------------------------------

ALTER TABLE work.operation
  ADD COLUMN step_key text,
  ADD COLUMN supersede_no int NOT NULL DEFAULT 0,
  ADD COLUMN reconcile_requested_at timestamptz,
  ADD COLUMN supersedes_operation_id uuid,
  ADD COLUMN supersede_reason text CHECK (supersede_reason IN (
    'reauthorized', 'approval_expired', 'source_changed', 'resend_undelivered'
  )),
  ADD COLUMN supersede_assertion_hash text CHECK (
    supersede_assertion_hash IS NULL
    OR supersede_assertion_hash ~ '^sha256:[0-9a-f]{64}$'
  );

-- Cloud Runs leave step_key null, so the key shape is conditional. An
-- unconditional predicate here would reject every R0a Operation row.
ALTER TABLE work.operation
  ADD CONSTRAINT operation_step_key_shape CHECK (
    step_key IS NULL
    OR (supersede_no >= 0 AND logical_key = step_key || '#' || supersede_no)
  );

-- Supersede fields are all-or-none. `supersede_assertion_hash` is not optional
-- on a supersede row: SupersedeAssertion is the only attributable evidence for
-- the act, so a supersede without it must not reach the table at all.
ALTER TABLE work.operation
  ADD CONSTRAINT operation_supersede_shape CHECK (
    (supersedes_operation_id IS NULL)
    = (supersede_reason IS NULL)
    AND (supersedes_operation_id IS NULL)
    = (supersede_assertion_hash IS NULL)
    AND (supersedes_operation_id IS NULL
         OR (step_key IS NOT NULL AND supersede_no >= 1))
  );

ALTER TABLE work.operation
  ADD CONSTRAINT operation_supersedes_operation_fk
  FOREIGN KEY (supersedes_operation_id, org_id)
  REFERENCES work.operation(id, org_id);

-- One open Operation per step, and one supersede per superseded Operation.
-- The terminal set is pinned to the registered operation states that
-- `task_has_blocking_operation` treats as non-blocking (baseline §598-612 is
-- exactly complementary to the state CHECK at baseline §177); `unresolved`
-- stays blocking on purpose, so it keeps occupying its step.
CREATE UNIQUE INDEX work_operation_one_open_step_per_run
  ON work.operation(org_id, run_id, step_key)
  WHERE step_key IS NOT NULL
    AND state NOT IN ('succeeded', 'failed', 'canceled', 'reconciled');

CREATE UNIQUE INDEX work_operation_supersedes_unique
  ON work.operation(org_id, supersedes_operation_id)
  WHERE supersedes_operation_id IS NOT NULL;

-- GET /runs/{id}/reconciliations shows how long each waiting Operation has
-- been blocked. Without this column no wait duration can be computed at all,
-- and without the partial index the read scans every Operation of the tenant.
CREATE INDEX work_operation_reconcile_wait
  ON work.operation(org_id, run_id, reconcile_requested_at)
  WHERE state IN ('unknown', 'unresolved');

-- The clock needs a writer, not a convention. §4.2 J16 wants the UI to show how long
-- an Operation has been waiting, and every path that enters unknown or unresolved
-- already exists in R0a (dispatch timeout, cancel_operation on a dispatched attempt,
-- reconcile), so requiring each of them to remember the timestamp would leave the
-- column NULL exactly when the wait is longest. The stamp is only set on entry and
-- never cleared: a row that leaves and re-enters waiting has genuinely waited twice,
-- and the older fact is the one the operator needs.
CREATE FUNCTION work.stamp_reconcile_clock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('unknown', 'unresolved')
     AND OLD.state IS DISTINCT FROM NEW.state
     AND NEW.reconcile_requested_at IS NULL THEN
    NEW.reconcile_requested_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER operation_reconcile_clock BEFORE UPDATE OF state ON work.operation
  FOR EACH ROW EXECUTE FUNCTION work.stamp_reconcile_clock();
REVOKE ALL ON FUNCTION work.stamp_reconcile_clock() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- artifact_version: location, stable v2 identity, classification
-- ---------------------------------------------------------------------------

ALTER TABLE work.artifact_version
  ADD COLUMN version_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN location text NOT NULL DEFAULT 'cloud' CHECK (location IN (
    'cloud', 'local_only'
  )),
  ADD COLUMN local_ref text,
  -- No foreign key yet: work.device is created by the device slice. A
  -- local_only row cannot be minted before that slice exists, so the missing
  -- edge is unexercisable here, and the FK lands with the table it points at.
  ADD COLUMN device_id uuid,
  ADD COLUMN classification text CHECK (classification IN (
    'local_only', 'remote_excerpt_allowed'
  ));

ALTER TABLE work.artifact_version ALTER COLUMN content_ref DROP NOT NULL;

-- Every pre-existing row is a cloud version, and §4.1 fixes the only legal
-- value for it. The backfill must precede SET NOT NULL; the reverse order
-- makes the migration fail, and the v2 read path cannot return a version with
-- a missing classification.
--
-- The migration role is subject to FORCE RLS, so a plain UPDATE would silently
-- match zero rows and still "succeed". Same technique as 0007: drop FORCE for
-- this statement only, then restore it.
ALTER TABLE work.artifact_version NO FORCE ROW LEVEL SECURITY;
UPDATE work.artifact_version
SET classification = 'remote_excerpt_allowed'
WHERE location = 'cloud' AND classification IS NULL;
ALTER TABLE work.artifact_version FORCE ROW LEVEL SECURITY;

ALTER TABLE work.artifact_version ALTER COLUMN classification SET NOT NULL;

-- classification has no DEFAULT on purpose: §4.1 forbids "missing means most
-- permissive", because a local_only version that forgot its classification would
-- otherwise read as exfiltrable. So the value for cloud rows is supplied here
-- rather than by a default: every existing R0a publisher (publish_artifact and
-- create_user_artifact_version) writes a cloud body, and §4.1 (3a) fixes the only
-- legal value for those rows. A BEFORE INSERT trigger runs before the NOT NULL
-- check, so the shipped commands need no rewrite - and a local_only insert that
-- omits classification still fails, which is the direction that must stay closed.
CREATE FUNCTION work.classify_cloud_artifact_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location = 'cloud' AND NEW.classification IS NULL THEN
    NEW.classification := 'remote_excerpt_allowed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER artifact_version_cloud_classification BEFORE INSERT ON work.artifact_version
  FOR EACH ROW EXECUTE FUNCTION work.classify_cloud_artifact_version();

-- A function created by an increment inherits the implicit PUBLIC EXECUTE grant
-- again (baseline's blanket revoke predates it), and the catalog cannot show that
-- grant because aclexplode(NULL) returns no rows.
REVOKE ALL ON FUNCTION work.classify_cloud_artifact_version() FROM PUBLIC;


ALTER TABLE work.artifact_version
  ADD CONSTRAINT artifact_version_location_shape CHECK (
    (location = 'cloud' AND content_ref IS NOT NULL)
    OR (location = 'local_only' AND content_ref IS NULL
        AND local_ref IS NOT NULL AND device_id IS NOT NULL)
  );

CREATE UNIQUE INDEX work_artifact_version_version_id
  ON work.artifact_version(org_id, version_id);

-- content_ref became nullable, so every comparison here must be
-- IS DISTINCT FROM: with the old `<>`, `NEW.content_ref <> OLD.content_ref`
-- evaluates to NULL whenever either side is null, and a local_only version
-- could silently rewrite its content reference past the immutability guard.
CREATE OR REPLACE FUNCTION work.artifact_version_immutable_content() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.content_ref IS DISTINCT FROM OLD.content_ref
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.media_type IS DISTINCT FROM OLD.media_type
     OR NEW.location IS DISTINCT FROM OLD.location
     OR NEW.local_ref IS DISTINCT FROM OLD.local_ref
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.classification IS DISTINCT FROM OLD.classification
     OR NEW.provenance IS DISTINCT FROM OLD.provenance THEN
    RAISE EXCEPTION 'artifact_version_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

RESET ROLE;
