# Reservation lifecycle

Scheduled video rooms expire after the last valid calendar occurrence ends plus
`ROOM_RESERVATION_GRACE_SECONDS` (default 86400). Legacy rooms without a calendar
event use their `scheduled_at` plus that grace period. All-day events use their
exclusive end date in the event timezone. Recurrences are checked beyond the
materialization window; a future occurrence keeps the shared room available.

Deleting an event, cancelling it, or detaching its video meeting schedules a
recheck after commit. Other valid events sharing the room protect it. An active
meeting session also protects it; cancellation is retained until the session
ends. Closing sets `ended_at` and `closure_reason`, never deletes the room,
recordings, transcripts, summaries, access rows or session history. Rescheduling
an expired appointment creates a new room instead of reviving an old number.

The overview and token/lobby entry paths enforce expiry synchronously, even when
Celery is unavailable. `close-expired-reservations` runs every five minutes to
reconcile rooms that nobody visits. Existing already-issued LiveKit tokens retain
their SDK/server lifetime; this policy prevents obtaining new entry credentials.

Deploy backend migration 0194 before serving the updated application. Audit
existing data with `python manage.py close_expired_reservations`; apply with
`python manage.py close_expired_reservations --apply`. Both use the same policy
and skip active meetings. Historical calendar data is preserved and unopened
expired appointments are not fabricated into meeting history.
