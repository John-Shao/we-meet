-- 0065: a late successful receipt reconciles an unknown Operation (EV113).
-- The Operation remains reconciled rather than being rewritten directly to succeeded:
-- unknown -> succeeded is not a registered edge, while unknown -> reconciled is.
SET ROLE work_owner;

INSERT INTO work.resolution_state_map (resolution_state, operation_state)
VALUES ('succeeded', 'reconciled')
ON CONFLICT DO NOTHING;

RESET ROLE;
