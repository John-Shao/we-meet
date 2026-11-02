-- 0027: bind the governance receipts to the command that produced them.
--
-- Authority: control design §3.1 and §3.3 make the audit row itself the receipt for a
-- retried governance command ("one request, one result"), and EV106 already fixes what
-- that has to mean when the bodies differ - 幂等重放返回原结果、异 payload 409.
-- 0005:48 is the in-repo implementation of the same rule for submissions, comparing a
-- stored request_hash and raising idempotency_key_conflict. 0019 and 0023 built the
-- replay half and left the comparison out, so a reused request id was answered with a
-- success belonging to a different command. Found by the round-22 code audit.
--
-- Three defects, and they are separate:
--   1. neither receipt records what it was a receipt for, so the same key with a
--      different body returns the earlier result and performs nothing (both fixed);
--   2. advance_governance_event_cursor reads its receipt before it locks the cursor, so
--      two concurrent retries both see an empty receipt (lock moves first);
--   3. consume_governance_events initializes the cursor with a bare INSERT after a FOR
--      UPDATE that locked no row, so the second concurrent first call died on 23505 and
--      surfaced as 503 service_degraded (ON CONFLICT DO NOTHING, then re-lock).
--
-- The gap-skip receipt index becomes UNIQUE to match 0023's, whose comment already
-- states the requirement; without it the payload binding is the only thing standing
-- between a retried request id and two receipts for one decision.
--
-- 0019 and 0023 are published, so their bodies are replaced here rather than edited
-- there: manifest.json pins the published checksums, and rewriting them would make every
-- already-applied database disagree with its own ledger row. Each replacement restates
-- SECURITY DEFINER and the fixed search_path, because CREATE OR REPLACE inherits neither.
--
-- Deliberately not touched, and registered instead of silently changed: the
-- ack_recorded branch's bulk release in 0023 (§3.3 asks whether `released` stays a
-- single-writer fact - open decision), and effective_epoch in 0020, which is written and
-- audited but still has no reader, so a narrowed policy cancels nothing until §6.1's
-- worker lands.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- consume_governance_events
-- ---------------------------------------------------------------------------

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
CREATE OR REPLACE FUNCTION work.consume_governance_events(
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
    -- FOR UPDATE across a row that does not exist yet locks nothing, so two first
    -- calls for the same organization both land here and the second died on the
    -- primary key with 23505. That SQLSTATE is none of the four FromDB falls back
    -- on, so a pull that had in fact succeeded on the other connection surfaced as
    -- 503 service_degraded. Insert-if-absent and then take the lock for real:
    -- ON CONFLICT waits for the racing inserter to resolve, and the re-read finds
    -- the committed row. This is the shape 0023 uses for work.execution_entitlement.
    INSERT INTO work.governance_event_cursor (org_id, last_event_seq)
    VALUES (p_org_id, p_initialize_from)
    ON CONFLICT (org_id) DO NOTHING;
    SELECT * INTO cursor_row FROM work.governance_event_cursor
    WHERE org_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'directory_protocol_invalid' USING ERRCODE = '22023';
    END IF;
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


-- ---------------------------------------------------------------------------
-- advance_governance_event_cursor
-- ---------------------------------------------------------------------------

-- Two steps, in this order, never collapsed into one (§3.1 / J7): jump the cursor
-- over a Host-proven interval and mark the affected denys reconcile_required, then
-- have someone holding org.work.seat.write re-grant explicitly. This command
-- releases nothing and never touches a projection.
--
-- Idempotency reads the audit row as the receipt rather than adding a second
-- ledger: a retry with the same request id and the same body returns the recorded
-- result instead of skipping a second interval, and a retry with the same id but a
-- different body is refused rather than answered with somebody else's success.
CREATE OR REPLACE FUNCTION work.advance_governance_event_cursor(
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
  v_prior_hash text;
  v_request_hash text;
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

  v_request_hash := work.sha256_text(jsonb_build_object(
    'actor_subject_id', p_actor_subject_id,
    'to_seq', p_to_seq,
    'gap_report_id', p_gap_report_id,
    'ticket_id', p_ticket_id
  )::text);

  -- The cursor row is locked before the receipt is read. Read first, as 0019 did, and
  -- two concurrent retries both find an empty receipt and both continue; the report's
  -- own state gate then rejects the loser with cursor_advance_not_allowed for what was
  -- really a replay, and once the unique receipt index below exists it would be a 23505
  -- instead. Same rule as apply_execution_entitlement, which locks the org row first.
  SELECT * INTO cursor_row FROM work.governance_event_cursor
  WHERE org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cursor_advance_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  SELECT metadata -> 'result', metadata ->> 'request_hash'
    INTO v_prior, v_prior_hash
  FROM work.audit_event
  WHERE org_id = p_org_id
    AND action = 'governance_gap_skipped'
    AND metadata ->> 'request_id' = p_request_id;
  IF v_prior IS NOT NULL THEN
    -- The receipt is keyed by request id alone. Without this comparison, reusing an id
    -- for a different jump - another interval, another report, another ticket, another
    -- actor - returns the earlier success and the second command silently does nothing,
    -- which is the wrong-success class EV106 names for SeedWorkMemberState and 0005:48
    -- already settles for submissions: same key and same body replays, same key and a
    -- different body is idempotency_key_conflict. A receipt written before this
    -- increment carries no hash, so its body cannot be proven identical and lands in
    -- the same branch; nothing real is affected, because the published chain has never
    -- been applied past 0016.
    IF v_prior_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_prior;
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
      'request_hash', v_request_hash,
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


-- The receipt has to stay findable by request id, and unique so a retried request cannot
-- produce two receipts for one decision - 0023:501 created its counterpart this way. The
-- swap is done in one transaction: if a database already holds two receipts for one key,
-- this increment fails instead of quietly keeping a non-unique index.
DROP INDEX work.work_audit_event_gap_skip_request;
CREATE UNIQUE INDEX work_audit_event_gap_skip_request
  ON work.audit_event (org_id, ((metadata ->> 'request_id')))
  WHERE action = 'governance_gap_skipped';

-- ---------------------------------------------------------------------------
-- apply_execution_entitlement
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION work.apply_execution_entitlement(
  p_org_id text,
  p_actor_subject_id text,
  p_operator_authorization_ref text,
  p_enabled boolean,
  p_operator_suspended boolean,
  p_seat_limit bigint,
  p_target_entitlement_revision bigint,
  p_host_ack_revision bigint,
  p_client_request_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_epoch bigint;
  ent_row work.execution_entitlement%ROWTYPE;
  v_prior jsonb;
  v_prior_hash text;
  v_request_hash text;
  v_reason text;
  v_desired boolean;
  v_ack_only boolean := false;
  v_denied boolean;
  v_restriction_id uuid;
  v_intents bigint := 0;
  v_released bigint := 0;
  v_execution_enabled boolean;
  v_operator_suspended boolean;
  v_outcome text;
  v_result jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  -- The operator is not an organization admin, so assert_org_admin would be the wrong
  -- door: it would let any org admin suspend service, which §3.3 reserves for a provider
  -- identity acting on a ticket. What is enforced here is three things: the session
  -- binding (the actor cannot be a string the caller invented), a non-blank authorization
  -- reference, and EXECUTE limited to the dedicated work_operator role.
  PERFORM work.assert_session_subject(p_actor_subject_id);
  IF COALESCE(btrim(p_operator_authorization_ref), '') = '' THEN
    RAISE EXCEPTION 'invalid_request:operator_authorization_ref' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(btrim(p_client_request_id), '') = '' THEN
    RAISE EXCEPTION 'invalid_request:client_request_id' USING ERRCODE = '22023';
  END IF;
  IF p_enabled IS NULL OR p_operator_suspended IS NULL
     OR p_target_entitlement_revision IS NULL OR p_target_entitlement_revision < 0
     OR (p_seat_limit IS NOT NULL AND p_seat_limit < 0)
     OR (p_host_ack_revision IS NOT NULL
         AND p_host_ack_revision <> p_target_entitlement_revision) THEN
    RAISE EXCEPTION 'invalid_request:entitlement' USING ERRCODE = '22023';
  END IF;

  -- §4.3: org row first, then the entitlement row, then restrictions, then Runs. Taking
  -- the org lock here is also what makes the epoch bump below an extension of a lock this
  -- transaction already holds rather than a new reverse edge.
  PERFORM 1 FROM work.org WHERE id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO work.execution_entitlement
    (org_id, enabled, seat_limit, operator_suspended, revision, updated_at)
  VALUES (p_org_id, false, NULL, false, 0, now())
  ON CONFLICT (org_id) DO NOTHING;
  SELECT * INTO ent_row FROM work.execution_entitlement WHERE org_id = p_org_id FOR UPDATE;

  -- One request, one result (§3.3: a timeout re-reads the original command instead of
  -- guessing whether the first attempt landed). The receipt is the audit row itself, so
  -- this adds no second ledger - same carrier as 0019's gap-skip receipt.
  v_request_hash := work.sha256_text(jsonb_build_object(
    'actor_subject_id', p_actor_subject_id,
    'authorization_ref', p_operator_authorization_ref,
    'enabled', p_enabled,
    'operator_suspended', p_operator_suspended,
    'seat_limit', p_seat_limit,
    'target_entitlement_revision', p_target_entitlement_revision,
    'host_ack_revision', p_host_ack_revision
  )::text);

  SELECT metadata -> 'result', metadata ->> 'request_hash'
    INTO v_prior, v_prior_hash
  FROM work.audit_event
  WHERE org_id = p_org_id
    AND action = 'execution_entitlement.applied'
    AND metadata ->> 'client_request_id' = p_client_request_id;
  IF FOUND THEN
    -- One half of the receipt rule was implemented here and the other was not: the
    -- org row lock above keeps concurrent retries honest, but a reused request id
    -- carrying a different decision - a different seat limit, a different target
    -- revision, a different ticket - was answered with the earlier result, so the
    -- operator saw "applied" for a command the database never ran. See 0005:48.
    IF v_prior_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_prior;
  END IF;

  v_desired := p_enabled AND NOT p_operator_suspended;

  IF p_target_entitlement_revision < ent_row.revision
     OR (ent_row.revision > 0
         AND p_target_entitlement_revision > ent_row.revision
         AND ent_row.host_ack_revision IS DISTINCT FROM ent_row.revision) THEN
    -- Either a stale command, or P5: an earlier operator change is still waiting for its
    -- Host acknowledgement and a second Apply must not race it.
    RAISE EXCEPTION 'governance_revision_conflict' USING ERRCODE = 'P0001';
  END IF;

  IF p_target_entitlement_revision = ent_row.revision THEN
    -- Only an acknowledgement may arrive for a revision already recorded, and it cannot
    -- restate the payload while it is at it.
    IF p_host_ack_revision IS NULL
       OR p_enabled IS DISTINCT FROM ent_row.enabled
       OR p_operator_suspended IS DISTINCT FROM ent_row.operator_suspended
       OR p_seat_limit IS DISTINCT FROM ent_row.seat_limit THEN
      RAISE EXCEPTION 'governance_revision_conflict' USING ERRCODE = 'P0001';
    END IF;
    v_ack_only := true;
  ELSIF p_host_ack_revision IS NOT NULL THEN
    -- An acknowledgement cannot describe a revision that has not been recorded yet: that
    -- would be the caller asserting the Host's answer.
    RAISE EXCEPTION 'invalid_request:host_ack_revision' USING ERRCODE = '22023';
  END IF;

  UPDATE work.execution_entitlement
  SET enabled = p_enabled,
      seat_limit = p_seat_limit,
      operator_suspended = p_operator_suspended,
      revision = p_target_entitlement_revision,
      host_ack_revision = COALESCE(p_host_ack_revision, host_ack_revision),
      updated_at = now()
  WHERE org_id = p_org_id;

  IF NOT v_desired THEN
    -- P2's first half: the Work-side restriction lands before any Host call. Re-stating
    -- an already-active suspension moves the flags but does not build a second deny or a
    -- second queue of intents - the epoch must move exactly once per narrowing, or the
    -- cutoff stops meaning "the epoch this restriction retired".
    v_reason := CASE WHEN p_operator_suspended THEN 'operator_suspended'
                     ELSE 'entitlement_disabled' END;
    SELECT EXISTS (
      SELECT 1 FROM work.access_restriction
      WHERE org_id = p_org_id
        AND source = 'operator'
        AND state IN ('active', 'reconcile_required')
    ) INTO v_denied;

    UPDATE work.org
    SET execution_enabled = false,
        operator_suspended = p_operator_suspended,
        updated_at = now()
    WHERE id = p_org_id;

    IF NOT v_denied THEN
      UPDATE work.org
      SET access_epoch = access_epoch + 1
      WHERE id = p_org_id
      RETURNING access_epoch INTO v_epoch;
      v_restriction_id := gen_random_uuid();
      INSERT INTO work.access_restriction
        (id, org_id, scope, source, reason, epoch, host_revision,
         release_floor_revision)
      VALUES
        (v_restriction_id, p_org_id, 'org', 'operator', v_reason, v_epoch - 1, NULL,
         p_target_entitlement_revision);
      v_intents := work.queue_run_cancellations(
        p_org_id, v_restriction_id, v_epoch - 1, v_reason, NULL);
      PERFORM work.append_audit(
        p_org_id, p_actor_subject_id, 'access_restriction.created',
        'access_restriction', v_restriction_id::text,
        jsonb_build_object('source', 'operator', 'scope', 'org', 'reason', v_reason,
                           'cutoff_access_epoch', v_epoch - 1,
                           'access_epoch', v_epoch,
                           'entitlement_revision', p_target_entitlement_revision,
                           'operator_authorization_ref', p_operator_authorization_ref,
                           'cancellation_intents', v_intents)
      );
    END IF;
    v_outcome := CASE WHEN v_denied THEN 'already_suspended' ELSE 'suspended' END;
  ELSIF v_ack_only THEN
    -- The acknowledgement is what a restoration has been waiting for. Only
    -- `source = 'operator'` rows are touched: P6 is explicit that restoring service does
    -- not release a host_org, host_member, seat or policy deny. `release_restriction`
    -- keeps refusing those here (0019:142-144) because the fact that opens an operator
    -- deny - host_ack_revision on the entitlement row - is not one of its arguments.
    UPDATE work.org
    SET execution_enabled = true,
        operator_suspended = false,
        updated_at = now()
    WHERE id = p_org_id;
    UPDATE work.access_restriction
    SET state = 'released',
        released_by_revision = p_target_entitlement_revision,
        released_at = now(),
        revision = revision + 1,
        updated_at = now()
    WHERE org_id = p_org_id
      AND source = 'operator'
      AND state IN ('active', 'reconcile_required')
      AND release_floor_revision < p_target_entitlement_revision;
    GET DIAGNOSTICS v_released = ROW_COUNT;
    IF v_released > 0 THEN
      PERFORM work.append_audit(
        p_org_id, p_actor_subject_id, 'access_restriction.released',
        'access_restriction', p_org_id,
        jsonb_build_object('source', 'operator',
                           'released_count', v_released,
                           'released_by_revision', p_target_entitlement_revision,
                           'operator_authorization_ref', p_operator_authorization_ref)
      );
    END IF;
    v_outcome := CASE WHEN v_released > 0 THEN 'restored' ELSE 'ack_recorded' END;
  ELSE
    -- A new command that loosens the state: recorded, but the effective change waits for
    -- the Host acknowledgement, so the mirror and the deny stay exactly as they are.
    -- §3.3 calls this "pending 直至 Host 确认"; it is visible as
    -- host_ack_revision IS DISTINCT FROM revision, which is also what P5 reads.
    v_outcome := 'pending_ack';
  END IF;

  SELECT o.execution_enabled, o.operator_suspended
  INTO v_execution_enabled, v_operator_suspended
  FROM work.org o WHERE o.id = p_org_id;

  v_result := jsonb_build_object(
    'org_id', p_org_id,
    'revision', p_target_entitlement_revision,
    'enabled', p_enabled,
    'operator_suspended', p_operator_suspended,
    'seat_limit', p_seat_limit,
    'host_ack_revision', COALESCE(p_host_ack_revision, ent_row.host_ack_revision),
    'execution_enabled', v_execution_enabled,
    'denial_active', EXISTS (
      SELECT 1 FROM work.access_restriction
      WHERE org_id = p_org_id AND source = 'operator'
        AND state IN ('active', 'reconcile_required')
    ),
    'cancellation_intents', v_intents,
    'released_denials', v_released,
    'outcome', v_outcome
  );

  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'execution_entitlement.applied',
    'execution_entitlement', p_org_id,
    jsonb_build_object('client_request_id', p_client_request_id,
                       'request_hash', v_request_hash,
                       'operator_authorization_ref', p_operator_authorization_ref,
                       'result', v_result)
  );
  RETURN v_result;
END;
$$;


-- Restated because CREATE OR REPLACE leaves the previous ACL alone: a grant narrowed in a
-- later increment would otherwise stay attached to a body that no longer expects it.
REVOKE ALL ON FUNCTION work.consume_governance_events(text, jsonb, jsonb, bigint)
  FROM PUBLIC;
GRANT USAGE ON SCHEMA work TO work_governance_events;
GRANT EXECUTE ON FUNCTION work.consume_governance_events(text, jsonb, jsonb, bigint)
  TO work_governance_events;

REVOKE ALL ON FUNCTION work.advance_governance_event_cursor(
  text, bigint, uuid, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.advance_governance_event_cursor(
  text, bigint, uuid, text, text, text
) TO work_api;

REVOKE ALL ON FUNCTION work.apply_execution_entitlement(
  text, text, text, boolean, boolean, bigint, bigint, bigint, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.apply_execution_entitlement(
  text, text, text, boolean, boolean, bigint, bigint, bigint, text
) TO work_operator;

RESET ROLE;
