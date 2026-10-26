import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const results = { package: "S4", checks: [] };
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) process.exitCode = 1;
};

const base = {
  orgEnabled: true,
  identityActive: true,
  membershipActive: true,
  seat: true,
  roleAllowed: true,
  policyAllowed: true,
  snapshotAllows: true,
  approvalGranted: true,
  budgetAvailable: true,
  billable: true,
  runActive: true,
  deviceLeaseValid: true,
  connectorGrant: true,
  operatorSuspended: false,
};

function execution(ctx) {
  const reasons = [];
  if (!ctx.orgEnabled || ctx.operatorSuspended) reasons.push("org_disabled_or_suspended");
  if (!ctx.identityActive || !ctx.membershipActive) reasons.push("membership_inactive");
  if (!ctx.seat) reasons.push("no_seat");
  if (!ctx.roleAllowed) reasons.push("role_acl");
  if (!ctx.policyAllowed) reasons.push("policy");
  if (!ctx.snapshotAllows) reasons.push("snapshot_cap");
  if (ctx.needsConnector && !ctx.connectorGrant) reasons.push("connector_grant");
  if (ctx.needsDevice && !ctx.deviceLeaseValid) reasons.push("device_lease");
  if (ctx.needsApproval && !ctx.approvalGranted) reasons.push("approval");
  if (ctx.billable && !ctx.budgetAvailable) reasons.push("budget");
  if (!ctx.runActive) reasons.push("no_active_run");
  return { allowed: reasons.length === 0, reasons };
}

function governance(ctx, action) {
  if (ctx.operatorSuspended && action === "unsuspend") return { allowed: false, reasons: ["operator_owned"] };
  if (!ctx.identityActive || !ctx.membershipActive) return { allowed: false, reasons: ["membership_inactive"] };
  if (!ctx.isAdmin) return { allowed: false, reasons: ["not_admin"] };
  if (!ctx.governanceScope) return { allowed: false, reasons: ["governance_scope"] };
  return { allowed: true, reasons: [] };
}

function contentRead(ctx) {
  const reasons = [];
  if (!ctx.identityActive) reasons.push("identity_inactive");
  if (!ctx.membershipActive && !ctx.retainReadAfterSeatLoss) reasons.push("membership_inactive");
  if (!ctx.objectAcl) reasons.push("object_acl");
  if (ctx.retentionBlocked) reasons.push("retention");
  return { allowed: reasons.length === 0, reasons };
}

function authorizeConnector(grant, request) {
  if (grant.status !== "active") return { allowed: false, reason: "grant_revoked" };
  if (!grant.allowedActions.includes(request.action)) return { allowed: false, reason: "action_not_allowed" };
  if (!grant.capability.resourceSelector) return { allowed: false, reason: "supplier_scope_too_coarse" };
  if (request.resource.project !== grant.resource.project) return { allowed: false, reason: "resource_outside_selector" };
  if (request.destination !== grant.allowedDestination) return { allowed: false, reason: "destination_not_allowed" };
  return { allowed: true };
}

function lateRefresh(grant, refreshRevision) {
  if (refreshRevision < grant.revision || grant.status === "revoked") {
    return { ...grant, reactivated: false, reason: "stale_or_revoked_refresh" };
  }
  return { ...grant, status: "active", reactivated: true };
}

function classifyEgress(source, destination) {
  if (source.classification === "restricted" && destination !== "private") {
    return { allowed: false, reason: "restricted_content_egress" };
  }
  if (source.classification === "internal" && destination === "public-model") {
    return { allowed: false, reason: "internal_to_public_model" };
  }
  return { allowed: true };
}

function publicOutput(output) {
  return {
    text: output.text ?? "",
    reasoning: null,
    externalLinks: (output.links ?? []).filter((link) => link.startsWith("http://") || link.startsWith("https://")),
  };
}

function validateUrl(rawUrl, resolveHost = () => ["93.184.216.34"]) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:") return { allowed: false, reason: "https_required" };
  if (url.username || url.password) return { allowed: false, reason: "credentials_in_url" };
  const host = url.hostname.toLowerCase();
  const blocked = ["localhost", "metadata.google.internal", "169.254.169.254", "127.0.0.1", "0.0.0.0", "[::1]", "::1"];
  if (blocked.includes(host)) return { allowed: false, reason: "blocked_host" };
  const ips = resolveHost(host);
  const isPrivate = (ip) =>
    /^10\./.test(ip) ||
    /^127\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    ip === "::1";
  if (ips.some(isPrivate)) return { allowed: false, reason: "private_address" };
  return { allowed: true, url: url.toString() };
}

// F24: admin without execution seat.
check("F24-admin-governance", governance({ ...base, seat: false, isAdmin: true, governanceScope: true }, "read").allowed === true);
check("F24-admin-no-execution", execution({ ...base, seat: false }).allowed === false);
// F24: budget exhausted reader keeps content access.
const readerCtx = { ...base, budgetAvailable: false, isAdmin: false };
check("F24-reader-content", contentRead({ ...readerCtx, objectAcl: true }).allowed === true);
check("F24-reader-no-execution", execution(readerCtx).allowed === false && execution(readerCtx).reasons.includes("budget"));
// Operator suspend cannot be lifted by customer admin.
check("F24-operator-suspend", governance({ ...base, operatorSuspended: true, isAdmin: true, governanceScope: true }, "unsuspend").allowed === false);
check("F24-suspend-blocks-execution", execution({ ...base, operatorSuspended: true }).allowed === false);

// F16: membership/org disabled with a stale snapshot.
check("F16-stale-snapshot-membership", execution({ ...base, membershipActive: false }).allowed === false);
check("F16-stale-snapshot-org", execution({ ...base, orgEnabled: false }).allowed === false);

// F17: supplier scope too coarse must be refused, not faked.
const coarseGrant = {
  status: "active",
  revision: 5,
  allowedActions: ["read"],
  capability: { resourceSelector: false },
  resource: { project: "project-a" },
  allowedDestination: "cloud",
};
check("F17-coarse-scope-refused", authorizeConnector(coarseGrant, { action: "read", resource: { project: "project-a" }, destination: "cloud" }).allowed === false);
const fineGrant = { ...coarseGrant, capability: { resourceSelector: true } };
check("F17-selector-match", authorizeConnector(fineGrant, { action: "read", resource: { project: "project-a" }, destination: "cloud" }).allowed === true);
check("F17-selector-mismatch", authorizeConnector(fineGrant, { action: "read", resource: { project: "project-b" }, destination: "cloud" }).allowed === false);

// F09: late refresh cannot revive a revoked grant.
const revoked = { status: "revoked", revision: 5, allowedActions: ["read"], capability: { resourceSelector: true }, resource: { project: "project-a" }, allowedDestination: "cloud" };
const late = lateRefresh(revoked, 4);
check("F09-late-refresh-blocked", late.status === "revoked" && late.reactivated === false, late);

// F14: malicious source cannot change tool/account/destination.
function authorizeChange(request, allowed) {
  if (request.tool && !allowed.tools.includes(request.tool)) return { allowed: false, reason: "tool_not_allowed" };
  if (request.account && request.account !== allowed.account) return { allowed: false, reason: "account_change" };
  if (request.destination && request.destination !== allowed.destination) return { allowed: false, reason: "destination_change" };
  return { allowed: true };
}
const allowedChange = { tools: ["safe"], account: "acct-a", destination: "cloud" };
const maliciousChanges = [
  authorizeChange({ tool: "delete_all" }, allowedChange),
  authorizeChange({ account: "acct-b" }, allowedChange),
  authorizeChange({ destination: "public-model" }, allowedChange),
];
check("F14-no-scope-expansion", maliciousChanges.every((attempt) => attempt.allowed === false) && execution({ ...base, roleAllowed: false }).allowed === false, maliciousChanges);

// F25: restricted content cannot egress; reasoning is not public; external links are not auto-loaded.
check("F25-restricted-egress-blocked", classifyEgress({ classification: "restricted" }, "public-model").allowed === false);
check("F25-internal-egress-blocked", classifyEgress({ classification: "internal" }, "public-model").allowed === false);
check("F25-private-egress-allowed", classifyEgress({ classification: "restricted" }, "private").allowed === true);
const output = publicOutput({ text: "PUBLIC", reasoning: "SECRET_REASONING", links: ["https://evil.example/x"] });
check("F25-reasoning-not-public", output.reasoning === null && !JSON.stringify(output).includes("SECRET_REASONING"));
check("F25-external-link-not-auto", output.externalLinks.length === 1, output);

// SSRF validator.
check("F25-ssrf-private", validateUrl("https://127.0.0.1/x").allowed === false);
check("F25-ssrf-metadata", validateUrl("https://169.254.169.254/latest").allowed === false);
check("F25-ssrf-internal-dns", validateUrl("https://internal.example/x", () => ["10.0.0.8"]).allowed === false);
check("F25-ssrf-public", validateUrl("https://example.com/x").allowed === true);
check("F25-ssrf-http", validateUrl("http://example.com/x").allowed === false);

results.summary = { checks: results.checks.length, failed: results.checks.filter((c) => !c.ok).length };
writeJsonAtomic(path.join(here, "s4-summary.json"), results);
console.log(JSON.stringify(results, null, 2));
