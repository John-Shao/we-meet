-- 0018: R0b governance authority - the deny source rules, the governance
-- command-event ledger, and the access epoch every admission check depends on.
--
-- Authority: control design §3.4 (deny sources and the single release predicate
-- `release_floor_revision`), §3.1 (ListGovernanceEvents shape, the cursor's
-- org-local sequence and the "stop at a gap, never guess" rule), §6.1 (deny
-- creation, hint cutoff, cancellation intent lifecycle), §4.1 (these table rows)
-- and §4.3 (lock order: work.org first, so the epoch lives on the row that is
-- already the head of the lock chain). Validation exits: EV84/EV85/EV107/EV117.
--
-- The domain commands that write these tables land in the next increment. What
-- is enforced here is the part that must not depend on a caller behaving: the
-- closed sets, the deny source shape, the cursor's one-way advance, and the
-- immutability of the consumed-command record.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- Access epoch
-- ---------------------------------------------------------------------------

-- §6.1 freezes `admission_access_epoch` on the Run and compares it against a
-- hint's `cutoff_access_epoch`, but no table ever carried either column. The
-- counter lives on work.org because that row is the first lock in §4.3's order;
-- a separate counter table would need the same lock and buy nothing.
ALTER TABLE work.org ADD COLUMN access_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE work.run ADD COLUMN admission_access_epoch bigint NOT NULL DEFAULT 0;

-- Stamped on insert, not by each caller: run rows are created by several R0a
-- commands (submit_task, retry_task), and a future writer that forgets the
-- stamp would silently produce Runs that no late hint can ever reach - the
-- permissive direction. Overwriting whatever a caller passed is deliberate: the
-- frozen value must describe the moment of admission, not a client claim.
-- COALESCE is not a fallback that lets a Run slip through unattributed: this
-- trigger and the org execution gate are both BEFORE INSERT, and the gate
-- refuses any Run whose org row is not visible as active with execution
-- enabled, so an unseen epoch never reaches the table.
CREATE FUNCTION work.stamp_admission_access_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_epoch bigint;
BEGIN
  SELECT access_epoch INTO v_epoch FROM work.org WHERE id = NEW.org_id;
  NEW.admission_access_epoch := COALESCE(v_epoch, 0);
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_admission_access_epoch BEFORE INSERT ON work.run
  FOR EACH ROW EXECUTE FUNCTION work.stamp_admission_access_epoch();

-- ---------------------------------------------------------------------------
-- Transition whitelist for the new state machines
-- ---------------------------------------------------------------------------

-- `released` deliberately has no outgoing edge: §4.1 requires that a cursor
-- advance can never resurrect an already-released deny, and the whitelist is
-- what makes that a database fact rather than a caller convention.
INSERT INTO work.state_transition (entity, from_state, to_state) VALUES
  ('access_restriction', 'active', 'released'),
  ('access_restriction', 'active', 'reconcile_required'),
  ('access_restriction', 'reconcile_required', 'released'),
  ('governance_gap_report', 'pending', 'consumed'),
  ('governance_change', 'pending', 'applied'),
  ('governance_change', 'pending', 'reconcile'),
  ('governance_change', 'reconcile', 'applied'),
  ('cancellation_intent', 'pending', 'consumed'),
  ('cancellation_intent', 'pending', 'dead_letter')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- execution_entitlement: the operator-side commercial ceiling
-- ---------------------------------------------------------------------------

CREATE TABLE work.execution_entitlement (
  org_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  seat_limit bigint,
  operator_suspended boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 0,
  host_ack_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_entitlement_seat_limit_nonneg CHECK (
    seat_limit IS NULL OR seat_limit >= 0
  ),
  -- Unconfirmed Host ceiling must not read as an acknowledgement.
  CONSTRAINT execution_entitlement_ack_shape CHECK (
    host_ack_revision IS NULL OR host_ack_revision <= revision
  ),
  CONSTRAINT execution_entitlement_org_fk FOREIGN KEY (org_id)
    REFERENCES work.org(id)
);

ALTER TABLE work.execution_entitlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.execution_entitlement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.execution_entitlement
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- A missing row is not "unlimited": §3.2 names entitlement_incomplete for an
-- org with no configured ceiling, so the reader must distinguish absent from
-- zero. enabled defaults false for the same reason - nothing may be granted on
-- an entitlement nobody wrote.
CREATE FUNCTION work.execution_entitlement_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'execution_entitlement_content_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'governance_revision_conflict' USING ERRCODE = 'P0001',
      DETAIL = OLD.revision::text;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_entitlement_guard BEFORE UPDATE ON work.execution_entitlement
  FOR EACH ROW EXECUTE FUNCTION work.execution_entitlement_guard();
CREATE TRIGGER execution_entitlement_no_delete BEFORE DELETE ON work.execution_entitlement
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

-- ---------------------------------------------------------------------------
-- access_restriction: one deny, one source, one release rule
-- ---------------------------------------------------------------------------

CREATE TABLE work.access_restriction (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  -- §4.1 lists the column but never its value domain; these four are exactly the
  -- targets §3.4 and §6.1 can name (org, member, device, workspace grant), and
  -- the shape constraint below ties each one to the target column it must fill.
  scope text NOT NULL CHECK (scope IN ('org', 'member', 'device', 'grant')),
  subject_id text,
  device_id uuid,
  workspace_grant_id uuid,
  source text NOT NULL CHECK (source IN (
    'host_org', 'host_member', 'host_seat', 'work_seat_change', 'operator',
    'governance', 'policy', 'device', 'grant', 'model'
  )),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  epoch bigint NOT NULL CHECK (epoch >= 0),
  host_revision bigint,
  release_floor_revision bigint NOT NULL,
  source_change uuid,
  state text NOT NULL DEFAULT 'active' CHECK (state IN (
    'active', 'released', 'reconcile_required'
  )),
  released_by_revision bigint,
  released_at timestamptz,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  -- The scope decides which target column is filled, and only one of them may
  -- be. Without this, a deny could claim to bound a member while pointing at a
  -- device, and the admission check would have no way to notice.
  CONSTRAINT access_restriction_target_shape CHECK (
    (scope = 'org' AND subject_id IS NULL AND device_id IS NULL
       AND workspace_grant_id IS NULL)
    OR (scope = 'member' AND subject_id IS NOT NULL AND device_id IS NULL
       AND workspace_grant_id IS NULL)
    OR (scope = 'device' AND device_id IS NOT NULL AND subject_id IS NULL
       AND workspace_grant_id IS NULL)
    OR (scope = 'grant' AND workspace_grant_id IS NOT NULL AND subject_id IS NULL
       AND device_id IS NULL)
  ),
  -- host_* denys are only meaningful against an observed Host revision; the seat
  -- sources and operator/policy sources are not, and must leave it null so that
  -- nobody reads a stale host_revision as authority.
  CONSTRAINT access_restriction_host_revision_shape CHECK (
    (source IN ('host_org', 'host_member', 'host_seat') AND host_revision IS NOT NULL)
    OR (source NOT IN ('host_org', 'host_member', 'host_seat') AND host_revision IS NULL)
  ),
  -- Release is a single event, not a field edit: the releasing revision and the
  -- timestamp arrive together, and only for a released row.
  CONSTRAINT access_restriction_release_shape CHECK (
    (state = 'released' AND released_by_revision IS NOT NULL
       AND released_at IS NOT NULL)
    OR (state <> 'released' AND released_by_revision IS NULL
       AND released_at IS NULL)
  ),
  FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.access_restriction ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.access_restriction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.access_restriction
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Everything that gives the deny its meaning is fixed at creation. Only state,
-- the release pair, revision and updated_at may ever move; §3.4's release
-- predicate compares release_floor_revision, so making that column immutable is
-- what prevents a released deny from being quietly re-anchored to a new floor.
CREATE FUNCTION work.access_restriction_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.workspace_grant_id IS DISTINCT FROM OLD.workspace_grant_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.epoch IS DISTINCT FROM OLD.epoch
     OR NEW.host_revision IS DISTINCT FROM OLD.host_revision
     OR NEW.release_floor_revision IS DISTINCT FROM OLD.release_floor_revision
     OR NEW.source_change IS DISTINCT FROM OLD.source_change
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'access_restriction_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER access_restriction_guard BEFORE UPDATE ON work.access_restriction
  FOR EACH ROW EXECUTE FUNCTION work.access_restriction_guard();
CREATE TRIGGER access_restriction_no_delete BEFORE DELETE ON work.access_restriction
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER access_restriction_transition BEFORE UPDATE OF state
  ON work.access_restriction
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('access_restriction');

-- The admission check and the release scan are both "active or
-- reconcile_required for this target" (release_restriction must eat
-- reconcile_required, or the two-step cursor recovery strands the seat deny);
-- the source index is what §3.4 rule 5 needs when one person holds several
-- host_* denys that must each clear on their own.
CREATE INDEX work_access_restriction_active_subject
  ON work.access_restriction(org_id, scope, subject_id)
  WHERE state IN ('active', 'reconcile_required');
CREATE INDEX work_access_restriction_active_source
  ON work.access_restriction(org_id, source)
  WHERE state IN ('active', 'reconcile_required');

-- ---------------------------------------------------------------------------
-- Governance command events: cursor, consumed commands, gap proof
-- ---------------------------------------------------------------------------

CREATE TABLE work.governance_event_cursor (
  org_id text PRIMARY KEY,
  last_event_seq bigint NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.governance_event_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.governance_event_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.governance_event_cursor
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- §4.1 makes the one-way advance a database rule. Both writers (continuous
-- consumption and the operator cursor jump) are subject to it, so a replayed or
-- low-watermark pull cannot move the org's position backwards.
CREATE FUNCTION work.governance_event_cursor_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'governance_event_cursor_content_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_event_seq <= OLD.last_event_seq THEN
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001',
      DETAIL = OLD.last_event_seq::text;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER governance_event_cursor_guard BEFORE UPDATE ON work.governance_event_cursor
  FOR EACH ROW EXECUTE FUNCTION work.governance_event_cursor_guard();
CREATE TRIGGER governance_event_cursor_no_delete
  BEFORE DELETE ON work.governance_event_cursor
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

CREATE TABLE work.consumed_governance_command (
  org_id text NOT NULL,
  command_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('seat', 'assignment', 'entitlement')),
  -- §3.1's event carries member_revision only for a seat command (an assignment
  -- command moves permissions_revision, an entitlement command moves org_revision), and
  -- an ExecutionEntitlement.Apply names no person at all: its target is the organization.
  -- Both columns were NOT NULL here, which is a lockout rather than a conservatism - the
  -- puller's first assignment or entitlement event would raise
  -- directory_protocol_invalid, stop the cursor, and leave every seat deny in that
  -- organization permanently unreleasable. They are now nullable and pinned per kind, so
  -- a seat release still cannot be justified by an event that has no member anchor.
  target_subject_id text,
  desired boolean NOT NULL,
  event_seq bigint NOT NULL CHECK (event_seq >= 0),
  member_revision bigint,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, command_id),
  UNIQUE (org_id, event_seq),
  CONSTRAINT consumed_governance_command_kind_shape CHECK (
    (kind = 'seat' AND btrim(COALESCE(target_subject_id, '')) <> ''
       AND member_revision IS NOT NULL)
    OR (kind = 'assignment' AND btrim(COALESCE(target_subject_id, '')) <> ''
       AND member_revision IS NULL)
    OR (kind = 'entitlement' AND target_subject_id IS NULL
       AND member_revision IS NULL)
  ),
  FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.consumed_governance_command ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.consumed_governance_command FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.consumed_governance_command
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Dedup evidence, never a mutable record: §3.1 requires the row to outlive the
-- deny it released, so the release chain stays auditable afterwards.
CREATE TRIGGER consumed_governance_command_no_mutation
  BEFORE UPDATE OR DELETE ON work.consumed_governance_command
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

CREATE TABLE work.governance_gap_report (
  org_id text NOT NULL,
  gap_report_id uuid NOT NULL DEFAULT gen_random_uuid(),
  from_seq bigint NOT NULL CHECK (from_seq >= 0),
  to_seq_exclusive bigint NOT NULL CHECK (to_seq_exclusive > from_seq),
  seat_events jsonb NOT NULL DEFAULT '[]'::jsonb,
  seat_event_count int NOT NULL DEFAULT 0 CHECK (seat_event_count >= 0),
  host_fetch_seq bigint NOT NULL CHECK (host_fetch_seq >= 0),
  attested_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'consumed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, gap_report_id),
  -- The count must be the array it claims to be: this row is the only interval
  -- proof advance_governance_event_cursor may accept, so a count that drifted
  -- from the list is a forged proof.
  CONSTRAINT governance_gap_report_count_shape CHECK (
    seat_event_count = jsonb_array_length(seat_events)
  ),
  FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.governance_gap_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.governance_gap_report FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.governance_gap_report
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.governance_gap_report_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.gap_report_id IS DISTINCT FROM OLD.gap_report_id
     OR NEW.from_seq IS DISTINCT FROM OLD.from_seq
     OR NEW.to_seq_exclusive IS DISTINCT FROM OLD.to_seq_exclusive
     OR NEW.seat_events IS DISTINCT FROM OLD.seat_events
     OR NEW.seat_event_count IS DISTINCT FROM OLD.seat_event_count
     OR NEW.host_fetch_seq IS DISTINCT FROM OLD.host_fetch_seq
     OR NEW.attested_at IS DISTINCT FROM OLD.attested_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'governance_gap_report_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER governance_gap_report_guard BEFORE UPDATE ON work.governance_gap_report
  FOR EACH ROW EXECUTE FUNCTION work.governance_gap_report_guard();
CREATE TRIGGER governance_gap_report_no_delete
  BEFORE DELETE ON work.governance_gap_report
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER governance_gap_report_transition BEFORE UPDATE OF state
  ON work.governance_gap_report
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('governance_gap_report');

CREATE INDEX work_governance_gap_report_pending
  ON work.governance_gap_report(org_id, state) WHERE state = 'pending';

-- ---------------------------------------------------------------------------
-- Governance change saga and cancellation intents
-- ---------------------------------------------------------------------------

CREATE TABLE work.governance_change (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  command_id uuid NOT NULL,
  actor_subject_id text NOT NULL,
  logical_command text NOT NULL,
  client_request_id text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('seat', 'assignment', 'entitlement')),
  target_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  expected_revision bigint NOT NULL,
  host_revision bigint,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied', 'reconcile')),
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  -- §4.1 states this key but listed neither column; a retry-safe saga is
  -- impossible without them, so they land here.
  UNIQUE (org_id, actor_subject_id, logical_command, client_request_id),
  UNIQUE (org_id, command_id),
  FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.governance_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.governance_change FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.governance_change
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE INDEX work_governance_change_pending
  ON work.governance_change(org_id, state) WHERE state <> 'applied';

CREATE FUNCTION work.governance_change_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.actor_subject_id IS DISTINCT FROM OLD.actor_subject_id
     OR NEW.logical_command IS DISTINCT FROM OLD.logical_command
     OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
     OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.expected_revision IS DISTINCT FROM OLD.expected_revision
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'governance_change_content_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'governance_revision_conflict' USING ERRCODE = 'P0001',
      DETAIL = OLD.revision::text;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER governance_change_guard BEFORE UPDATE ON work.governance_change
  FOR EACH ROW EXECUTE FUNCTION work.governance_change_guard();
CREATE TRIGGER governance_change_no_delete BEFORE DELETE ON work.governance_change
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER governance_change_transition BEFORE UPDATE OF state
  ON work.governance_change
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('governance_change');

CREATE TABLE work.cancellation_intent (
  org_id text NOT NULL,
  source_event_id uuid NOT NULL,
  run_id uuid NOT NULL,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  -- §6.1 names the retry ladder and the dead-letter end but not the domain;
  -- these three are the states it describes (waiting, delivered, exhausted).
  state text NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'consumed', 'dead_letter'
  )),
  next_attempt timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, source_event_id, run_id),
  FOREIGN KEY (org_id) REFERENCES work.org(id),
  FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id)
);

ALTER TABLE work.cancellation_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.cancellation_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.cancellation_intent
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE INDEX work_cancellation_intent_due
  ON work.cancellation_intent(org_id, next_attempt) WHERE state = 'pending';

CREATE FUNCTION work.cancellation_intent_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'cancellation_intent_content_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'dead_letter' AND OLD.state = 'consumed' THEN
    RAISE EXCEPTION 'cancellation_intent_terminal_state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cancellation_intent_guard BEFORE UPDATE ON work.cancellation_intent
  FOR EACH ROW EXECUTE FUNCTION work.cancellation_intent_guard();
CREATE TRIGGER cancellation_intent_no_delete
  BEFORE DELETE ON work.cancellation_intent
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER cancellation_intent_transition BEFORE UPDATE OF state
  ON work.cancellation_intent
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('cancellation_intent');

-- ---------------------------------------------------------------------------
-- Grants: none. Every read and write goes through a SECURITY DEFINER command
-- (0019), matching 0011's rule that no running role holds table DML here.
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE work.execution_entitlement FROM PUBLIC;
REVOKE ALL ON TABLE work.execution_entitlement FROM work_api, work_worker,
  work_directory, work_ledger, work_ops;
REVOKE ALL ON TABLE work.access_restriction FROM PUBLIC;
REVOKE ALL ON TABLE work.access_restriction FROM work_api, work_worker,
  work_directory, work_ledger, work_ops;
REVOKE ALL ON TABLE work.governance_event_cursor FROM PUBLIC;
REVOKE ALL ON TABLE work.governance_event_cursor FROM work_api, work_worker,
  work_directory, work_ledger, work_ops;
REVOKE ALL ON TABLE work.consumed_governance_command FROM PUBLIC;
REVOKE ALL ON TABLE work.consumed_governance_command FROM work_api, work_worker,
  work_directory, work_ledger, work_ops;
REVOKE ALL ON TABLE work.governance_gap_report FROM PUBLIC;
REVOKE ALL ON TABLE work.governance_gap_report FROM work_api, work_worker,
  work_directory, work_ledger, work_ops;
REVOKE ALL ON TABLE work.governance_change FROM PUBLIC;
REVOKE ALL ON TABLE work.governance_change FROM work_api, work_worker,
  work_directory, work_ledger, work_ops;
REVOKE ALL ON TABLE work.cancellation_intent FROM PUBLIC;
REVOKE ALL ON TABLE work.cancellation_intent FROM work_api, work_worker,
  work_directory, work_ledger, work_ops;

-- Guard and trigger functions carry no arguments and no legitimate caller outside
-- their own table, yet a function created by an increment inherits the implicit
-- PUBLIC EXECUTE grant (baseline's blanket revoke predates them) - and the catalog
-- cannot show that grant, because aclexplode(NULL) yields no rows. Without these
-- lines work_api can execute SECURITY DEFINER code owned by work_owner.
REVOKE ALL ON FUNCTION work.execution_entitlement_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.access_restriction_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.governance_event_cursor_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.governance_gap_report_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.governance_change_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.cancellation_intent_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.stamp_admission_access_epoch() FROM PUBLIC;

RESET ROLE;
