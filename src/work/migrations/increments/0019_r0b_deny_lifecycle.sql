-- 0019: R0b deny lifecycle - who may create a deny, and the only ways one leaves.
--
-- Authority: control design §3.4 (the source table: every deny records its source
-- and can only be released by that source's own rule, always compared against
-- release_floor_revision), §3.1 (ListGovernanceEvents, the org-local event_seq,
-- "stop at a gap and never guess", the explicit cursor initialization rule and the
-- two-step recovery), §4.2 (release_restriction / consume_governance_events /
-- advance_governance_event_cursor / apply_directory_recovery), §4.3 (the org → member
-- lock direction every projection writer must keep), §6.1 (deny creation must also
-- cover the absence path that bypasses sync_member_projection, and the cutoff epoch
-- that keeps a late hint off a newly admitted Run). Validation exits: EV84, EV85,
-- EV107, EV117.
--
-- Deny creation is a trigger, not a per-caller convention: §6.1 itself names
-- work.mark_members_absent as a projection writer that bypasses
-- sync_member_projection, so "every command should remember to create the deny" is
-- exactly the rule R0a already breaks once. A trigger on the projected rows covers
-- every existing and future writer.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- Gap-attested events are consumed but never releasing
-- ---------------------------------------------------------------------------

-- §3.1 requires the seat events inside a skipped interval to be登记为"已消费不解除".
-- Without a carrier for that distinction the requirement is unimplementable: writing
-- them into consumed_governance_command as ordinary rows would hand release_restriction
-- a release proof for an event that was never actually applied, i.e. skipping a gap
-- would silently lift the very denys the two-step recovery exists to keep closed.
-- So the column is added first and release_restriction below refuses it.
ALTER TABLE work.consumed_governance_command
  ADD COLUMN gap_skipped boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- release_restriction: the only writer that may set state = released
-- ---------------------------------------------------------------------------

-- Seat denys are released only by a consumed command event, projection denys only
-- by a higher projection revision, and governance/policy/device/grant/model denys
-- never: §3.4 rule 2 forbids "resume the org" from silently lifting everything
-- else, and the table's last row keeps a revoked delegation from coming back.
--
-- It answers with a code instead of raising, because its callers enumerate
-- candidates: a seat command that matches no deny is the ordinary case, not an
-- error, and an exception would abort the whole consumption for a non-event.
CREATE FUNCTION work.release_restriction(
  p_org_id text,
  p_restriction_id uuid,
  p_command_id uuid,
  p_observed_revision bigint,
  p_actor_subject_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  restriction_row work.access_restriction%ROWTYPE;
  command_row work.consumed_governance_command%ROWTYPE;
  v_projection_active boolean;
  v_projection_revision bigint;
  release_revision bigint;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RETURN 'org_context_mismatch';
  END IF;
  SELECT * INTO restriction_row
  FROM work.access_restriction
  WHERE org_id = p_org_id AND id = p_restriction_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'restriction_not_releasable';
  END IF;
  IF restriction_row.state = 'released' THEN
    IF p_observed_revision IS NOT NULL
       AND restriction_row.released_by_revision = p_observed_revision THEN
      RETURN 'already_released';
    END IF;
    RETURN 'restriction_not_releasable';
  END IF;
  IF restriction_row.source IN ('governance', 'policy', 'device', 'grant', 'model') THEN
    -- Never released: a newer grant produces a newer revision and this row only
    -- covers the old epoch.
    RETURN 'restriction_not_releasable';
  END IF;

  IF restriction_row.source IN ('host_seat', 'work_seat_change') THEN
    -- The projection cannot distinguish "a new granting command" from "some row
    -- was edited", so only the command event counts (§3.4 rule 6). The comparison
    -- is against release_floor_revision, never host_revision, which is null for
    -- the Work-initiated case and would make every comparison null.
    IF p_command_id IS NULL THEN
      RETURN 'restriction_not_releasable';
    END IF;
    SELECT * INTO command_row
    FROM work.consumed_governance_command
    WHERE org_id = p_org_id AND command_id = p_command_id;
    -- gap_skipped rows are registered only so that a skipped interval is never
    -- replayed (§3.1). They are the record of an event that was *not* applied, so
    -- treating one as release evidence would turn the cursor recovery into the
    -- silent resume §3.4 rule 2 forbids.
    IF NOT FOUND
       OR command_row.gap_skipped
       OR command_row.kind <> 'seat'
       OR NOT command_row.desired
       OR command_row.target_subject_id <> restriction_row.subject_id
       OR command_row.member_revision <= restriction_row.release_floor_revision THEN
      RETURN 'restriction_not_releasable';
    END IF;
    release_revision := command_row.member_revision;
  ELSIF restriction_row.source IN ('host_org', 'host_member') THEN
    -- §3.4 states this release condition as two conjuncts - "同步观察到 status=active"
    -- AND a revision above the floor - so the projected status is part of the predicate
    -- and not a caller's discretion. The sync identity supplies the revision it saw;
    -- the status is a row the database already has, and reading it here is what stops a
    -- caller from lifting a deny for an organization or person the projection still
    -- records as suspended. Under a SECURITY DEFINER body these reads are bound by the
    -- same tenant_isolation policy as every other table, and the org-context check at
    -- the top of this function already fixes which tenant they run against.
    IF restriction_row.scope = 'org' THEN
      SELECT o.status = 'active', o.revision INTO v_projection_active, v_projection_revision
      FROM work.org o WHERE o.id = p_org_id;
    ELSE
      SELECT m.status = 'active', m.revision INTO v_projection_active, v_projection_revision
      FROM work.member m
      WHERE m.org_id = p_org_id AND m.subject_id = restriction_row.subject_id;
    END IF;
    -- `IS NOT TRUE` also covers the missing-row case: a projection that has been
    -- deleted proves nothing about anybody being active again.
    IF v_projection_active IS NOT TRUE THEN
      RETURN 'restriction_not_releasable';
    END IF;
    IF p_observed_revision IS NULL
       OR p_observed_revision > v_projection_revision
       OR p_observed_revision <= restriction_row.release_floor_revision THEN
      -- The upper bound is what makes `released_by_revision` a fact rather than an
      -- input: the caller reports the revision it observed, and a value the projection
      -- does not have would be recorded as release evidence nobody ever saw.
      RETURN 'restriction_not_releasable';
    END IF;
    release_revision := p_observed_revision;
  ELSE
    -- operator denys are released by the operator command, which is not this path.
    RETURN 'restriction_not_releasable';
  END IF;

  UPDATE work.access_restriction
  SET state = 'released',
      released_by_revision = release_revision,
      released_at = now(),
      revision = revision + 1,
      updated_at = now()
  WHERE org_id = p_org_id AND id = p_restriction_id;
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'access_restriction.released',
    'access_restriction', p_restriction_id::text,
    jsonb_build_object(
      'source', restriction_row.source,
      'scope', restriction_row.scope,
      'subject_id', restriction_row.subject_id,
      'release_floor_revision', restriction_row.release_floor_revision,
      'released_by_revision', release_revision,
      'command_id', p_command_id
    )
  );
  RETURN 'released';
END;
$$;

-- No direct grantee: §4.2 says there is no independent API entry, and it only runs
-- inside the definer commands below, as work_owner.
REVOKE ALL ON FUNCTION work.release_restriction(text, uuid, uuid, bigint, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Narrowing records
-- ---------------------------------------------------------------------------
--
-- §6.1 names an "EntitlementNarrowingHint outbox" row, and the first draft of this
-- increment wrote one into work.outbox per deny. That carrier is refused here, for
-- a reason visible only once the two halves are read together: work.outbox has
-- exactly one consumer in production, the relay, and its dispatch ends in
-- `default: return r.fail(ctx, event, "unknown_outbox_kind", false)`
-- (src/work/internal/relay/relay.go:196). A kind the relay does not know is not
-- parked - it is marked failed, non-retryably, so every deny would leave a
-- permanently failed outbox row in the one queue whose failures are alarming, and
-- the real ones would stop standing out. The hint also has no consumer yet: §6.1's
-- worker ("在 Task 锁内复核此谓词") is part of the remaining I2/I4 surface.
--
-- The deny row itself is the narrowing record, so nothing is lost by dropping the
-- duplicate carrier: every field §6.1 and §4.1 line 370 asks of a hint is already a
-- column of work.access_restriction - restriction_id = id, scope, subject_id,
-- source, revision = host_revision, cutoff = epoch, reason. A second ledger with
-- the same seven values is exactly the drift R0a already demonstrates elsewhere.
-- The obligation this defers is a consumer, not a carrier, and it is recorded in
-- work-project.md: whoever builds the narrowing worker reads denies, not outbox.

-- ---------------------------------------------------------------------------
-- Deny creation on the directory projection
-- ---------------------------------------------------------------------------
--
-- Both triggers bump work.org.access_epoch, so both take the org row lock. §4.3
-- fixes the direction of that edge in words: "sync_member_projection 先锁
-- work.member，因此投影写者必须在锁 work.member 之前取 org 上下文，不能从成员锁
-- 反向取 org 锁". A trigger cannot choose the order - the member row is already
-- locked by the statement that fired it - so the order has to be established by the
-- caller, and work.sync_member_with_org_context below is the only sanctioned entry
-- that does it. Without it the new trigger deadlocks against the shipped batch path:
-- mark_members_absent takes the org row first (0008:309-312) and then the members
-- (0008:351-365), while sync_member_projection takes only the member (0002:3925-3928)
-- and would then want the org row from inside this trigger.

CREATE FUNCTION work.record_org_narrowing() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_epoch bigint;
  v_restriction_id uuid := gen_random_uuid();
BEGIN
  -- Only a status change matters. This guard is also what stops the recursion that
  -- the access_epoch bump below would otherwise cause.
  IF OLD.status = NEW.status THEN
    RETURN NULL;
  END IF;
  IF NEW.status <> 'active' THEN
    PERFORM set_config('app.org_id', NEW.id, true);
    UPDATE work.org
    SET access_epoch = access_epoch + 1, updated_at = now()
    WHERE id = NEW.id
    RETURNING access_epoch INTO v_epoch;
    -- The deny stores the epoch it *retires*, not the one it creates. §6.1's
    -- predicate is `admission_access_epoch <= cutoff`, and a Run inserted after
    -- this point is stamped from the bumped value; storing the new value here would
    -- make the cutoff equal to every later admission, so a late hint would cancel
    -- Runs that were admitted after the deny - the one thing the column exists to
    -- prevent. Retiring the previous epoch is also what makes release safe without a
    -- second bump: a re-authorized Run keeps the higher value, and an old Run stays
    -- inside the original cancel scope even after its deny is released.
    INSERT INTO work.access_restriction
      (id, org_id, scope, source, reason, epoch, host_revision, release_floor_revision)
    VALUES
      (v_restriction_id, NEW.id, 'org', 'host_org',
       'organization_' || NEW.status, v_epoch - 1, NEW.revision, NEW.revision);
    PERFORM work.append_audit(
      NEW.id, NULL, 'access_restriction.created', 'access_restriction',
      v_restriction_id::text,
      jsonb_build_object('source', 'host_org', 'scope', 'org',
                         'host_revision', NEW.revision,
                         'cutoff_access_epoch', v_epoch - 1,
                         'access_epoch', v_epoch)
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER org_narrowing_deny AFTER UPDATE OF status ON work.org
  FOR EACH ROW EXECUTE FUNCTION work.record_org_narrowing();

CREATE FUNCTION work.record_member_narrowing() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_epoch bigint;
  v_restriction_id uuid;
  v_source text;
  v_open_change boolean;
BEGIN
  IF OLD.status = NEW.status AND OLD.work_seat = NEW.work_seat THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.org_id', NEW.org_id, true);

  IF OLD.status = 'active' AND NEW.status IN ('suspended', 'left') THEN
    v_restriction_id := gen_random_uuid();
    UPDATE work.org SET access_epoch = access_epoch + 1, updated_at = now()
    WHERE id = NEW.org_id RETURNING access_epoch INTO v_epoch;
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'member', NEW.subject_id, 'host_member',
       'member_' || NEW.status, v_epoch - 1, NEW.revision, NEW.revision);
    PERFORM work.append_audit(
      NEW.org_id, NULL, 'access_restriction.created', 'access_restriction',
      v_restriction_id::text,
      jsonb_build_object('source', 'host_member', 'subject_id', NEW.subject_id,
                         'member_revision', NEW.revision,
                         'cutoff_access_epoch', v_epoch - 1,
                         'access_epoch', v_epoch)
    );
  END IF;

  IF OLD.work_seat AND NOT NEW.work_seat THEN
    -- §3.4 splits the two seat sources: a seat lost while Work has an unfinished
    -- governance change for this person came from Work's own saga step 1, which has
    -- no Host revision to record yet. Everything else is an observed Host seat loss.
    SELECT EXISTS (
      SELECT 1 FROM work.governance_change
      WHERE org_id = NEW.org_id
        AND target_kind = 'seat'
        AND target_id = NEW.subject_id
        AND state <> 'applied'
    ) INTO v_open_change;
    v_source := CASE WHEN v_open_change THEN 'work_seat_change' ELSE 'host_seat' END;
    v_restriction_id := gen_random_uuid();
    UPDATE work.org SET access_epoch = access_epoch + 1, updated_at = now()
    WHERE id = NEW.org_id RETURNING access_epoch INTO v_epoch;
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'member', NEW.subject_id, v_source,
       'work_seat_lost', v_epoch - 1,
       CASE WHEN v_open_change THEN NULL ELSE NEW.revision END,
       -- §3.4: the seat floor is the person's already projected member revision. The
       -- projection row is being updated right now, so it is always available here.
       NEW.revision);
    PERFORM work.append_audit(
      NEW.org_id, NULL, 'access_restriction.created', 'access_restriction',
      v_restriction_id::text,
      jsonb_build_object('source', v_source, 'subject_id', NEW.subject_id,
                         'member_revision', NEW.revision,
                         'cutoff_access_epoch', v_epoch - 1,
                         'access_epoch', v_epoch)
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER member_narrowing_deny AFTER UPDATE ON work.member
  FOR EACH ROW EXECUTE FUNCTION work.record_member_narrowing();

-- The §4.3 wrapper. It adds no privilege: the raw projection command it calls is
-- already the only way work_directory may write a member row. It is security definer
-- for one reason - revoking EXECUTE on sync_member_projection from work_directory
-- below means the wrapper must be able to call it, and an invoker-rights wrapper
-- would then fail for its own caller. Every table in this schema is FORCE-RLS, the
-- owner included (0002:5125-5126), so the definer context is still bound by
-- tenant_isolation; and sync_member_projection's own first check refuses a p_org_id
-- that differs from app.org_id, so the wrapper cannot reach another tenant's rows.
-- Its only content is taking the org row lock first, so the deny trigger never
-- reaches for a lock the transaction does not already hold. The raw projection
-- command is revoked from work_directory because leaving both entries callable means
-- the unsafe one is always available and only review discipline keeps it unused.
CREATE FUNCTION work.sync_member_with_org_context(
  p_org_id text,
  p_subject_id text,
  p_status text,
  p_role text,
  p_work_seat boolean,
  p_revision bigint
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  PERFORM 1 FROM work.org WHERE id = p_org_id FOR UPDATE;
  RETURN work.sync_member_projection(
    p_org_id, p_subject_id, p_status, p_role, p_work_seat, p_revision
  );
END;
$$;

REVOKE ALL ON FUNCTION work.sync_member_with_org_context(
  text, text, text, text, boolean, bigint
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.sync_member_with_org_context(
  text, text, text, text, boolean, bigint
) TO work_directory;
REVOKE EXECUTE ON FUNCTION work.sync_member_projection(
  text, text, text, text, boolean, bigint
) FROM work_directory;

-- ---------------------------------------------------------------------------
-- consume_governance_events
-- ---------------------------------------------------------------------------

-- One definition of what a well-formed gap attestation is, used by both sides of the
-- proof: consume_governance_events refuses to record a report whose list is garbage,
-- and advance_governance_event_cursor refuses to accept one. Duplicating the field
-- list in two places is how a proof ends up validated differently on the way in than
-- on the way out, and only the second difference matters.
--
-- Every key goes through COALESCE: `NULL !~ pattern` is NULL, and NOT EXISTS reads a
-- NULL as "no problem", so a bare IS NULL check would let an element missing
-- event_seq pass as well-formed.
CREATE FUNCTION work.governance_seat_events_valid(
  p_seat_events jsonb,
  p_from_seq bigint,
  p_to_seq_exclusive bigint
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = work, pg_catalog
AS $$
  SELECT p_seat_events IS NOT NULL
     AND jsonb_typeof(p_seat_events) = 'array'
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_seat_events) AS se
       WHERE jsonb_typeof(se) <> 'object'
          OR COALESCE(se ->> 'event_seq', '') !~ '^[0-9]+$'
          OR (se ->> 'event_seq')::bigint < p_from_seq
          OR (se ->> 'event_seq')::bigint >= p_to_seq_exclusive
          OR COALESCE(se ->> 'command_id', '')
             !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          OR COALESCE(se ->> 'kind', '') <> 'seat'
          OR COALESCE(se ->> 'desired', '') NOT IN ('true', 'false')
          OR COALESCE(se ->> 'target_subject_id', '') = ''
          OR COALESCE(se ->> 'member_revision', '') !~ '^[0-9]+$'
          OR COALESCE(se ->> 'payload_hash', '') !~ '^sha256:[0-9a-f]{64}$'
          -- Anchored at both ends, not a prefix test: advance registers these values
          -- with a direct ::timestamptz cast, and an unanchored pattern would let
          -- "2026-11-01 whatever" through the proof and abort the whole advance on the
          -- cast instead of refusing the proof.
          OR COALESCE(se ->> 'applied_at', '')
             !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$'
     )
     -- A list in which two elements claim one position, or one command claims two
     -- positions, is not an enumeration of an interval; it is a description of
     -- whatever the caller wanted to be able to cite later. The target table's own
     -- UNIQUE (org_id, event_seq) and PRIMARY KEY (org_id, command_id) would refuse
     -- it on insert, but only after the report has already been accepted.
     AND (SELECT count(*) FROM jsonb_array_elements(p_seat_events) e)
         = (SELECT count(DISTINCT e ->> 'event_seq')
            FROM jsonb_array_elements(p_seat_events) e)
     AND (SELECT count(*) FROM jsonb_array_elements(p_seat_events) e)
         = (SELECT count(DISTINCT lower(e ->> 'command_id'))
            FROM jsonb_array_elements(p_seat_events) e)
$$;

REVOKE ALL ON FUNCTION work.governance_seat_events_valid(jsonb, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.governance_seat_events_valid(jsonb, bigint, bigint)
  TO work_governance_events, work_api;

-- The puller identity may write exactly this, the consumed table and seat deny
-- releases: not the projections, not a seat, not any business row (§3.1).
--
-- A missing cursor row is initialized here rather than by an out-of-band write,
-- because §3.1 fixes the start position at the Host's current maximum event_seq:
-- history from before the identity was enabled is deliberately never discovered, so
-- an older granting action cannot be back-filled into a release. The puller must
-- therefore hand over that maximum explicitly.
--
-- A sequence gap is recorded and consumption stops, and it must not RAISE: the gap
-- report is the only interval proof the operator may later cite, and aborting the
-- transaction would erase the evidence the rule exists to produce. The outcome
-- comes back as a value for the puller to alert on.
CREATE FUNCTION work.consume_governance_events(
  p_org_id text,
  p_events jsonb,
  p_gap_attestation jsonb DEFAULT NULL,
  p_initialize_from bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  cursor_row work.governance_event_cursor%ROWTYPE;
  event_row record;
  v_env jsonb;
  v_last_seq bigint;
  v_expected_seq bigint;
  v_event_seq bigint;
  v_command_id uuid;
  v_kind text;
  v_desired boolean;
  v_subject text;
  v_member_revision bigint;
  v_payload_hash text;
  v_applied_at timestamptz;
  v_gap_report_id uuid := gen_random_uuid();
  v_consumed int := 0;
  v_released int := 0;
  v_released_code text;
  restriction_row work.access_restriction%ROWTYPE;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO cursor_row FROM work.governance_event_cursor
  WHERE org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_initialize_from IS NULL OR p_initialize_from < 0 THEN
      RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
    END IF;
    INSERT INTO work.governance_event_cursor (org_id, last_event_seq)
    VALUES (p_org_id, p_initialize_from);
    cursor_row.org_id := p_org_id;
    cursor_row.last_event_seq := p_initialize_from;
  END IF;
  v_last_seq := cursor_row.last_event_seq;
  v_expected_seq := v_last_seq + 1;

  FOR event_row IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    v_env := event_row.value;
    BEGIN
      v_event_seq := (v_env ->> 'event_seq')::bigint;
      v_command_id := (v_env ->> 'command_id')::uuid;
      v_desired := (v_env ->> 'desired')::boolean;
      v_member_revision := (v_env ->> 'member_revision')::bigint;
      v_applied_at := (v_env ->> 'applied_at')::timestamptz;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
    END;
    v_kind := v_env ->> 'kind';
    v_subject := v_env ->> 'target_subject_id';
    v_payload_hash := v_env ->> 'payload_hash';
    IF v_event_seq IS NULL OR v_command_id IS NULL OR v_desired IS NULL
       OR v_applied_at IS NULL
       OR v_kind NOT IN ('seat', 'assignment', 'entitlement')
       OR COALESCE(v_payload_hash, '') !~ '^sha256:[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
    END IF;
    -- §3.1's response carries member_revision only for a seat command, and an
    -- entitlement command names no person. These are checked here rather than left to the
    -- table's kind CHECK because a constraint violation would surface as
    -- invalid_request (SQLSTATE 23514) after the whole batch is already aborted: a Host
    -- that simply describes its own assignment event correctly must never be able to stop
    -- this organization's cursor, and if it truly sends a malformed envelope the answer has
    -- to be the protocol code.
    IF v_kind = 'seat' THEN
      IF COALESCE(btrim(v_subject), '') = '' OR v_member_revision IS NULL THEN
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
    ELSIF v_kind = 'assignment' THEN
      IF COALESCE(btrim(v_subject), '') = '' OR v_member_revision IS NOT NULL THEN
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
    ELSE
      IF v_subject IS NOT NULL OR v_member_revision IS NOT NULL THEN
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
    END IF;

    IF v_event_seq <> v_expected_seq THEN
      IF v_event_seq < v_expected_seq THEN
        -- Re-delivering a position already consumed is a retry, not a violation.
        IF EXISTS (SELECT 1 FROM work.consumed_governance_command
                   WHERE org_id = p_org_id AND event_seq = v_event_seq) THEN
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
      -- Skipping forward is the gap. Host's own enumeration of the missing
      -- interval must be supplied and must match the interval exactly; without that
      -- proof nothing is recorded and the cursor stays put.
      IF p_gap_attestation IS NULL
         OR COALESCE(p_gap_attestation ->> 'from_seq', '') !~ '^[0-9]+$'
         OR COALESCE(p_gap_attestation ->> 'to_seq_exclusive', '') !~ '^[0-9]+$'
         OR (p_gap_attestation ->> 'from_seq')::bigint <> v_expected_seq
         OR (p_gap_attestation ->> 'to_seq_exclusive')::bigint <> v_event_seq
         OR NOT work.governance_seat_events_valid(
              p_gap_attestation -> 'seat_events', v_expected_seq, v_event_seq) THEN
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
      INSERT INTO work.governance_gap_report
        (org_id, gap_report_id, from_seq, to_seq_exclusive, seat_events,
         seat_event_count, host_fetch_seq)
      VALUES
        (p_org_id, v_gap_report_id, v_expected_seq, v_event_seq,
         p_gap_attestation -> 'seat_events',
         jsonb_array_length(p_gap_attestation -> 'seat_events'), v_event_seq);
      PERFORM work.append_audit(
        p_org_id, NULL, 'governance_gap_detected', 'governance_event_cursor', p_org_id,
        jsonb_build_object('gap_report_id', v_gap_report_id,
                           'from_seq', v_expected_seq,
                           'to_seq_exclusive', v_event_seq)
      );
      RETURN jsonb_build_object(
        'consumed', v_consumed, 'released', v_released,
        'last_event_seq', v_last_seq,
        'gap_report_id', v_gap_report_id,
        'from_seq', v_expected_seq, 'to_seq_exclusive', v_event_seq
      );
    END IF;

    IF EXISTS (SELECT 1 FROM work.consumed_governance_command
               WHERE org_id = p_org_id AND command_id = v_command_id) THEN
      -- One command cannot occupy two positions; the same command at the same
      -- position is the ordinary retry and changes nothing.
      IF NOT EXISTS (SELECT 1 FROM work.consumed_governance_command
                     WHERE org_id = p_org_id AND event_seq = v_event_seq) THEN
        RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
      END IF;
      v_expected_seq := v_event_seq + 1;
      CONTINUE;
    END IF;

    INSERT INTO work.consumed_governance_command
      (org_id, command_id, kind, target_subject_id, desired, event_seq,
       member_revision, payload_hash, applied_at)
    VALUES
      (p_org_id, v_command_id, v_kind, v_subject, v_desired, v_event_seq,
       v_member_revision, v_payload_hash, v_applied_at);

    IF v_kind = 'seat' AND v_desired THEN
      -- Seat denys only, and only this person's (§3.4 rule 6). Projection and
      -- operator denys stay exactly where they are.
      FOR restriction_row IN
        SELECT id FROM work.access_restriction
        WHERE org_id = p_org_id
          AND source IN ('host_seat', 'work_seat_change')
          AND subject_id = v_subject
          AND state IN ('active', 'reconcile_required')
        ORDER BY id
      LOOP
        v_released_code := work.release_restriction(
          p_org_id, restriction_row.id, v_command_id, NULL, 'work_governance_events'
        );
        IF v_released_code IN ('released', 'already_released') THEN
          v_released := v_released + 1;
        END IF;
      END LOOP;
    END IF;

    v_consumed := v_consumed + 1;
    v_expected_seq := v_event_seq + 1;
    v_last_seq := v_event_seq;
    UPDATE work.governance_event_cursor
    SET last_event_seq = v_event_seq, updated_at = now()
    WHERE org_id = p_org_id;
  END LOOP;

  PERFORM work.append_audit(
    p_org_id, NULL, 'governance_events.consumed', 'governance_event_cursor', p_org_id,
    jsonb_build_object('consumed', v_consumed, 'released', v_released,
                       'last_event_seq', v_last_seq)
  );
  RETURN jsonb_build_object('consumed', v_consumed, 'released', v_released,
                            'last_event_seq', v_last_seq);
END;
$$;

REVOKE ALL ON FUNCTION work.consume_governance_events(text, jsonb, jsonb, bigint) FROM PUBLIC;
-- Schema usage is part of the identity grant, not the login provisioning: without
-- it the puller authenticates and then cannot resolve anything in the schema.
GRANT USAGE ON SCHEMA work TO work_governance_events;
GRANT EXECUTE ON FUNCTION work.consume_governance_events(text, jsonb, jsonb, bigint)
  TO work_governance_events;

-- ---------------------------------------------------------------------------
-- advance_governance_event_cursor
-- ---------------------------------------------------------------------------

-- Two steps, in this order, never collapsed into one (§3.1 / J7): jump the cursor
-- over a Host-proven interval and mark the affected denys reconcile_required, then
-- have someone holding org.work.seat.write re-grant explicitly. This command
-- releases nothing and never touches a projection.
--
-- Idempotency reads the audit row as the receipt rather than adding a second
-- ledger: a retry with the same request id returns the recorded result instead of
-- skipping a second interval.
CREATE FUNCTION work.advance_governance_event_cursor(
  p_org_id text,
  p_to_seq bigint,
  p_gap_report_id uuid,
  p_ticket_id text,
  p_actor_subject_id text,
  p_request_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  cursor_row work.governance_event_cursor%ROWTYPE;
  report_row work.governance_gap_report%ROWTYPE;
  v_prior jsonb;
  v_affected int := 0;
  v_result jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  -- §1.4 registers this command behind POST /admin/governance-event-cursor and names
  -- `org.work.seat.write` as its permission. That code belongs to Host's permission
  -- registry (I1) and does not exist yet, so the gate here is the server-side fact R0a
  -- already has - an active owner/admin of this organization, with the actor bound to
  -- the session subject. It is deliberately the interim reading and not the final one:
  -- org admin is wider than seat.write, and tightening it is part of I1's landing, not
  -- something to discover later. What must never happen is shipping the endpoint on
  -- top of a command that only checks the org context, because then every active member
  -- of the organization could jump the cursor over a gap they have not verified.
  PERFORM work.assert_org_admin(p_org_id, p_actor_subject_id);
  -- The ticket is the external visibility requirement under a one-person
  -- operations model: it must be cited, and it may not be invented on the spot.
  IF COALESCE(btrim(p_ticket_id), '') = '' OR COALESCE(btrim(p_request_id), '') = '' THEN
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  SELECT metadata -> 'result' INTO v_prior
  FROM work.audit_event
  WHERE org_id = p_org_id
    AND action = 'governance_gap_skipped'
    AND metadata ->> 'request_id' = p_request_id;
  IF v_prior IS NOT NULL THEN
    RETURN v_prior;
  END IF;

  SELECT * INTO cursor_row FROM work.governance_event_cursor
  WHERE org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO report_row FROM work.governance_gap_report
  WHERE org_id = p_org_id AND gap_report_id = p_gap_report_id FOR UPDATE;
  IF NOT FOUND
     OR report_row.state <> 'pending'
     OR report_row.from_seq <> cursor_row.last_event_seq + 1
     OR report_row.to_seq_exclusive <> p_to_seq
     OR p_to_seq <= cursor_row.last_event_seq THEN
    -- Either this is not the interval the cursor is actually missing, or the report
    -- has already been consumed by an earlier advance: one report, one jump.
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  -- The proof is checked again here rather than trusted because it is already on
  -- disk: §4.2 makes *this* command the one that must refuse an incomplete or
  -- inconsistent enumeration, and a report written before these rules existed would
  -- otherwise be accepted on the strength of having been written at all.
  IF NOT work.governance_seat_events_valid(
         report_row.seat_events, report_row.from_seq, report_row.to_seq_exclusive) THEN
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001';
  END IF;
  -- An event that was already consumed cannot also lie inside the interval being
  -- skipped as never applied. One of the two statements is false, so neither the
  -- cursor move nor the registration below may proceed.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(report_row.seat_events) AS se
    JOIN work.consumed_governance_command c
      ON c.org_id = p_org_id
     AND (c.command_id = lower((se ->> 'command_id'))::uuid
          OR c.event_seq = (se ->> 'event_seq')::bigint)
  ) THEN
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  -- §3.1: "seat_events 已全部登记为已消费不解除". Registering them is what makes the
  -- interval unreplayable; gap_skipped is what makes them useless as release
  -- evidence, which release_restriction now refuses on sight.
  INSERT INTO work.consumed_governance_command
    (org_id, command_id, kind, target_subject_id, desired, event_seq,
     member_revision, payload_hash, applied_at, gap_skipped)
  SELECT p_org_id, lower(se ->> 'command_id')::uuid, 'seat',
         se ->> 'target_subject_id', (se ->> 'desired')::boolean,
         (se ->> 'event_seq')::bigint, (se ->> 'member_revision')::bigint,
         se ->> 'payload_hash', (se ->> 'applied_at')::timestamptz, true
  FROM jsonb_array_elements(report_row.seat_events) AS se;

  -- "Affected" is a seat-class deny that some event in this very interval could have
  -- released: same person, desired grant, and that event's member_revision above the
  -- deny's release floor. §4.1 ④ words this as "floor 落在被跳过区间内", which cannot
  -- be taken literally - the floor is a member revision while the interval is counted
  -- in event_seq, two independent sequences, and comparing them is what made the old
  -- predicate mark every active deny in the org on any gap. The registered event list
  -- is the only carrier of both coordinates, so the comparison is per event, and it
  -- is bounded to this report's interval so an earlier gap cannot re-mark a deny that
  -- has since been released and re-denied.
  UPDATE work.access_restriction r
  SET state = 'reconcile_required', revision = revision + 1, updated_at = now()
  WHERE r.org_id = p_org_id
    AND r.state = 'active'
    AND r.source IN ('host_seat', 'work_seat_change')
    AND EXISTS (
      SELECT 1 FROM work.consumed_governance_command c
      WHERE c.org_id = p_org_id
        AND c.gap_skipped
        AND c.kind = 'seat'
        AND c.desired
        AND c.event_seq >= report_row.from_seq
        AND c.event_seq < report_row.to_seq_exclusive
        AND c.target_subject_id = r.subject_id
        AND c.member_revision > r.release_floor_revision
    );
  GET DIAGNOSTICS v_affected = ROW_COUNT;

  UPDATE work.governance_gap_report
  SET state = 'consumed', updated_at = now()
  WHERE org_id = p_org_id AND gap_report_id = p_gap_report_id;

  UPDATE work.governance_event_cursor
  SET last_event_seq = p_to_seq, updated_at = now()
  WHERE org_id = p_org_id;

  v_result := jsonb_build_object(
    'org_id', p_org_id,
    'last_event_seq', p_to_seq,
    'gap_report_id', p_gap_report_id
  );
  -- The counts are not part of the closed GovernanceChange response shape; they
  -- live in this audit row and in the report row, which is where §1.4 sends anyone
  -- who needs to see them.
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'governance_gap_skipped', 'governance_event_cursor',
    p_org_id,
    jsonb_build_object(
      'request_id', p_request_id,
      'ticket_id', p_ticket_id,
      'gap_report_id', p_gap_report_id,
      'from_seq', report_row.from_seq,
      'to_seq_exclusive', report_row.to_seq_exclusive,
      'seat_event_count', report_row.seat_event_count,
      'reconcile_required', v_affected,
      'result', v_result
    )
  );
  RETURN v_result;
END;
$$;

CREATE INDEX work_audit_event_gap_skip_request
  ON work.audit_event (org_id, ((metadata ->> 'request_id')))
  WHERE action = 'governance_gap_skipped';

REVOKE ALL ON FUNCTION work.advance_governance_event_cursor(
  text, bigint, uuid, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.advance_governance_event_cursor(
  text, bigint, uuid, text, text, text
) TO work_api;

-- ---------------------------------------------------------------------------
-- apply_directory_recovery
-- ---------------------------------------------------------------------------

-- host_org and host_member only, called by the sync writer in the same transaction
-- as the projection update (§3.4 rule 6). It never releases a seat deny (that is
-- the command-event path), never creates a grant, and never revives a Run.
CREATE FUNCTION work.apply_directory_recovery(
  p_org_id text,
  p_subject_id text,
  p_observed_revision bigint,
  p_actor_subject_id text
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  restriction_row record;
  v_released int := 0;
  v_code text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  FOR restriction_row IN
    SELECT id FROM work.access_restriction
    WHERE org_id = p_org_id
      AND state IN ('active', 'reconcile_required')
      AND source IN ('host_org', 'host_member')
      AND (p_subject_id IS NULL
           OR (source = 'host_member' AND subject_id = p_subject_id))
      AND NOT (p_subject_id IS NULL AND source = 'host_member')
    ORDER BY id
  LOOP
    v_code := work.release_restriction(
      p_org_id, restriction_row.id, NULL, p_observed_revision, p_actor_subject_id
    );
    IF v_code IN ('released', 'already_released') THEN
      v_released := v_released + 1;
    END IF;
  END LOOP;
  RETURN v_released;
END;
$$;

REVOKE ALL ON FUNCTION work.apply_directory_recovery(text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.apply_directory_recovery(text, text, bigint, text)
  TO work_directory;

-- Both deny writers are SECURITY DEFINER with no argument: callable by any role
-- unless revoked explicitly (see the same note in 0017 and 0018).
REVOKE ALL ON FUNCTION work.record_org_narrowing() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.record_member_narrowing() FROM PUBLIC;

RESET ROLE;
