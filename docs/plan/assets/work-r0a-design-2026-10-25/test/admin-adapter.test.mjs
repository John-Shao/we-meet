import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdminReadGapError,
  createAuditExportJob,
  mapAdminOverview,
  mapSeatPage,
  probeAdminSources,
} from '../admin-read-adapter.mjs';

function rawP1a() {
  return {
    org: {
      org_id: 'org-pilot',
      name: '试点组织',
      status: 'active',
      execution_enabled: true,
      audit_retention_days: 365,
    },
    seatSummary: { active: 2, limit: 20, over_limit: false },
    entitlement: { enabled: true, daily_token_budget: 2_000_000, member_limit: 20 },
    grants: [
      {
        user_id: 'u1',
        display_name: '张三',
        enabled: true,
        status: 'active',
        membership_state: 'active',
      },
    ],
    memberships: {},
    auditExportSource: { kind: 'sync_csv' },
  };
}

function enriched() {
  return {
    org: {
      org_id: 'org-pilot',
      name: '试点组织',
      status: 'active',
      execution_enabled: true,
      execution_gate: 'enabled',
      audit_retention_days: 365,
    },
    seatSummary: { total: 4, active: 2, limit: 20, over_limit: false },
    budget: {
      currency: 'CNY',
      limit_cents: 100_000,
      reserved_cents: 1_200,
      settled_cents: 3_400,
    },
    grants: [
      {
        user_id: 'u2',
        display_name: '李四',
        enabled: true,
        status: 'revoked',
        membership_state: 'active',
      },
      {
        user_id: 'u1',
        display_name: '张三',
        enabled: true,
        status: 'active',
        membership_state: 'active',
      },
      {
        user_id: 'u4',
        display_name: '王五',
        enabled: false,
        status: 'disabled',
        membership_state: 'left',
      },
      {
        user_id: 'u3',
        display_name: '赵六',
        enabled: true,
        status: 'active',
        membership_state: 'invited',
      },
    ],
    memberships: {
      u1: { subject_id: 'sub-1', role: 'owner', revision: 3 },
      u2: { subject_id: 'sub-2', role: 'admin', revision: 7 },
      u3: { subject_id: 'sub-3', role: 'member', revision: 0 },
      u4: { subject_id: 'sub-4', role: 'viewer', revision: 12 },
    },
    auditExportSource: { kind: 'job_store' },
  };
}

function expectGap(fn, field, reason) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AdminReadGapError);
    assert.equal(error.field, field);
    if (reason) assert.equal(error.reason, reason);
    return true;
  });
}

test('raw P1-A sources are reported as not ready, not silently mapped', () => {
  const probe = probeAdminSources(rawP1a());
  assert.equal(probe.ready.overview, false);
  assert.equal(probe.ready.seats, false);
  assert.equal(probe.ready.auditExport, false);

  const total = probe.fields.find((entry) => entry.field === 'seats.total');
  assert.equal(total.status, 'missing');
  const role = probe.fields.find((entry) => entry.field === 'seat.role');
  assert.equal(role.status, 'missing');
  const exportField = probe.fields.find(
    (entry) => entry.field === 'audit_export.job',
  );
  assert.equal(exportField.status, 'incompatible');
});

test('token entitlement is not converted into cents', () => {
  const sources = rawP1a();
  sources.seatSummary.total = 2;
  expectGap(
    () => mapAdminOverview(sources),
    'budget.limit_cents',
    'incompatible_source',
  );
});

test('missing seat total is a gap even when P1-A has active/limit', () => {
  const sources = rawP1a();
  sources.budget = {
    currency: 'CNY',
    limit_cents: 1,
    reserved_cents: 0,
    settled_cents: 0,
  };
  expectGap(
    () => mapAdminOverview(sources),
    'seats.total',
    'missing_or_invalid_source',
  );
});

test('missing membership enrichment fails the seat page', () => {
  expectGap(
    () => mapSeatPage(rawP1a()),
    'seat.role',
    'missing_or_invalid_source',
  );
});

test('enriched sources map the exact AdminOverview contract', () => {
  const overview = mapAdminOverview(enriched());
  assert.deepEqual(overview, {
    org_id: 'org-pilot',
    name: '试点组织',
    status: 'active',
    execution_enabled: true,
    seats: { total: 4, active: 2 },
    budget: {
      currency: 'CNY',
      limit_cents: 100_000,
      reserved_cents: 1_200,
      settled_cents: 3_400,
    },
    audit_retention_days: 365,
  });
  assert.deepEqual(Object.keys(overview).sort(), [
    'audit_retention_days',
    'budget',
    'execution_enabled',
    'name',
    'org_id',
    'seats',
    'status',
  ]);
});

test('seat status and work_seat are derived without leaking display names', () => {
  const first = mapSeatPage(enriched(), { limit: 2 });
  assert.deepEqual(first, {
    items: [
      {
        subject_id: 'sub-1',
        role: 'owner',
        work_seat: true,
        status: 'active',
        revision: 3,
      },
      {
        subject_id: 'sub-2',
        role: 'admin',
        work_seat: false,
        status: 'suspended',
        revision: 7,
      },
    ],
    next_cursor: first.next_cursor,
  });
  assert.ok(first.next_cursor);

  const second = mapSeatPage(enriched(), {
    cursor: first.next_cursor,
    limit: 2,
  });
  assert.deepEqual(second, {
    items: [
      {
        subject_id: 'sub-3',
        role: 'member',
        work_seat: false,
        status: 'invited',
        revision: 0,
      },
      {
        subject_id: 'sub-4',
        role: 'viewer',
        work_seat: false,
        status: 'left',
        revision: 12,
      },
    ],
    next_cursor: null,
  });

  const serialized = JSON.stringify([first, second]);
  assert.ok(!serialized.includes('display_name'));
  assert.ok(!serialized.includes('张三'));
  assert.ok(!serialized.includes('李四'));
});

test('invalid role and revision are rejected, not defaulted', () => {
  const base = enriched();
  base.memberships.u1 = { subject_id: 'sub-1', role: 'superadmin', revision: 3 };
  expectGap(
    () => mapSeatPage(base),
    'seat.role',
    'missing_or_invalid_source',
  );

  const negative = enriched();
  negative.memberships.u1 = { subject_id: 'sub-1', role: 'owner', revision: -1 };
  expectGap(
    () => mapSeatPage(negative),
    'seat.revision',
    'missing_or_invalid_source',
  );
});

test('inconsistent seat and budget totals are rejected', () => {
  const seatMismatch = enriched();
  seatMismatch.seatSummary = { total: 1, active: 2 };
  expectGap(
    () => mapAdminOverview(seatMismatch),
    'seats.total',
    'inconsistent_source',
  );

  const budgetMismatch = enriched();
  budgetMismatch.budget = {
    currency: 'CNY',
    limit_cents: 100,
    reserved_cents: 60,
    settled_cents: 60,
  };
  expectGap(
    () => mapAdminOverview(budgetMismatch),
    'budget',
    'inconsistent_source',
  );

  const badCurrency = enriched();
  badCurrency.budget.currency = 'CN';
  expectGap(
    () => mapAdminOverview(badCurrency),
    'budget.currency',
    'missing_or_invalid_source',
  );
});

test('suspended execution gate turns execution_enabled off without lying', () => {
  const sources = enriched();
  sources.org.execution_gate = 'suspended';
  assert.equal(mapAdminOverview(sources).execution_enabled, false);
});

test('pagination rejects invalid limit and cursor', () => {
  expectGap(() => mapSeatPage(enriched(), { limit: 0 }), 'limit', 'invalid_limit');

  expectGap(
    () => mapSeatPage(enriched(), { cursor: 'not-a-cursor' }),
    'cursor',
    'invalid_cursor',
  );

  const two = mapSeatPage(enriched(), { limit: 2 });
  const beyond = Buffer.from(JSON.stringify({ v: 1, offset: 99 })).toString(
    'base64url',
  );
  assert.ok(two.next_cursor);
  expectGap(
    () => mapSeatPage(enriched(), { cursor: beyond }),
    'cursor',
    'invalid_cursor',
  );
});

test('synchronous CSV export cannot pretend to be a job', () => {
  expectGap(
    () =>
      createAuditExportJob(
        {
          client_request_id: 'req-export-0001',
          from: '2026-10-01T00:00:00Z',
          to: '2026-10-25T00:00:00Z',
          format: 'csv',
        },
        { kind: 'sync_csv' },
      ),
    'audit_export.job',
    'incompatible_source',
  );
});

test('job-store export validates the request and returns the contract shape', () => {
  const request = {
    client_request_id: 'req-export-0001',
    from: '2026-10-01T00:00:00Z',
    to: '2026-10-25T00:00:00Z',
    format: 'csv',
  };
  const job = createAuditExportJob(request, { kind: 'job_store' }, {
    now: () => '2026-10-25T10:00:00.000Z',
    createJob: (input) => ({
      id: 'exp-1',
      status: 'queued',
      requested_at: input.requested_at,
    }),
  });
  assert.deepEqual(job, {
    id: 'exp-1',
    status: 'queued',
    requested_at: '2026-10-25T10:00:00.000Z',
    ready_at: null,
    expires_at: null,
    download_url: null,
  });

  expectGap(
    () =>
      createAuditExportJob(
        { ...request, from: '2026-10-26T00:00:00Z' },
        { kind: 'job_store' },
        { createJob: () => ({ id: 'exp-2' }) },
      ),
    'from',
    'inconsistent_source',
  );

  expectGap(
    () =>
      createAuditExportJob(
        { ...request, format: 'xlsx' },
        { kind: 'job_store' },
        { createJob: () => ({ id: 'exp-3' }) },
      ),
    'format',
    'missing_or_invalid_source',
  );
});
