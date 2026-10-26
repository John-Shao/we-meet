-- DESTRUCTIVE one-off cleanup for the deleted legacy Work app (2026-10-27).
-- Run only in a change window, after a verified backup. This is not a migration
-- and is not executed automatically.
BEGIN;
DROP TABLE IF EXISTS public.work_workrunevent CASCADE;
DROP TABLE IF EXISTS public.work_workartifactfile CASCADE;
DROP TABLE IF EXISTS public.work_workartifactversion CASCADE;
DROP TABLE IF EXISTS public.work_workreview CASCADE;
DROP TABLE IF EXISTS public.work_workrun CASCADE;
DROP TABLE IF EXISTS public.work_workworkspace CASCADE;
DROP TABLE IF EXISTS public.work_workdevice CASCADE;
DROP TABLE IF EXISTS public.work_workaccessaudit CASCADE;
DROP TABLE IF EXISTS public.work_workmembergrant CASCADE;
DROP TABLE IF EXISTS public.work_workorganizationentitlement CASCADE;
DROP TABLE IF EXISTS public.work_workmaterial CASCADE;
DROP TABLE IF EXISTS public.work_worktask CASCADE;
COMMIT;
