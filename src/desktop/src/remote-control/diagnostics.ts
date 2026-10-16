import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

export type DiagnosticSink = (kind: "native" | "state" | "failure" | "shutdown", value: Record<string, unknown>) => void;
const events = new Set(["hello", "displays", "consentShown", "consentAllowed", "uiUnavailable", "closed", "guardianClosed", "terminated", "failed", "fatal", "armed", "resumeRequested"]);
const phases = new Set(["idle", "preparing", "confirming", "active", "pausing", "paused", "ending", "ended", "blocked"]);
// Keep data from errors and native events on a fixed vocabulary. No arbitrary
// error text, account/session IDs, tokens, signatures, nonces or input payloads.
const reasons = new Set((
  "local_stop parent_stop context_closed account_changed share_stopped meeting_left connection_changed video_unavailable " +
  "cleanup_unconfirmed native_closed native_unavailable native_busy native_start_timeout native_controls_unavailable native_start_failed " +
  "native_pipe_failed native_spawn_failed native_response_invalid native_response_oversize native_backpressure " +
  "native_ui_unavailable native_ui_not_active native_ui_missing native_tray_unavailable native_ui_unresponsive native_ui_hidden " +
  "native_ui_not_topmost native_ui_geometry_unavailable native_ui_geometry_changed native_ui_covered guardian_lost " +
  "desktop_observation_lost desktop_uncertain desktop_unavailable desktop_locked system_suspend session_changed display_changed " +
  "emergency_stop local_takeover parent_pause capture_suspended consent_denied consent_expired invalid_consent invalid_command " +
  "arm_denied consent_binding_mismatch generation_reused lease_expired invalid_lease controller_timeout " +
  "authorization_cancelled authorization_expired authorization_changed authorization_binding_mismatch remote_authorization_failed " +
  "remote_account_changed remote_context_changed remote_control_disabled remote_busy remote_unavailable " +
  "request_binding_mismatch capture_binding_mismatch local_consent_required remote_response_invalid state_conflict " +
  "challenge_expired challenge_binding_mismatch unauthorized_arm pause_without_authorization remote_send_timeout " +
  "remote_queue_full input_failed input_gap input_released expired_input invalid_signature_or_binding exit"
).split(" "));

export function diagnosticFields(value: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  if (typeof value.event === "string" && events.has(value.event)) safe.event = value.event;
  if (typeof value.phase === "string" && phases.has(value.phase)) safe.phase = value.phase;
  if (typeof value.reason === "string") safe.reason = reasons.has(value.reason) ? value.reason : "unknown";
  for (const key of ["ready", "inputOpen", "cleanupBlocked", "wasActive"])
    if (typeof value[key] === "boolean") safe[key] = value[key];
  for (const key of ["cleanup", "exitCode", "pid", "guardianPid"])
    if (Number.isSafeInteger(value[key])) safe[key] = value[key];
  return safe;
}

/** Bounded, local-only, asynchronous diagnostics. Disk failure cannot affect a
 * control decision. Keep at most two 128 KiB files and 128 pending records. */
export function createRemoteDiagnostics(directory: string) {
  const file = path.join(directory, "remote-control.jsonl");
  let chain = Promise.resolve(), pending = 0, lastState = "";
  const record: DiagnosticSink = (kind, value) => {
    const fields = diagnosticFields(value);
    if (!Object.keys(fields).length) return;
    if (kind === "native" && !fields.event) return; // No high-rate input/heartbeat logging.
    const state = JSON.stringify(fields);
    if (kind === "state") { if (lastState === state) return; lastState = state; }
    if (pending >= 128) return;
    const line = JSON.stringify({ time: new Date().toISOString(), kind, ...fields }) + "\n";
    ++pending;
    chain = chain.then(async () => {
      await mkdir(directory, { recursive: true });
      const size = await stat(file).then(info => info.size, () => 0);
      if (size + Buffer.byteLength(line) > 128 * 1024) {
        await unlink(file + ".previous").catch(error => { if (error.code !== "ENOENT") throw error; });
        await rename(file, file + ".previous");
      }
      await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
    }).catch(() => undefined).finally(() => { --pending; });
  };
  return { record, flush: () => chain };
}
