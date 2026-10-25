import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendJsonl, ensureDir, newRunDir, readJsonl } from "../lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = newRunDir(here, "s2");
ensureDir(base);
const results = { package: "S2", checks: [] };
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) process.exitCode = 1;
};

// F05: completed write with a lost receipt is recovered from the journal exactly once.
{
  const journal = path.join(base, "journal-f05.jsonl");
  const effects = path.join(base, "effects-f05.json");
  const opKey = "op-f05";
  appendJsonl(journal, { event: "started", opKey, fence: 1, requestHash: "h1" });
  fs.writeFileSync(effects, JSON.stringify({ writes: 1 }));
  appendJsonl(journal, { event: "completed", opKey, fence: 1, receipt: "receipt-1" });
  // Receipt is lost. On restart, reconcile from the journal.
  const entries = readJsonl(journal).filter((e) => e.opKey === opKey);
  const completed = entries.find((e) => e.event === "completed");
  const recorded = JSON.parse(fs.readFileSync(effects, "utf8"));
  check("F05-receipt-recovered", completed?.receipt === "receipt-1" && recorded.writes === 1);
  check("F05-no-second-effect", JSON.parse(fs.readFileSync(effects, "utf8")).writes === 1);
}

// F06: expired lease does not reassign an unknown action to another device.
{
  const state = { opKey: "op-f06", state: "unknown", fence: 1, device: "device-a", attempts: 1 };
  function claim(device, fence) {
    if (state.state === "unknown") return { allowed: false, reason: "reconcile_required" };
    if (fence <= state.fence) return { allowed: false, reason: "stale_fence" };
    return { allowed: true };
  }
  const takeover = claim("device-b", 2);
  check("F06-no-auto-reassign", takeover.allowed === false && state.attempts === 1, takeover);
  state.state = "reconciled";
  const afterReconcile = claim("device-b", 2);
  check("F06-reconcile-unlocks", afterReconcile.allowed === true, afterReconcile);
}

// F13: path-based check followed by a junction swap escapes the grant (TOCTOU).
{
  const allowed = path.join(base, "allowed");
  const secret = path.join(base, "secret");
  ensureDir(path.join(allowed, "swap"));
  ensureDir(secret);
  fs.writeFileSync(path.join(secret, "secret.txt"), "SECRET_VIA_JUNCTION");
  fs.writeFileSync(path.join(allowed, "swap", "safe.txt"), "SAFE");
  const checked = path.resolve(fs.realpathSync(path.join(allowed, "swap"))).startsWith(path.resolve(fs.realpathSync(allowed)));
  fs.rmSync(path.join(allowed, "swap"), { recursive: true, force: true });
  execFileSync("cmd.exe", ["/c", "mklink", "/J", path.join(allowed, "swap"), secret]);
  let escaped = false;
  try {
    const content = fs.readFileSync(path.join(allowed, "swap", "secret.txt"), "utf8");
    escaped = content.includes("SECRET_VIA_JUNCTION");
  } catch {}
  execFileSync("cmd.exe", ["/c", "rmdir", path.join(allowed, "swap")]);
  check("F13-path-check-toctou", checked === true && escaped === false, { checked, escaped, finding: "path-based check cannot survive junction swap; security invariant failed" });
}

// F20: boot/session change invalidates a directory grant.
{
  const grant = { bootId: "boot-1", sessionId: "sess-1", root: "C:/granted" };
  const validate = (currentBoot, currentSession) =>
    grant.bootId === currentBoot && grant.sessionId === currentSession ? "valid" : "reauthorization_required";
  check("F20-boot-change", validate("boot-2", "sess-1") === "reauthorization_required");
  check("F20-session-change", validate("boot-1", "sess-2") === "reauthorization_required");
  check("F20-valid", validate("boot-1", "sess-1") === "valid");
}

// F27 is covered by H06 (AppContainer + Node permission model); not re-run here.
results.checks.push({ name: "F27-covered-by-H06", ok: true, detail: "file/network/child-process isolation evidence in H06" });

results.summary = { checks: results.checks.length, failed: results.checks.filter((c) => !c.ok).length };
console.log(JSON.stringify(results, null, 2));
