-- 0021: operation_resolution - the server-authoritative settlement verdict, the two
-- evidence-limited degradation paths, and the adoption block J38 requires.
--
-- Authority: control design §4.1 (the operation_resolution row: resolve_id and
-- attempt_id as frame identity keys, settlement_state reusing quota_reservation's
-- closed set at baseline 0002:276, code taking only resolution-side values,
-- resolution_delivery as a closed set whose not_applicable member means "watermark
-- finished, never wait for ack"), §4.2 issue_operation_resolution (the five
-- preconditions for the read-only degradation and the five for the J38 side-effect
-- one, the three-tier effects, and the reservation that stays unknown), §6.4 (an ack
-- is never a precondition for Run final state or run_sealed), and §9's
-- acceptance_blocked_unresolvable. Validation exits: EV71, EV113, EV120.
--
-- Two of §4.2's preconditions cannot be evaluated from server facts in this increment:
-- "the lease has expired or the device is revoked" needs work.execution_lease, and
-- "the device journal is definitively unavailable" plus "no device_run_seal row" need
-- the seal/journal tables - all three belong to I4 by architecture §6. They are
-- refused below by name rather than quietly satisfied: both degradation paths require
-- the missing facts to be attested in p_evidence, an unattested verdict raises
-- resolution_preconditions_unattested, and an operator who has not got those tables
-- cannot mint either code. I4 must replace the attestation keys with table reads; that
-- obligation is recorded in work-project.md, not implied by a comment here.
--
-- Everything else §4.2 asks is read from the server's own tables: dispatch gate facts
-- on both paths, usage facts, provider request id and receipt ref, and the
-- reservation state the frame reports (§4.1: this column echoes quota_reservation.state
-- and is not decided by the device).
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- The resolution row
-- ---------------------------------------------------------------------------

-- One row per issued conclusion, keyed so that a device journal and a server ledger
-- share the same identity: resolve_id is the frame's required key, attempt_id comes
-- from the dispatch attempt and is null when no permit was ever issued.
CREATE TABLE work.operation_resolution (
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  resolution_revision bigint NOT NULL CHECK (resolution_revision >= 1),
  resolve_id uuid NOT NULL DEFAULT gen_random_uuid(),
  attempt_id uuid,
  state text NOT NULL CHECK (state IN (
    'succeeded', 'failed', 'canceled', 'rejected_not_executed', 'undelivered',
    'sealed_not_sent'
  )),
  -- The dispatch delivery fact at issuance time, same closed set as device_dispatch
  -- in §4.1; recorded because the device reconciles its journal against it. NOT NULL
  -- because it is derived, not supplied: every dispatch_delivery state maps to one of
  -- these values and the absence of a row means not_applicable, so there is no case in
  -- which the fact is unknown - and a null here would be read by the device as "the
  -- server did not look".
  delivery_state text NOT NULL CHECK (delivery_state IN (
    'not_applicable', 'pending', 'delivered', 'undelivered', 'superseded'
  )),
  code text CHECK (code IN ('evidence_unavailable', 'evidence_exhausted')),
  -- Reuses operation_usage_fact.usage_source's closed set (0009:296). I5 adds
  -- device_adapter there and must extend this CHECK in the same increment, or a
  -- local-model usage fact would be unrepresentable in the resolution that reports it.
  usage_source text CHECK (usage_source IN ('provider', 'gateway_estimate', 'unavailable')),
  settlement_state text NOT NULL CHECK (
    settlement_state IN ('held', 'settled', 'released', 'unknown')
  ),
  signature text NOT NULL CHECK (signature ~ '^sha256:[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  resolution_delivery text NOT NULL DEFAULT 'pending' CHECK (resolution_delivery IN (
    'pending', 'delivered', 'acked', 'not_applicable'
  )),
  acked_at timestamptz,
  delivery_attempts int NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ticket_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, operation_id, resolution_revision),
  UNIQUE (org_id, resolve_id),
  FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id),
  FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id),
  FOREIGN KEY (org_id) REFERENCES work.org(id),
  -- J38 precondition 4: an exhausted verdict must cite a ticket that exists outside
  -- this system. Under a one-person operations model that is the only control left
  -- against signing a conclusion to oneself on the spot.
  CONSTRAINT operation_resolution_ticket_shape CHECK (
    code IS DISTINCT FROM 'evidence_exhausted'
    OR (ticket_id IS NOT NULL AND btrim(ticket_id) <> '')
  ),
  -- Watermark shape: an ack timestamp only exists on an acked row, and the two
  -- terminal watermarks (acked / not_applicable) never wait for the other.
  CONSTRAINT operation_resolution_ack_shape CHECK (
    (resolution_delivery = 'acked' AND acked_at IS NOT NULL)
    OR (resolution_delivery <> 'acked' AND acked_at IS NULL)
  ),
  -- Settlement must agree with the conclusion it accompanies: a downgraded verdict
  -- holds the reservation (invariant 2: no evidence is not proof of non-execution),
  -- while a completed action reports a settled or released reservation.
  CONSTRAINT operation_resolution_settlement_shape CHECK (
    code IS NULL
    OR (code = 'evidence_unavailable' AND settlement_state = 'unknown')
    OR (code = 'evidence_exhausted' AND settlement_state = 'unknown')
  )
);

ALTER TABLE work.operation_resolution ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.operation_resolution FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.operation_resolution
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- Only the delivery watermark moves. The conclusion, its evidence, the signature and
-- the settlement fact are exactly what "迟到核账不覆盖已签发结论" protects.
CREATE FUNCTION work.operation_resolution_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.resolution_revision IS DISTINCT FROM OLD.resolution_revision
     OR NEW.resolve_id IS DISTINCT FROM OLD.resolve_id
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.state IS DISTINCT FROM OLD.state
     OR NEW.delivery_state IS DISTINCT FROM OLD.delivery_state
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.usage_source IS DISTINCT FROM OLD.usage_source
     OR NEW.settlement_state IS DISTINCT FROM OLD.settlement_state
     OR NEW.signature IS DISTINCT FROM OLD.signature
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'operation_resolution_content_immutable' USING ERRCODE = '23514';
  END IF;
  -- Forward-only watermarks. not_applicable and acked are both terminal, so a lost
  -- ack cannot be "un-acked" into a state where the Run stops finishing.
  IF NEW.resolution_delivery <> OLD.resolution_delivery THEN
    IF OLD.resolution_delivery IN ('acked', 'not_applicable') THEN
      RAISE EXCEPTION 'operation_resolution_watermark_terminal' USING ERRCODE = '23514';
    END IF;
    IF NOT (
      (OLD.resolution_delivery = 'pending' AND NEW.resolution_delivery IN ('delivered', 'not_applicable'))
      OR (OLD.resolution_delivery = 'delivered' AND NEW.resolution_delivery IN ('acked', 'not_applicable'))
    ) THEN
      RAISE EXCEPTION 'invalid_transition:operation_resolution:%->%',
        OLD.resolution_delivery, NEW.resolution_delivery USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER operation_resolution_guard BEFORE UPDATE ON work.operation_resolution
  FOR EACH ROW EXECUTE FUNCTION work.operation_resolution_guard();
CREATE TRIGGER operation_resolution_no_delete BEFORE DELETE ON work.operation_resolution
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
REVOKE ALL ON FUNCTION work.operation_resolution_guard() FROM PUBLIC;

-- Re-push scan: §4.1 requires every session establishment to re-issue anything whose
-- watermark is not acked/not_applicable. Its reader arrives with I4's session
-- establishment; it is declared here so the first device session does not turn into a
-- full-table scan.
CREATE INDEX work_operation_resolution_unacked
  ON work.operation_resolution(org_id, run_id, resolution_revision)
  WHERE resolution_delivery NOT IN ('acked', 'not_applicable');

-- One signed downgrade per Operation, as a server fact rather than a side effect of
-- the state gate. Settlement verdicts (code null) are deliberately not covered: §4.1
-- allows a new issuance when the Operation's terminal state really changes, and
-- resolution_revision is monotonic so that the appended row stays addressable by the
-- device journal. Two downgrades for one Operation would mean two independent claims
-- that the evidence ran out, and the second one is always the one that was easier to
-- obtain.
CREATE UNIQUE INDEX work_operation_resolution_one_degradation
  ON work.operation_resolution(org_id, operation_id)
  WHERE code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- issue_operation_resolution
-- ---------------------------------------------------------------------------

-- The settlement/delivery vocabulary and the Operation's own state vocabulary are
-- different things: work.state_transition registers unknown -> reconciled and has no
-- unknown -> failed edge, so a degradation always lands reconciled (§4.1 judgment 1).
CREATE FUNCTION work.issue_operation_resolution(
  p_org_id text,
  p_operation_id uuid,
  p_state text,
  p_code text,
  p_ticket_id text,
  p_signature text,
  p_actor_subject_id text,
  p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_task_id uuid;
  operation_row work.operation%ROWTYPE;
  run_row work.run%ROWTYPE;
  gate_row work.dispatch_delivery%ROWTYPE;
  v_next_revision bigint;
  v_latest work.operation_resolution%ROWTYPE;
  v_settlement text;
  v_delivery text;
  v_target text;
  v_candidates int;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_state NOT IN ('succeeded', 'failed', 'canceled', 'rejected_not_executed',
                     'undelivered', 'sealed_not_sent') THEN
    RAISE EXCEPTION 'invalid_request:state' USING ERRCODE = '22023';
  END IF;
  IF p_code IS NOT NULL
     AND p_code NOT IN ('evidence_unavailable', 'evidence_exhausted') THEN
    RAISE EXCEPTION 'invalid_request:code' USING ERRCODE = '22023';
  END IF;
  IF p_signature IS NULL OR p_signature !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request:signature' USING ERRCODE = '22023';
  END IF;

  -- Lock order per §4.3: Task, Run, Operation.
  SELECT r.task_id INTO v_task_id
  FROM work.operation o
  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
  WHERE o.id = p_operation_id AND o.org_id = p_org_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task WHERE id = v_task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO run_row FROM work.run
  WHERE id = (SELECT run_id FROM work.operation WHERE id = p_operation_id)
    AND org_id = p_org_id
  FOR UPDATE;
  SELECT * INTO operation_row FROM work.operation
  WHERE id = p_operation_id AND org_id = p_org_id
  FOR UPDATE;

  -- Resolutions exist for local Runs only (control §4.1 "仅本机 Run 使用"), and
  -- step_key is what marks a row as belonging to a local step.
  IF operation_row.step_key IS NULL THEN
    RAISE EXCEPTION 'operation_not_local' USING ERRCODE = 'P0001';
  END IF;

  -- The delivery fact is read once, here, and reused for both the precondition below
  -- and the delivery_state the frame reports: the same row must not be able to mean
  -- "already dispatched" to one check and "delivered" to the other.
  SELECT * INTO gate_row
  FROM work.dispatch_delivery
  WHERE org_id = p_org_id AND operation_id = p_operation_id;

  -- "同 Operation 仅终态变化才新签发" (§4.1) and "迟到核账不改已签发结论" are one rule
  -- read two ways: the newest row may be replayed, a verdict that repeats it changes
  -- nothing, and a *different* verdict arriving late is a conflict rather than a new
  -- revision of the same conclusion. Checked before the state preconditions because
  -- after any resolution lands the Operation is terminal, so every other guard would
  -- otherwise mask this answer with operation_not_reconcilable.
  SELECT * INTO v_latest
  FROM work.operation_resolution
  WHERE org_id = p_org_id AND operation_id = p_operation_id
  ORDER BY resolution_revision DESC
  LIMIT 1;
  IF FOUND THEN
    IF v_latest.state = p_state
       AND v_latest.code IS NOT DISTINCT FROM p_code THEN
      IF v_latest.signature = p_signature THEN
        RETURN jsonb_build_object('resolve_id', v_latest.resolve_id,
                                  'resolution_revision', v_latest.resolution_revision,
                                  'settlement_state', v_latest.settlement_state,
                                  'delivery_state', v_latest.delivery_state,
                                  'replayed', true);
      END IF;
      -- Same verdict, different signature: two claims about one conclusion.
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF v_latest.code IS NOT NULL OR p_code IS NOT NULL THEN
      -- A downgrade is signed at most once per Operation, in either direction: after
      -- one has been issued no further conclusion may be dressed up as a second
      -- revision, and an already-settled Operation may not be downgraded retroactively.
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_code IS NULL THEN
    -- A settlement verdict may only be issued against an Operation that has not been
    -- settled: a terminal row has nothing left to conclude. Deliberately expressed as
    -- "not terminal" rather than a short allow-list: §4.2 names seal, reject, settle
    -- and undelivered as this command's triggers, and those four arrive on Operations
    -- in prepared / waiting_approval / authorized as well as dispatching / unknown.
    -- Listing only the last three made ('sealed_not_sent','canceled') and
    -- ('canceled','canceled') unissuable - dead mapping rows and an unimplementable
    -- verdict - while realizability is already enforced by the whitelist intersection
    -- below, which is the check that actually means something.
    IF operation_row.state IN ('succeeded', 'failed', 'canceled', 'reconciled') THEN
      RAISE EXCEPTION 'operation_not_reconcilable' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- Shared precondition 1 for the side-effect path and 2 for the read-only one.
    IF operation_row.state NOT IN ('unknown', 'unresolved') THEN
      RAISE EXCEPTION 'operation_not_reconcilable' USING ERRCODE = 'P0001';
    END IF;
    -- Gate facts are checked on *both* degradation paths, not only the read-only one.
    -- For evidence_unavailable the presence of a dispatch row is the disproof of
    -- precondition (1) (an action that was never dispatched cannot have an external
    -- side effect); for evidence_exhausted it is precondition (2) failing - a gate row
    -- is a server-side authoritative fact about what happened, so the case is
    -- settleable, not downgradable, and the sealed_not_sent / consumed /
    -- receipt_recorded states are exactly the evidence §4.2 forbids skipping.
    IF gate_row.operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'resolution_evidence_exists' USING ERRCODE = 'P0001';
    END IF;
    IF p_code = 'evidence_unavailable' THEN
      IF operation_row.kind <> 'tool' THEN
        RAISE EXCEPTION 'evidence_unavailable_scope_denied' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    -- Precondition 5 for the read-only path and 2 for the side-effect one: no
    -- server-side authority fact may be left unread. Anything present means the case
    -- is reconcilable, not downgradable.
    IF EXISTS (
      SELECT 1 FROM work.operation_usage_fact f
      WHERE f.org_id = p_org_id AND f.operation_id = p_operation_id
    ) OR operation_row.usage_recorded_at IS NOT NULL THEN
      RAISE EXCEPTION 'resolution_evidence_exists' USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(operation_row.provider_request_id, '') <> ''
       OR COALESCE(operation_row.receipt_ref, '') <> '' THEN
      RAISE EXCEPTION 'resolution_evidence_exists' USING ERRCODE = 'P0001';
    END IF;
    IF p_code = 'evidence_unavailable' THEN
      -- Preconditions (3) and (4) of the read-only path, last because the server's own
      -- facts are the cheaper and more informative refusal. They are server facts in
      -- the design - "其 execution_lease 已过期或设备已撤权" and "原设备 journal 明确
      -- 不可得" - but work.execution_lease and the journal/seal tables arrive with I4,
      -- so the caller must attest them by name and an unattested verdict is refused
      -- rather than quietly assumed. I4 replaces these two keys with table reads; that
      -- obligation is recorded in work-project.md, not implied by a comment here.
      IF (p_evidence ->> 'lease_or_revocation_checked') IS DISTINCT FROM 'true'
         OR (p_evidence ->> 'journal_unavailable') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'resolution_preconditions_unattested' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF p_code = 'evidence_exhausted' THEN
      -- Preconditions 3 and 4 of the side-effect path. A missing ticket is a malformed
      -- request, not a cursor problem: the ticket is J38's external visibility control
      -- and may not be invented on the spot.
      IF COALESCE(btrim(p_ticket_id), '') = '' THEN
        RAISE EXCEPTION 'invalid_request:ticket_id' USING ERRCODE = '22023';
      END IF;
      -- The device-unreachable and seal facts live in tables I4 creates, so until then
      -- the operator must attest them explicitly and an unattested verdict is refused
      -- rather than quietly accepted.
      IF (p_evidence ->> 'device_unreachable') IS DISTINCT FROM 'true'
         OR (p_evidence ->> 'lease_or_revocation_checked') IS DISTINCT FROM 'true'
         OR (p_evidence ->> 'seal_checked') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'resolution_preconditions_unattested' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- The Operation's own state comes from the whitelist mapping intersected with the
  -- registered edges out of its current state - never from the settlement vocabulary.
  -- Zero or several candidates are both refusals: picking one would be guessing.
  SELECT min(m.operation_state), count(*) INTO v_target, v_candidates
  FROM work.resolution_state_map m
  JOIN work.state_transition e
    ON e.entity = 'operation' AND e.from_state = operation_row.state
   AND e.to_state = m.operation_state
  WHERE m.resolution_state = p_state;
  IF v_target IS NULL OR v_candidates <> 1
     OR (p_code IS NOT NULL AND v_target <> 'reconciled') THEN
    RAISE EXCEPTION 'resolution_target_unreachable' USING ERRCODE = 'P0001';
  END IF;

  -- delivery_state is the gate's own state rather than "a row exists": §4.1 takes the
  -- device_dispatch vocabulary here, and sealed_not_sent means precisely "never
  -- delivered". Reporting it as delivered would tell the device to close a journal row
  -- for an action the server itself recorded as unsent.
  v_delivery := CASE
    WHEN gate_row.gate_state IS NULL THEN 'not_applicable'
    WHEN gate_row.gate_state = 'sealed_not_sent' THEN 'undelivered'
    ELSE 'delivered'
  END;

  -- §4.1: settlement_state takes quota_reservation.state's same closed set and the
  -- frame only echoes the server ledger fact - the device does not decide it. Both
  -- degradation paths pin it to 'unknown' per §4.2, because the reservation is left
  -- exactly where it is (invariant 2: no evidence is not proof of non-execution, and
  -- release_quota would refuse to release a non-held row anyway). Only the settlement
  -- path reads the ledger, and it reads the newest reservation: a supersede chain
  -- leaves several rows per Operation (UNIQUE (operation_id, reservation_seq),
  -- 0002:281) and the current fact is the highest seq. No reservation at all is
  -- reported as 'unknown' rather than 'settled' - there is no row to echo, and
  -- claiming a settlement the ledger cannot show is the failure this column exists
  -- to prevent.
  IF p_code IS NOT NULL THEN
    v_settlement := 'unknown';
  ELSE
    SELECT q.state INTO v_settlement
    FROM work.quota_reservation q
    WHERE q.org_id = p_org_id AND q.operation_id = p_operation_id
    ORDER BY q.reservation_seq DESC
    LIMIT 1;
    v_settlement := COALESCE(v_settlement, 'unknown');
  END IF;

  SELECT COALESCE(MAX(resolution_revision), 0) + 1 INTO v_next_revision
  FROM work.operation_resolution
  WHERE org_id = p_org_id AND operation_id = p_operation_id;

  INSERT INTO work.operation_resolution
    (org_id, run_id, operation_id, resolution_revision, resolve_id, attempt_id,
     state, delivery_state, code, usage_source, settlement_state, signature,
     evidence, ticket_id)
  VALUES
    (p_org_id, operation_row.run_id, p_operation_id, v_next_revision,
     gen_random_uuid(), operation_row.dispatch_attempt_id, p_state,
     v_delivery, p_code,
     CASE WHEN p_code IS NULL THEN NULL ELSE 'unavailable' END,
     v_settlement, p_signature,
     p_evidence || jsonb_build_object(
       'operation_state_before', operation_row.state,
       'operation_state_after', v_target,
       'reservation_held', EXISTS (SELECT 1 FROM work.quota_reservation q
                                   WHERE q.org_id = p_org_id AND q.operation_id = p_operation_id
                                     AND q.state = 'held'),
       'reservations', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                     'seq', q.reservation_seq, 'state', q.state)
                                   ORDER BY q.reservation_seq)
                                FROM work.quota_reservation q
                                WHERE q.org_id = p_org_id
                                  AND q.operation_id = p_operation_id), '[]'::jsonb)),
     NULLIF(btrim(COALESCE(p_ticket_id, '')), ''));

  -- The target came from the whitelist intersection above, so the transition trigger
  -- cannot refuse it. Writing 'failed' here because the settlement said failed is the
  -- mistake this whole path exists to prevent.
  UPDATE work.operation
  SET state = v_target, revision = revision + 1, updated_at = now()
  WHERE id = p_operation_id AND org_id = p_org_id;

  -- §6.4/§4.2: the Run's wait reason is rewritten from reconcile to input, not
  -- cleared, and control_revision rises while fence stays put (same convention as
  -- the effective resume_run at baseline 0002:2096-2107).
  IF run_row.state = 'waiting' AND run_row.wait_reason = 'reconcile' THEN
    UPDATE work.run
    SET wait_reason = 'input', control_revision = control_revision + 1, updated_at = now()
    WHERE id = run_row.id AND org_id = p_org_id;
  END IF;

  PERFORM work.append_task_event(
    p_org_id, v_task_id,
    CASE WHEN v_target = 'reconciled' THEN 'operation.reconciled' ELSE 'operation.settled' END,
    jsonb_build_object('operation_id', p_operation_id, 'state', p_state,
                       'operation_state', v_target,
                       'code', p_code, 'settlement_state', v_settlement,
                       'delivery_state', v_delivery)
  );
  PERFORM work.append_audit(
    p_org_id, p_actor_subject_id, 'operation.resolution_issued',
    'operation', p_operation_id::text,
    jsonb_build_object('state', p_state, 'operation_state', v_target, 'code', p_code,
                       'ticket_id', NULLIF(btrim(COALESCE(p_ticket_id, '')), ''),
                       'resolution_revision', v_next_revision,
                       'settlement_state', v_settlement,
                       'delivery_state', v_delivery,
                       'evidence', p_evidence)
  );
  RETURN jsonb_build_object(
    'resolve_id', (SELECT resolve_id FROM work.operation_resolution
                   WHERE org_id = p_org_id AND operation_id = p_operation_id
                     AND resolution_revision = v_next_revision),
    'resolution_revision', v_next_revision,
    'operation_state', v_target,
    'settlement_state', v_settlement,
    'delivery_state', v_delivery,
    'replayed', false
  );
END;
$$;

REVOKE ALL ON FUNCTION work.issue_operation_resolution(
  text, uuid, text, text, text, text, text, jsonb
) FROM PUBLIC;
-- Same caller pair as work.reconcile_operation: the finishing worker and the
-- one-shot work-reconcile job, both as work_worker. work_api has no path here, and
-- §1.4 deliberately lists no reconcile endpoint.
GRANT EXECUTE ON FUNCTION work.issue_operation_resolution(
  text, uuid, text, text, text, text, text, jsonb
) TO work_worker;

-- ---------------------------------------------------------------------------
-- The adoption block (J38)
-- ---------------------------------------------------------------------------

-- Reconciling an evidence-exhausted verdict frees the Run for a new attempt but must
-- not let the Task be accepted: reconciled is not proof of success, and it clears
-- task_has_blocking_operation as a side effect, which would otherwise open adoption
-- by accident. A trigger rather than an edit inside accept_task: that function has
-- already been replaced once in baseline and every adoption path - present or future
-- - has to pass this predicate.
CREATE FUNCTION work.block_acceptance_when_unresolvable() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_blocked boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM work.operation_resolution r
    JOIN work.operation o ON o.id = r.operation_id AND o.org_id = r.org_id
    JOIN work.run run ON run.id = o.run_id AND run.org_id = o.org_id
    WHERE r.org_id = NEW.org_id
      AND run.task_id = NEW.task_id
      AND r.code = 'evidence_exhausted'
  ) INTO v_blocked;
  IF v_blocked THEN
    RAISE EXCEPTION 'acceptance_blocked_unresolvable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER acceptance_block_unresolvable BEFORE INSERT ON work.acceptance
  FOR EACH ROW EXECUTE FUNCTION work.block_acceptance_when_unresolvable();
REVOKE ALL ON FUNCTION work.block_acceptance_when_unresolvable() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The reconciliation read face (§1.4 GET /runs/{id}/reconciliations, R12C-2 / J38)
-- ---------------------------------------------------------------------------

-- A function rather than a Go read: work_api has no SELECT on operation_resolution,
-- dispatch_delivery, operation_usage_fact or quota_reservation, and handing the request
-- role raw table access to serve one metadata view would widen the surface more than the
-- view needs. The body below reads exactly what §1.4 lists - no artifact body, no content
-- reference, no provider text, no device identifiers.
--
-- The set of Operations is the part §1.4's own field list forces. The row says "每条
-- unknown/unresolved Operation", but issuing any conclusion moves the Operation into a
-- terminal state, so a scan limited to unknown/unresolved could never show the J38 verdict
-- the same row requires be queryable. Listed here are therefore the Operations still waiting
-- (unknown, unresolved) *plus* those carrying a degradation verdict (code not null); an
-- action settled by real evidence belongs to neither, which is right - it waits for nothing.
CREATE FUNCTION work.list_run_reconciliations(
  p_org_id text,
  p_run_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_items jsonb;
  v_blocking boolean;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM work.assert_session_subject(p_actor_subject_id);
  SELECT * INTO run_row FROM work.run WHERE org_id = p_org_id AND id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task
  WHERE org_id = p_org_id AND id = run_row.task_id
    AND owner_subject_id = p_actor_subject_id;
  -- Somebody else's Run answers the same way a missing one does: this view exists so the
  -- owner can see what their own task is waiting on, and a 403 would disclose that the Run
  -- is real (0002:2840-2841 sets the same idiom for task reads).
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(jsonb_agg(item ORDER BY item ->> 'operation_id'), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT jsonb_build_object(
      'operation_id', o.id,
      'kind', o.kind,
      'operation_state', o.state,
      'reconcile_requested_at', o.reconcile_requested_at,
      'waited_seconds', CASE
        WHEN o.reconcile_requested_at IS NULL THEN NULL
        ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - o.reconcile_requested_at)))::bigint)
      END,
      'resolution_state', CASE degradation.code
        WHEN 'evidence_unavailable' THEN 'downgraded_readonly'
        WHEN 'evidence_exhausted' THEN 'evidence_exhausted'
        ELSE 'pending'
      END,
      -- The exhausted list is the set the verdict was signed against, so it is read back
      -- from the resolution's own evidence. The four keys the issuing command injects
      -- (state before/after, the reservation snapshot) are server internals, not evidence
      -- sources somebody checked, and stay out of the client-visible list.
      'evidence_sources', CASE
        WHEN degradation.evidence IS NULL THEN '[]'::jsonb
        ELSE (SELECT COALESCE(jsonb_agg(source_key ORDER BY source_key), '[]'::jsonb)
              FROM jsonb_object_keys(degradation.evidence) AS source_key
              WHERE source_key NOT IN ('operation_state_before', 'operation_state_after',
                                       'reservation_held', 'reservations'))
      END,
      'ticket_id', degradation.ticket_id,
      -- The same server-fact set the issuing path refuses to downgrade past (§4.2's
      -- precondition 5): if any of it exists, the case is reconcilable rather than
      -- evidence-limited, and the user should see that distinction rather than a wait.
      'has_authoritative_evidence', (
        EXISTS (SELECT 1 FROM work.operation_usage_fact f
                WHERE f.org_id = o.org_id AND f.operation_id = o.id)
        OR o.usage_recorded_at IS NOT NULL
        OR COALESCE(o.provider_request_id, '') <> ''
        OR COALESCE(o.receipt_ref, '') <> ''
        OR EXISTS (SELECT 1 FROM work.dispatch_delivery d
                   WHERE d.org_id = o.org_id AND d.operation_id = o.id)
      ),
      'contact_path', CASE degradation.code
        WHEN 'evidence_exhausted' THEN 'operator_ticket'
        WHEN 'evidence_unavailable' THEN 'wait_for_late_evidence'
        ELSE 'wait_for_reconciliation'
      END
    ) AS item
    FROM work.operation o
    LEFT JOIN LATERAL (
      SELECT r.code, r.evidence, r.ticket_id
      FROM work.operation_resolution r
      WHERE r.org_id = o.org_id AND r.operation_id = o.id AND r.code IS NOT NULL
      ORDER BY r.resolution_revision DESC
      LIMIT 1
    ) degradation ON TRUE
    WHERE o.org_id = p_org_id AND o.run_id = p_run_id
      AND (o.state IN ('unknown', 'unresolved') OR degradation.code IS NOT NULL)
  ) waiting_operations;

  -- Both mandatory outcomes are read from the predicates that actually decide them, not
  -- re-derived here: new-Run admission and acceptance share task_has_blocking_operation,
  -- and J38 adds the acceptance-only block that the trigger above enforces on
  -- work.acceptance. A signed read-only degradation therefore clears both, while an
  -- exhausted verdict clears admission and keeps acceptance shut.
  v_blocking := work.task_has_blocking_operation(run_row.task_id, p_org_id);
  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'run_id', p_run_id,
    'task_id', run_row.task_id,
    'run_state', run_row.state,
    'wait_reason', run_row.wait_reason,
    'blocking', jsonb_build_object(
      'new_run', v_blocking,
      'acceptance', v_blocking OR EXISTS (
        SELECT 1 FROM work.operation_resolution r
        JOIN work.operation o ON o.id = r.operation_id AND o.org_id = r.org_id
        JOIN work.run rn ON rn.id = o.run_id AND rn.org_id = o.org_id
        WHERE r.org_id = p_org_id AND rn.task_id = run_row.task_id
          AND r.code = 'evidence_exhausted'
      )
    ),
    'items', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION work.list_run_reconciliations(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.list_run_reconciliations(text, uuid, text) TO work_api;

REVOKE ALL ON TABLE work.operation_resolution FROM PUBLIC;
REVOKE ALL ON TABLE work.operation_resolution FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;

RESET ROLE;
