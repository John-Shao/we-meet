import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  adapterCallAllowed,
  entitlementSource,
  hostPayloadAccepted,
  resolveOrg,
  sessionDecision,
  syncDecision,
} from './host-contract.model.mjs';

const contract = JSON.parse(readFileSync(new URL('./host-contract.json', import.meta.url), 'utf8'));
const claims = { subject_id: 'sub_1', org_id: 'org_1', session_revision: 4, verified_at: '2026-10-28T00:00:00Z' };
const verification = { hostAvailable: true, verified: true, revoked: false, ageSeconds: 5, claims };

test('only the Go control plane may call the Host adapter, and only with a verified service identity', () => {
  const ok = adapterCallAllowed(contract, { role: 'go_control_plane', identityVerified: true });
  assert.equal(ok.allowed, true);
  assert.equal(ok.role, 'work_directory');
  assert.equal(ok.writesTables, false);
  assert.equal(adapterCallAllowed(contract, { role: 'go_control_plane', identityVerified: false }).reason, 'service_identity_unverified');
  for (const role of ['node_runtime_parent', 'pi_child_process', 'work_egress', 'frontend']) {
    assert.equal(adapterCallAllowed(contract, { role, identityVerified: true }).reason, 'caller_not_permitted');
  }
  assert.equal(contract.adapter.hostSuppliedRoleFromRequestBody, false);
});

test('session verification is in the request path and fails closed when the Host is unavailable', () => {
  assert.equal(sessionDecision(contract, verification).allow, true);
  assert.equal(sessionDecision(contract, { ...verification, hostAvailable: false }).code, 'session_unverifiable');
  assert.equal(sessionDecision(contract, { ...verification, hostAvailable: false }).failClosed, true);
  assert.equal(contract.sessionVerification.positiveCacheSeconds, 0);
});

test('stale, invalid or revoked sessions are refused for new requests', () => {
  assert.equal(sessionDecision(contract, { ...verification, ageSeconds: 61 }).code, 'session_stale');
  assert.equal(sessionDecision(contract, { ...verification, verified: false }).code, 'session_invalid');
  assert.equal(sessionDecision(contract, { ...verification, revoked: true }).code, 'session_revoked');
  for (const age of [-1, 1.5, null]) {
    assert.equal(sessionDecision(contract, { ...verification, ageSeconds: age }).code, 'session_invalid');
  }
  assert.equal(contract.sessionVerification.revocationIsImmediateForNewRequests, true);
  assert.equal(contract.sessionVerification.inFlightRequestsCancelled, false);
});

test('a missing session claim is a reported gap rather than an assumed value', () => {
  for (const field of contract.sessionVerification.returnedFields) {
    const partial = { ...claims };
    delete partial[field];
    const decision = sessionDecision(contract, { ...verification, claims: partial });
    assert.equal(decision.code, 'host_field_gap');
    assert.equal(decision.field, field);
  }
  assert.equal(contract.failureSemantics.missingFieldIsGapNotGuess, true);
});

test('the organization comes from Host discovery, not from a client-selected id', () => {
  const session = { orgId: 'org_1' };
  assert.equal(resolveOrg(contract, {}, session).orgId, 'org_1');
  assert.equal(resolveOrg(contract, { orgId: 'org_1' }, session).orgId, 'org_1');
  assert.equal(resolveOrg(contract, { orgId: 'org_2' }, session).code, 'org_not_found');
  assert.equal(resolveOrg(contract, {}, { orgId: null }).code, 'org_not_found');
  assert.equal(contract.orgDiscovery.multiOrgSwitchingSupported, false);
});

test('entitlement reads come from the Work projection, and a stale projection blocks new work', () => {
  const live = entitlementSource(contract, { hostAvailable: true, projectionStale: false });
  assert.equal(live.source, 'work_projection');
  assert.equal(live.hostInRequestPath, false);
  assert.equal(live.newWorkAllowed, true);
  const degraded = entitlementSource(contract, { hostAvailable: false, projectionStale: false });
  assert.equal(degraded.readsAllowed, true);
  assert.equal(entitlementSource(contract, { hostAvailable: true, projectionStale: true }).newWorkAllowed, false);
});

test('projection revisions are monotonic and equal revisions with different facts conflict', () => {
  const current = { revision: 5, factsHash: 'h5' };
  assert.equal(syncDecision(contract, current, { mode: 'incremental', revision: 6, factsHash: 'h6' }).apply, true);
  assert.equal(syncDecision(contract, current, { mode: 'incremental', revision: 4, factsHash: 'h4' }).code, 'revision_stale');
  assert.equal(syncDecision(contract, current, { mode: 'incremental', revision: 5, factsHash: 'h5' }).code, 'noop_replay');
  assert.equal(syncDecision(contract, current, { mode: 'incremental', revision: 5, factsHash: 'h9' }).code, 'revision_conflict');
  for (const revision of [-1, 1.5, '6']) {
    assert.equal(syncDecision(contract, current, { mode: 'incremental', revision }).code, 'revision_invalid');
  }
});

test('a full reconcile narrows absent members instead of deleting rows or reviving suspensions', () => {
  const effect = syncDecision(contract, { revision: 5, factsHash: 'h5' }, { mode: 'full', revision: 6, factsHash: 'h6', absentFromSnapshot: true });
  assert.equal(effect.apply, true);
  assert.equal(effect.narrowTo, 'narrow_to_left');
  assert.equal(syncDecision(contract, null, { mode: 'full', revision: 1, deleteRows: true }).code, 'delete_not_permitted');
  const suspended = syncDecision(contract, { revision: 5, factsHash: 'h5', operatorSuspended: true }, { mode: 'full', revision: 6, factsHash: 'h6', facts: { status: 'active' } });
  assert.equal(suspended.code, 'operator_suspended_preserved');
  assert.deepEqual(contract.sync.mode, ['incremental_by_revision', 'periodic_full_reconcile']);
});

test('synchronization writes only through domain commands and never cancels Runs itself', () => {
  const effect = syncDecision(contract, null, { mode: 'incremental', revision: 1, factsHash: 'h1' });
  assert.deepEqual(effect.writesVia, ['work.sync_org_projection', 'work.sync_member_projection']);
  assert.equal(effect.cancelsRuns, false);
  assert.equal(effect.cancelHandledBy, 'ops_cancel_run');
});

test('Host payloads cannot smuggle extra fields, money or notification bodies', () => {
  assert.equal(hostPayloadAccepted(contract, 'Entitlement', { subject_id: 's', work_seat: true, status: 'active', revision: 1 }).accepted, true);
  assert.equal(hostPayloadAccepted(contract, 'Entitlement', { subject_id: 's', work_seat: true, status: 'active', revision: 1, seats_from_tokens: 3 }).reason, 'unexpected_field');
  assert.equal(hostPayloadAccepted(contract, 'Notification', { delivered: true, channel: 'in_app', body: 'text' }).reason, 'unexpected_field');
  assert.equal(hostPayloadAccepted(contract, 'BillingExport', { accepted: true, statement_id: 'st', amount_cents: 100 }).reason, 'unexpected_field');
  assert.equal(hostPayloadAccepted(contract, 'IdentityDirectory', { org_id: 'o', status: 'active', home_region: 'cn-hangzhou', revision: 1 }).reason, 'host_field_gap');
  assert.equal(hostPayloadAccepted(contract, 'Unknown', {}).reason, 'unknown_port');
  assert.equal(contract.failureSemantics.quotaTokensAsSeatsOrMoney, false);
  assert.equal(contract.failureSemantics.notificationBodyFields, false);
});

test('the signed v2 contract adds session and discovery ports but claims no real Host integration', () => {
  assert.deepEqual(contract.newPortsAtSignoff, ['SessionVerifier', 'OrgDiscovery']);
  assert.equal(contract.ports.length, 7);
  assert.equal(contract.approval, 'design_signed');
  assert.equal(contract.evidence, 'design_model_only');
  assert.equal(contract.acceptance.realHostIntegrationVerified, false);
  assert.equal(contract.acceptance.hostFieldGapsClosed, false);
  assert.equal(contract.acceptance.stubHostParityRequired, true);
});
