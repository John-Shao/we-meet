import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  errorEnvelope,
  idempotencyOutcome,
  mediaTypeOutcome,
  paginationRequest,
  publicProjection,
  requestIdentity,
  snapshotShape,
} from './d2-prime.model.mjs';

const surface = JSON.parse(readFileSync(new URL('./d2-prime-surface.json', import.meta.url), 'utf8'));
const session = { verified: true, orgId: 'org_1', subjectId: 'sub_1', csrfToken: 'csrf_1' };
const mutation = { session, mutating: true, headers: { 'X-CSRF-Token': 'csrf_1' }, body: { client_request_id: 'r1' } };

test('org and subject come from the verified session, never from the request body', () => {
  const ok = requestIdentity(surface, mutation);
  assert.equal(ok.ok, true);
  assert.equal(ok.orgId, 'org_1');
  assert.equal(ok.assertedBy, 'work.assert_session_subject');
  for (const field of ['org_id', 'subject_id', 'role', 'scopes']) {
    const spoofed = requestIdentity(surface, { ...mutation, body: { ...mutation.body, [field]: 'x' } });
    assert.equal(spoofed.code, 'identity_from_server_only');
    assert.equal(spoofed.status, 400);
  }
});

test('mutations require the single contracted CSRF header name and a verified session', () => {
  assert.equal(surface.session.csrfHeader, 'X-CSRF-Token');
  assert.equal(surface.session.csrfSingleSourceOfTruth, 'contract');
  assert.equal(requestIdentity(surface, { ...mutation, headers: { 'X-XSRF-Token': 'csrf_1' } }).code, 'csrf_invalid');
  assert.equal(requestIdentity(surface, { ...mutation, headers: {} }).status, 403);
  assert.equal(requestIdentity(surface, { ...mutation, session: { verified: false } }).status, 401);
  assert.equal(surface.session.bearerDeclared, false);
});

test('idempotency is scoped to org, subject and operation type with no header key', () => {
  const incoming = { clientRequestId: 'r1', payloadHash: 'h1', scope: { org_id: 'org_1', subject_id: 'sub_1', operation_type: 'submit_task' } };
  assert.equal(idempotencyOutcome(surface, null, incoming).outcome, 'execute');
  assert.equal(idempotencyOutcome(surface, { scope: incoming.scope, payloadHash: 'h1', status: 202 }, incoming).outcome, 'replay');
  const conflict = idempotencyOutcome(surface, { scope: incoming.scope, payloadHash: 'h2', status: 202 }, incoming);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, 'idempotency_key_conflict');
  const otherSubject = { ...incoming, scope: { ...incoming.scope, subject_id: 'sub_2' } };
  assert.equal(idempotencyOutcome(surface, { scope: incoming.scope, payloadHash: 'h1', status: 202 }, otherSubject).outcome, 'execute');
  assert.equal(idempotencyOutcome(surface, null, { ...incoming, clientRequestId: '' }).code, 'client_request_id_required');
  assert.equal(surface.idempotency.headerKeyAccepted, false);
});

test('admin seats and every list use opaque keyset cursors instead of offsets', () => {
  assert.equal(paginationRequest(surface, { limit: 50 }).style, 'keyset');
  assert.equal(paginationRequest(surface, { limit: 50, cursor: 'opaque' }).cursorType, 'opaque_string');
  assert.equal(paginationRequest(surface, { limit: 50, offset: 0 }).code, 'pagination_offset_unsupported');
  assert.equal(paginationRequest(surface, { limit: 50, page: 2 }).code, 'pagination_offset_unsupported');
  for (const limit of [0, 101, 1.5, '50']) {
    assert.equal(paginationRequest(surface, { limit }).code, 'pagination_limit_invalid');
  }
  assert.equal(paginationRequest(surface, { limit: 10, cursor: 7 }).code, 'pagination_cursor_invalid');
  assert.equal(surface.pagination.totalsFromProjectionNotPage, true);
});

test('conflicts must carry current_revision read from the SQL detail, otherwise they degrade', () => {
  const raised = { publicCode: 'version_conflict', status: 409, correlationId: 'c1', currentRevisionFromDetail: 7 };
  const envelope = errorEnvelope(surface, raised);
  assert.equal(envelope.status, 409);
  assert.equal(envelope.current_revision, 7);
  assert.equal(envelope.retryable, false);
  const missing = errorEnvelope(surface, { ...raised, currentRevisionFromDetail: undefined });
  assert.equal(missing.code, 'conflict_detail_missing');
  assert.equal(missing.status, 503);
  assert.equal(surface.conflict.currentRevisionSource, 'sql_detail');
});

test('error mapping is catalog driven and unmapped internals degrade without echoing detail', () => {
  assert.equal(errorEnvelope(surface, { publicCode: 'input_not_found', status: 422, correlationId: 'c2' }).retryable, false);
  assert.equal(errorEnvelope(surface, { sqlstateCode: 'service_degraded', status: 503, correlationId: 'c3' }).retryable, true);
  const unmapped = errorEnvelope(surface, { status: 500, correlationId: 'c4' });
  assert.equal(unmapped.code, 'service_degraded');
  assert.equal(unmapped.status, 503);
  assert.equal(surface.errorMapping.hardcodedStatusInHandlers, false);
  assert.equal(surface.errorMapping.detailEchoedToClient, false);
});

test('transport content type and declared artifact media type have distinct failures', () => {
  assert.equal(mediaTypeOutcome(surface, { transportContentType: 'application/json', declaredMediaType: 'text/markdown' }).code, null);
  const transport = mediaTypeOutcome(surface, { transportContentType: 'text/plain' });
  assert.equal(transport.status, 415);
  assert.equal(transport.code, 'unsupported_media_type');
  const field = mediaTypeOutcome(surface, { transportContentType: 'application/json', declaredMediaType: 'application/pdf' });
  assert.equal(field.status, 422);
  assert.equal(field.code, 'media_type_invalid');
});

test('TaskDetail.snapshot is an explicit closed object with no body or runtime internals', () => {
  const snapshot = {
    snapshot_id: 's1',
    snapshot_revision: 1,
    template: { id: 't1', version: 2 },
    limits: { max_model_calls: 3 },
    permission_mode: 'auto',
    created_at: '2026-10-28T00:00:00Z',
  };
  assert.deepEqual(snapshotShape(surface, snapshot), { ok: true });
  assert.equal(snapshotShape(surface, { ...snapshot, goal: 'text' }).reason, 'forbidden_field');
  assert.equal(snapshotShape(surface, { ...snapshot, request_hash: 'sha256:x' }).reason, 'forbidden_field');
  assert.equal(snapshotShape(surface, { ...snapshot, extra: 1 }).reason, 'undeclared_field');
  const { limits, ...missing } = snapshot;
  assert.equal(snapshotShape(surface, missing).reason, 'missing_field');
  for (const bad of [null, [], 'snapshot']) {
    assert.equal(snapshotShape(surface, bad).reason, 'not_an_object');
  }
  assert.equal(surface.taskDetailSnapshot.freeFormMapAllowed, false);
});

test('runtime identifiers stay internal and unknown results never render as success', () => {
  assert.equal(publicProjection(surface, { display_state: 'awaiting_acceptance' }).acceptable, true);
  const unknown = publicProjection(surface, { resultUnknown: true, display_state: 'completed' });
  assert.equal(unknown.display_state, 'reconciling');
  assert.equal(unknown.acceptable, false);
  for (const field of ['execution_id', 'dispatch_attempt_id', 'request_hash', 'checkpoint_ref', 'receipt_ref']) {
    assert.equal(publicProjection(surface, { display_state: 'running', [field]: 'x' }).reason, 'internal_field_exposed');
  }
  assert.equal(surface.runtimeExposure.internalContractsPublished, false);
});

test('the signed contract resolves the five named open questions without freezing the surface', () => {
  assert.deepEqual(surface.gates.openQuestionsResolvedAtSignoff, [
    'task_detail_snapshot_shape',
    'admin_seats_keyset_cursor_type',
    'conflict_current_revision_source',
    'invalid_media_type_semantics',
    'csrf_header_single_source',
  ]);
  assert.equal(surface.surfaceFrozen, false);
  assert.equal(surface.approval, 'design_signed');
  assert.equal(surface.evidence, 'design_model_only');
  assert.equal(surface.gates.codegenOwner, 'go_control_plane');
  assert.equal(surface.gates.legacyMockAndClientRetired, true);
  assert.equal(surface.gates.driftGateRequired, true);
});
