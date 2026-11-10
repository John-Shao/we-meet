-- Migration 0037: Fix epoch deduplication in member narrowing trigger
-- 
-- Problem: When mark_members_absent updates N members in a single transaction,
-- the record_member_narrowing trigger fires N times, and each firing bumps
-- access_epoch. This results in N epoch bumps instead of 1.
--
-- Solution: Use a session variable work.epoch_bumped_for_mass_absence to track
-- whether the epoch has already been bumped in the current event. The first
-- trigger firing bumps the epoch and sets the flag; subsequent firings see the
-- flag and skip the bump.
--
-- This migration recreates the two trigger functions that contain the
-- record_member_narrowing logic:
-- 1. work.record_member_narrowing (in migration 0019)
-- 2. work.record_member_narrowing_with_intents (in migration 0023)

-- Recreate work.record_member_narrowing with epoch deduplication fix
CREATE OR REPLACE FUNCTION work.record_member_narrowing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_temp
AS $$
DECLARE
  v_epoch bigint;
  v_restriction_id uuid;
  v_source text;
  v_open_change boolean;
  v_epoch_already_bumped boolean;
BEGIN
  IF OLD.status = NEW.status AND OLD.work_seat = NEW.work_seat THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.org_id', NEW.org_id, true);

  -- Check if the epoch has already been bumped for this mass-absence event.
  -- This prevents N*2 epoch bumps when mark_members_absent updates N members.
  v_epoch_already_bumped := COALESCE(
    NULLIF(current_setting('work.epoch_bumped_for_mass_absence', true), ''), 'false'
  ) = 'true';

  -- If we haven't bumped the epoch yet in this event, do it now and set the flag
  -- immediately so subsequent branches/members don't bump it again.
  IF NOT v_epoch_already_bumped THEN
    UPDATE work.org SET access_epoch = access_epoch + 1, updated_at = now()
    WHERE id = NEW.org_id RETURNING access_epoch INTO v_epoch;
    PERFORM set_config('work.epoch_bumped_for_mass_absence', 'true', true);
    v_epoch_already_bumped := true;
  ELSE
    SELECT access_epoch INTO v_epoch FROM work.org WHERE id = NEW.org_id;
  END IF;

  IF OLD.status = 'active' AND NEW.status IN ('suspended', 'left') THEN
    v_restriction_id := gen_random_uuid();
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'member', NEW.id, 'host_member',
       CASE WHEN NEW.status = 'suspended' THEN 'member_suspended' ELSE 'member_left' END,
       v_epoch, NULL, NULL);
    PERFORM work.append_governance_event(
      NEW.org_id,
      'member_restricted',
      jsonb_build_object(
        'member_id', NEW.id,
        'restriction_id', v_restriction_id,
        'source', 'host_member',
        'reason', CASE WHEN NEW.status = 'suspended' THEN 'member_suspended' ELSE 'member_left' END,
        'epoch', v_epoch
      )
    );
  ELSIF OLD.status IN ('suspended', 'left') AND NEW.status = 'active' THEN
    SELECT EXISTS (
      SELECT 1 FROM work.access_restriction
      WHERE org_id = NEW.org_id
        AND scope = 'member'
        AND subject_id = NEW.id
        AND source = 'host_member'
        AND released_at IS NULL
    ) INTO v_open_change;
    v_source := CASE WHEN v_open_change THEN 'work_seat_change' ELSE 'host_seat' END;
    v_restriction_id := gen_random_uuid();
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'member', NEW.id, v_source,
       'member_reactivated', v_epoch, NULL, NULL);
    PERFORM work.append_governance_event(
      NEW.org_id,
      'member_restricted',
      jsonb_build_object(
        'member_id', NEW.id,
        'restriction_id', v_restriction_id,
        'source', v_source,
        'reason', 'member_reactivated',
        'epoch', v_epoch
      )
    );
  END IF;

  IF OLD.work_seat = true AND NEW.work_seat = false THEN
    SELECT EXISTS (
      SELECT 1 FROM work.access_restriction
      WHERE org_id = NEW.org_id
        AND scope = 'member'
        AND subject_id = NEW.id
        AND source IN ('host_member', 'work_seat_change')
        AND released_at IS NULL
    ) INTO v_open_change;
    v_source := CASE WHEN v_open_change THEN 'work_seat_change' ELSE 'host_seat' END;
    v_restriction_id := gen_random_uuid();
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'seat', NEW.id, v_source,
       'seat_revoked', v_epoch, NULL, NULL);
    PERFORM work.append_governance_event(
      NEW.org_id,
      'member_restricted',
      jsonb_build_object(
        'member_id', NEW.id,
        'restriction_id', v_restriction_id,
        'source', v_source,
        'reason', 'seat_revoked',
        'epoch', v_epoch
      )
    );
  ELSIF OLD.work_seat = false AND NEW.work_seat = true THEN
    SELECT EXISTS (
      SELECT 1 FROM work.access_restriction
      WHERE org_id = NEW.org_id
        AND scope = 'seat'
        AND subject_id = NEW.id
        AND source IN ('host_seat', 'work_seat_change')
        AND released_at IS NULL
    ) INTO v_open_change;
    v_source := CASE WHEN v_open_change THEN 'work_seat_change' ELSE 'host_seat' END;
    v_restriction_id := gen_random_uuid();
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'seat', NEW.id, v_source,
       'seat_granted', v_epoch, NULL, NULL);
    PERFORM work.append_governance_event(
      NEW.org_id,
      'member_restricted',
      jsonb_build_object(
        'member_id', NEW.id,
        'restriction_id', v_restriction_id,
        'source', v_source,
        'reason', 'seat_granted',
        'epoch', v_epoch
      )
    );
  END IF;

  RETURN NULL;
END;
$$;

-- Recreate work.record_member_narrowing_with_intents with epoch deduplication fix
CREATE OR REPLACE FUNCTION work.record_member_narrowing_with_intents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_temp
AS $$
DECLARE
  v_epoch bigint;
  v_restriction_id uuid;
  v_source text;
  v_open_change boolean;
  v_intents bigint;
  v_epoch_already_bumped boolean;
BEGIN
  IF OLD.status = NEW.status AND OLD.work_seat = NEW.work_seat THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.org_id', NEW.org_id, true);

  -- Check if the epoch has already been bumped for this mass-absence event.
  -- This prevents N*2 epoch bumps when mark_members_absent updates N members.
  v_epoch_already_bumped := COALESCE(
    NULLIF(current_setting('work.epoch_bumped_for_mass_absence', true), ''), 'false'
  ) = 'true';

  -- If we haven't bumped the epoch yet in this event, do it now and set the flag
  -- immediately so subsequent branches/members don't bump it again.
  IF NOT v_epoch_already_bumped THEN
    UPDATE work.org SET access_epoch = access_epoch + 1, updated_at = now()
    WHERE id = NEW.org_id RETURNING access_epoch INTO v_epoch;
    PERFORM set_config('work.epoch_bumped_for_mass_absence', 'true', true);
    v_epoch_already_bumped := true;
  ELSE
    SELECT access_epoch INTO v_epoch FROM work.org WHERE id = NEW.org_id;
  END IF;

  IF OLD.status = 'active' AND NEW.status IN ('suspended', 'left') THEN
    v_restriction_id := gen_random_uuid();
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'member', NEW.id, 'host_member',
       CASE WHEN NEW.status = 'suspended' THEN 'member_suspended' ELSE 'member_left' END,
       v_epoch, NULL, NULL);
    PERFORM work.append_governance_event(
      NEW.org_id,
      'member_restricted',
      jsonb_build_object(
        'member_id', NEW.id,
        'restriction_id', v_restriction_id,
        'source', 'host_member',
        'reason', CASE WHEN NEW.status = 'suspended' THEN 'member_suspended' ELSE 'member_left' END,
        'epoch', v_epoch
      )
    );
    SELECT COUNT(*) INTO v_intents FROM work.operation_intent WHERE member_id = NEW.id AND state = 'pending';
    IF v_intents > 0 THEN
      UPDATE work.operation_intent SET state = 'orphaned', updated_at = now() WHERE member_id = NEW.id AND state = 'pending';
    END IF;
  ELSIF OLD.status IN ('suspended', 'left') AND NEW.status = 'active' THEN
    SELECT EXISTS (
      SELECT 1 FROM work.access_restriction
      WHERE org_id = NEW.org_id
        AND scope = 'member'
        AND subject_id = NEW.id
        AND source = 'host_member'
        AND released_at IS NULL
    ) INTO v_open_change;
    v_source := CASE WHEN v_open_change THEN 'work_seat_change' ELSE 'host_seat' END;
    v_restriction_id := gen_random_uuid();
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'member', NEW.id, v_source,
       'member_reactivated', v_epoch, NULL, NULL);
    PERFORM work.append_governance_event(
      NEW.org_id,
      'member_restricted',
      jsonb_build_object(
        'member_id', NEW.id,
        'restriction_id', v_restriction_id,
        'source', v_source,
        'reason', 'member_reactivated',
        'epoch', v_epoch
      )
    );
  END IF;

  IF OLD.work_seat = true AND NEW.work_seat = false THEN
    SELECT EXISTS (
      SELECT 1 FROM work.access_restriction
      WHERE org_id = NEW.org_id
        AND scope = 'member'
        AND subject_id = NEW.id
        AND source IN ('host_member', 'work_seat_change')
        AND released_at IS NULL
    ) INTO v_open_change;
    v_source := CASE WHEN v_open_change THEN 'work_seat_change' ELSE 'host_seat' END;
    v_restriction_id := gen_random_uuid();
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'seat', NEW.id, v_source,
       'seat_revoked', v_epoch, NULL, NULL);
    PERFORM work.append_governance_event(
      NEW.org_id,
      'member_restricted',
      jsonb_build_object(
        'member_id', NEW.id,
        'restriction_id', v_restriction_id,
        'source', v_source,
        'reason', 'seat_revoked',
        'epoch', v_epoch
      )
    );
    SELECT COUNT(*) INTO v_intents FROM work.operation_intent WHERE member_id = NEW.id AND state = 'pending';
    IF v_intents > 0 THEN
      UPDATE work.operation_intent SET state = 'orphaned', updated_at = now() WHERE member_id = NEW.id AND state = 'pending';
    END IF;
  ELSIF OLD.work_seat = false AND NEW.work_seat = true THEN
    SELECT EXISTS (
      SELECT 1 FROM work.access_restriction
      WHERE org_id = NEW.org_id
        AND scope = 'seat'
        AND subject_id = NEW.id
        AND source IN ('host_seat', 'work_seat_change')
        AND released_at IS NULL
    ) INTO v_open_change;
    v_source := CASE WHEN v_open_change THEN 'work_seat_change' ELSE 'host_seat' END;
    v_restriction_id := gen_random_uuid();
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'seat', NEW.id, v_source,
       'seat_granted', v_epoch, NULL, NULL);
    PERFORM work.append_governance_event(
      NEW.org_id,
      'member_restricted',
      jsonb_build_object(
        'member_id', NEW.id,
        'restriction_id', v_restriction_id,
        'source', v_source,
        'reason', 'seat_granted',
        'epoch', v_epoch
      )
    );
  END IF;

  RETURN NULL;
END;
$$;

-- Grant execute permissions
REVOKE ALL ON FUNCTION work.record_member_narrowing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.record_member_narrowing() TO work_api;

REVOKE ALL ON FUNCTION work.record_member_narrowing_with_intents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.record_member_narrowing_with_intents() TO work_api;
