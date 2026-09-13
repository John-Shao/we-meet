# Phase 3 batch 94 / cumulative batch 114

Added manager-only `GET /api/v1.0/cloud-recording/control/?room_id=<uuid>&livekit_room_sid=<RM_...>` as the native cloud-video control foundation. This endpoint is read-only in this batch; it does not start or stop an egress, initialize an AI capture, or create a note.

- State echoes the exact room/SID/session identity, latest cloud-video identity and status, start/stop eligibility, conflict and attention flags. No fallback to the latest room occurrence. Transcript-mode recordings never become cloud-video stop targets.
- An outstanding recording from another session or mode blocks a new video start without exposing its identity. A concrete active video remains discoverable as a stop target after rollout is disabled or its room has ended. Pending/failed-stop/unknown worker state is not reported as successful recording or a safe new start.
- Current room owner/admin and active organization membership are required via the existing capture permission policy; a materials/recording grant alone is insufficient. Responses, including errors, are `no-store`; read throttle is 120/minute per user.
- Added `MEETING_CLOUD_RECORDING_ENABLED=false`. Capability additionally requires `RECORDING_ENABLE` and a configured `screen_recording` worker. Keep the new flag off until command/worker/native UI integration and deployment acceptance are complete.

Validation: 14 new cloud-state tests and 10 existing online-capture regressions pass; lint/diff checks pass. The initial ended-room fixture tried to set a derived property and was corrected to set `ended_at`. No worker/provider calls, production deployment or database migration.

Next: durable exact-session cloud start/stop commands, worker outcome reconciliation and Android controls. Native cloud recording, standalone-recording translation and the complete technical walkthrough remain development work. M3/M4 remain incomplete.
