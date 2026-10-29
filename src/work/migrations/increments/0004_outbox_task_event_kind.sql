-- Outbox task events carry the frozen kind discriminator from D3 §10.
-- The task fact stays in work.task_event; this payload is relay/SSE routing only.
SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.append_task_event(
  p_org_id text,
  p_task_id uuid,
  p_type text,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  next_seq bigint;
  event_id uuid := gen_random_uuid();
BEGIN
  PERFORM 1 FROM work.task
  WHERE id = p_task_id AND org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(MAX(seq), 0) + 1 INTO next_seq
  FROM work.task_event
  WHERE task_id = p_task_id AND org_id = p_org_id;
  INSERT INTO work.task_event
    (id, org_id, task_id, seq, type, payload)
  VALUES
    (event_id, p_org_id, p_task_id, next_seq, p_type, COALESCE(p_payload, '{}'::jsonb));
  INSERT INTO work.outbox
    (org_id, aggregate_type, aggregate_id, event_id, payload)
  VALUES
    (p_org_id, 'task', p_task_id, event_id,
     COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object('kind', 'task_event'));
  RETURN event_id;
END;
$$;

RESET ROLE;
