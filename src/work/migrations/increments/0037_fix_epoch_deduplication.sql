-- Migration 0037: Fix epoch deduplication for mass member updates
-- Problem: record_member_narrowing() and record_member_narrowing_with_intents() 
-- bump org_member.epoch on every call, even within a single batch operation.
-- When processing 1000 members, this causes 1000*2 epoch bumps (member + org),
-- triggering excessive cache invalidations and replication lag.
--
-- Solution: Use session variable work.epoch_bumped_for_mass_absence to track
-- whether epoch has already been bumped in the current transaction. Only bump
-- on the first call, skip subsequent bumps within the same transaction.
--
-- This optimization is safe because:
-- 1. All calls within a transaction are part of the same logical operation
-- 2. A single epoch bump is sufficient to invalidate caches
-- 3. The session variable is automatically cleared at transaction end

-- Recreate record_member_narrowing() with epoch deduplication
CREATE OR REPLACE FUNCTION work.record_member_narrowing(
    p_org_id UUID,
    p_member_id UUID,
    p_narrowing_type TEXT,
    p_details JSONB DEFAULT '{}'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO work, pg_temp
AS $$
DECLARE
    v_already_bumped BOOLEAN;
BEGIN
    -- Check if epoch was already bumped in this transaction
    v_already_bumped := COALESCE(
        current_setting('work.epoch_bumped_for_mass_absence', TRUE)::BOOLEAN,
        FALSE
    );
    
    -- Update member epoch (always)
    UPDATE work.org_member
    SET epoch = epoch + 1,
        updated_at = NOW()
    WHERE org_id = p_org_id AND member_id = p_member_id;
    
    -- Update org epoch only if not already bumped in this transaction
    IF NOT v_already_bumped THEN
        UPDATE work.org
        SET member_epoch = member_epoch + 1,
            updated_at = NOW()
        WHERE id = p_org_id;
        
        -- Mark that we've bumped the epoch in this transaction
        PERFORM set_config('work.epoch_bumped_for_mass_absence', 'true', TRUE);
    END IF;
    
    -- Record the narrowing event
    INSERT INTO work.org_member_narrowing_event (
        org_id,
        member_id,
        narrowing_type,
        details,
        created_at
    ) VALUES (
        p_org_id,
        p_member_id,
        p_narrowing_type,
        p_details,
        NOW()
    );
END;
$$;

REVOKE ALL ON FUNCTION work.record_member_narrowing(UUID, UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.record_member_narrowing(UUID, UUID, TEXT, JSONB) TO work_owner;

-- Recreate record_member_narrowing_with_intents() with epoch deduplication
CREATE OR REPLACE FUNCTION work.record_member_narrowing_with_intents(
    p_org_id UUID,
    p_member_id UUID,
    p_narrowing_type TEXT,
    p_intent_ids UUID[],
    p_details JSONB DEFAULT '{}'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO work, pg_temp
AS $$
DECLARE
    v_already_bumped BOOLEAN;
    v_intent_id UUID;
BEGIN
    -- Check if epoch was already bumped in this transaction
    v_already_bumped := COALESCE(
        current_setting('work.epoch_bumped_for_mass_absence', TRUE)::BOOLEAN,
        FALSE
    );
    
    -- Update member epoch (always)
    UPDATE work.org_member
    SET epoch = epoch + 1,
        updated_at = NOW()
    WHERE org_id = p_org_id AND member_id = p_member_id;
    
    -- Update org epoch only if not already bumped in this transaction
    IF NOT v_already_bumped THEN
        UPDATE work.org
        SET member_epoch = member_epoch + 1,
            updated_at = NOW()
        WHERE id = p_org_id;
        
        -- Mark that we've bumped the epoch in this transaction
        PERFORM set_config('work.epoch_bumped_for_mass_absence', 'true', TRUE);
    END IF;
    
    -- Record the narrowing event
    INSERT INTO work.org_member_narrowing_event (
        org_id,
        member_id,
        narrowing_type,
        intent_ids,
        details,
        created_at
    ) VALUES (
        p_org_id,
        p_member_id,
        p_narrowing_type,
        p_intent_ids,
        p_details,
        NOW()
    );
    
    -- Update intent-level narrowing counts
    FOREACH v_intent_id IN ARRAY p_intent_ids
    LOOP
        INSERT INTO work.org_member_intent_narrowing (
            org_id,
            member_id,
            intent_id,
            narrowing_type,
            event_count,
            last_event_at
        ) VALUES (
            p_org_id,
            p_member_id,
            v_intent_id,
            p_narrowing_type,
            1,
            NOW()
        )
        ON CONFLICT (org_id, member_id, intent_id, narrowing_type)
        DO UPDATE SET
            event_count = org_member_intent_narrowing.event_count + 1,
            last_event_at = NOW();
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION work.record_member_narrowing_with_intents(UUID, UUID, TEXT, UUID[], JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.record_member_narrowing_with_intents(UUID, UUID, TEXT, UUID[], JSONB) TO work_owner;

-- Reset the session variable at transaction end (safety measure)
-- This is automatically handled by PostgreSQL session variable scope,
-- but we document the expected behavior here.
