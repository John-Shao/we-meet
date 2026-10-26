/**
 * Host port contract tests (ADR-0021).
 *
 * Proves three things R0a has to keep true:
 *   1. Work only sees validated port values — a Host cannot smuggle extra fields in.
 *   2. The WeMeet adapter reports real P1-A gaps instead of inventing seats,
 *      subject ids or a money budget from token quotas.
 *   3. A standalone stub host answers the same ports and yields the same
 *      projection payload, so Work is extractable without WeMeet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HostPortError, PORT_NAMES, createHostPorts, portMethods } from '../host-ports.mjs';
import { buildDirectoryProjection, createWeMeetHost, narrowingHints } from '../we-meet-host-adapter.mjs';
import { STUB_FIXTURE, createStubHost } from '../stub-host.mjs';

function weMeetSource() {
  return {
  org: { id: 'org1', name: '试点组织', status: 'active', home_region: 'cn-north', revision: 4 },
  memberships: [
    { org_id: 'org1', subject_id: 'user1', role: 'owner', state: 'active', work_seat: true, revision: 3 },
    { org_id: 'org1', subject_id: 'user2', role: 'admin', state: 'active', work_seat: true, revision: 5 },
    { org_id: 'org1', subject_id: 'user3', role: 'member', state: 'removed', work_seat: false, revision: 7 },
  ],
  sessions: { 'cookie:abc': { user_id: 'user2', org_id: 'org1', is_admin: true } },
    connectors: [{ key: 'wemeet.docs', version: 1, auth_kind: 'internal', statuses: ['available'] }],
    notifier: {
      records: [],
      record(row) { this.records.push(row); },
    },
  };
}

test('every host port must be implemented, in full and without extras', () => {
  assert.throws(
    () => createHostPorts({
      IdentityDirectory: {}, Entitlement: {}, Notification: {}, BillingExport: {},
    }),
    (error) => error instanceof HostPortError && error.reason === 'port_not_implemented',
  );
  assert.throws(
    () => createHostPorts({
      IdentityDirectory: { getOrganization: async () => ({}) },
      Entitlement: { getWorkSeat: async () => ({}), getOrgCeiling: async () => ({}) },
      Notification: { deliver: async () => ({}) },
      BillingExport: { submitUsageStatement: async () => ({}) },
      ConnectorProvider: { listDescriptors: async () => [] },
    }),
    (error) => error instanceof HostPortError && error.reason === 'method_not_implemented',
  );

  const full = createWeMeetHost(weMeetSource());
  for (const port of PORT_NAMES) {
    assert.deepEqual(Object.keys(full.ports[port]).sort(), portMethods(port).slice().sort(), port);
  }
  assert.equal(full.version, 'r0a-host-v1');
});

test('port values are validated: missing, unknown and illegal fields all fail', async () => {
  const host = createWeMeetHost(weMeetSource());
  await host.ports.IdentityDirectory.getOrganization('org1');

  const missing = createWeMeetHost({ ...weMeetSource(), org: { id: 'org1', status: 'active' } });
  await assert.rejects(
    missing.ports.IdentityDirectory.getOrganization('org1'),
    (error) => error.reason === 'missing_field' && error.field === 'home_region',
  );

  const badStatus = createWeMeetHost({
    ...weMeetSource(),
    org: { ...weMeetSource().org, status: 'deleted' },
  });
  await assert.rejects(
    badStatus.ports.IdentityDirectory.getOrganization('org1'),
    (error) => error.reason === 'value_not_allowed' && error.field === 'status',
  );

  // Host 不能塞未声明字段进 Work：多给一个 we_meet 私有字段就失败。
  const smuggling = createStubHost({
    orgs: [['acme', {
      org_id: 'acme', name: 'Acme', status: 'active', home_region: 'eu-west', revision: 1, meeting_id: 'm-1',
    }]],
  });
  await assert.rejects(
    smuggling.host.ports.IdentityDirectory.getOrganization('acme'),
    (error) => error.reason === 'unexpected_field' && error.field === 'meeting_id',
  );
});

test('we-meet adapter output feeds work.sync_* projection payloads', async () => {
  const host = createWeMeetHost(weMeetSource());
  const projection = await buildDirectoryProjection(host, 'org1');
  assert.deepEqual(projection.org, {
    org_id: 'org1',
    name: '试点组织',
    status: 'active',
    execution_enabled: true,
    home_region: 'cn-north',
    revision: 4,
  });
  assert.deepEqual(projection.members, [
    { org_id: 'org1', subject_id: 'user1', status: 'active', role: 'owner', work_seat: true, revision: 3 },
    { org_id: 'org1', subject_id: 'user2', status: 'active', role: 'admin', work_seat: true, revision: 5 },
    { org_id: 'org1', subject_id: 'user3', status: 'left', role: 'member', work_seat: false, revision: 7 },
  ]);
  const seat = await host.ports.Entitlement.getWorkSeat('org1', 'user2');
  assert.deepEqual(seat, { subject_id: 'user2', work_seat: true, status: 'active', revision: 5 });
  assert.deepEqual(await host.ports.Entitlement.getOrgCeiling('org1'), {
    org_id: 'org1', seats_total: 3, seats_used: 2, work_enabled: true,
  });
  assert.deepEqual(await host.ports.IdentityDirectory.resolveSubject('cookie:abc'), {
    subject_id: 'user2', org_id: 'org1', is_admin: true,
  });
  assert.equal(await host.ports.IdentityDirectory.resolveSubject('cookie:unknown'), null);
});

test('documented P1-A gaps stay gaps: no subject mapping, no seat boolean, no money budget', async () => {
  const p1aShaped = {
    ...weMeetSource(),
    memberships: [
      { org_id: 'org1', user_id: 'u-1', role: 'member', state: 'active', token_limit: 200000, revision: 1 },
    ],
  };
  const host = createWeMeetHost(p1aShaped);
  await assert.rejects(
    host.ports.IdentityDirectory.listMemberships('org1'),
    (error) => error.reason === 'missing_field'
      && error.field === 'subject_id'
      && error.detail === 'p1a_returns_user_id_only',
  );
  await assert.rejects(
    host.ports.Entitlement.getWorkSeat('org1', 'u-1'),
    (error) => error.reason === 'incompatible_source'
      && error.field === 'work_seat'
      && error.detail === 'token_quota_only',
  );

  const base = weMeetSource();
  const noName = createWeMeetHost({ ...base, org: { ...base.org, name: undefined } });
  const org = await noName.ports.IdentityDirectory.getOrganization('org1');
  assert.equal(org.name, null, '缺组织名时返回 null，由管理页显示占位文案');
});

test('entitlement narrowing is a hint for the domain command, never a table write', () => {
  const previous = [
    { subject_id: 'user1', status: 'active', work_seat: true },
    { subject_id: 'user2', status: 'active', work_seat: true },
    { subject_id: 'user3', status: 'active', work_seat: true },
  ];
  const next = [
    { org_id: 'org1', subject_id: 'user1', status: 'active', work_seat: true },
    { org_id: 'org1', subject_id: 'user2', status: 'active', work_seat: false },
    { org_id: 'org1', subject_id: 'user3', status: 'suspended', work_seat: true },
  ];
  assert.deepEqual(narrowingHints(previous, next), [
    { org_id: 'org1', subject_id: 'user2', reason: 'seat_revoked', action: 'request_cancel' },
    { org_id: 'org1', subject_id: 'user3', reason: 'membership_inactive', action: 'request_cancel' },
  ]);
});

test('stub host answers the same ports, so Work is extractable without we-meet', async () => {
  const { host, state } = createStubHost(STUB_FIXTURE);
  const projection = await buildDirectoryProjection(host, 'acme');
  assert.deepEqual(projection.org, {
    org_id: 'acme',
    name: 'Acme 独立版',
    status: 'active',
    execution_enabled: true,
    home_region: 'cn-north',
    revision: 1,
  });
  assert.equal(projection.members.length, 3);
  assert.deepEqual(
    projection.members.map((row) => [row.subject_id, row.work_seat]),
    [['acme-owner', true], ['acme-admin', true], ['acme-guest', false]],
  );
  assert.equal(JSON.stringify(projection).includes('user_id'), false);
  const delivered = await host.ports.Notification.deliver({
    channel: 'in_app', subject_id: 'acme-admin', kind: 'task.awaiting_acceptance',
  });
  assert.deepEqual(delivered, { delivered: true, channel: 'in_app' });
  assert.deepEqual(state.delivered, [{ channel: 'in_app', subject_id: 'acme-admin', kind: 'task.awaiting_acceptance' }]);
  const statement = await host.ports.BillingExport.submitUsageStatement({
    period_id: '2026-10', content_ref: 'content://acme/usage-2026-10.csv', fields: ['settled_tokens'],
  });
  assert.deepEqual(statement, { accepted: true, statement_id: 'stub-2026-10' });
});

test('notification and billing reject unsafe or out-of-scope requests', async () => {
  const source = weMeetSource();
  const host = createWeMeetHost(source);
  await assert.rejects(
    host.ports.Notification.deliver({ channel: 'webhook', subject_id: 'user1', url: 'http://example.test/hook' }),
    (error) => error.port === 'Notification' && error.field === 'url',
  );
  await assert.rejects(
    host.ports.Notification.deliver({ channel: 'in_app', subject_id: 'user1', body: '任务已完成，正文见链接' }),
    (error) => error instanceof HostPortError,
  );
  await host.ports.Notification.deliver({ channel: 'in_app', subject_id: 'user1', kind: 'task.completed' });
  assert.deepEqual(source.notifier.records, [
    { channel: 'in_app', subject_id: 'user1', kind: 'task.completed' },
  ]);

  await assert.rejects(
    host.ports.BillingExport.submitUsageStatement({
      period_id: '2026-10', content_ref: 'content://org1/usage.csv', fields: ['amount_cents'],
    }),
    (error) => error.port === 'BillingExport' && error.reason === 'incompatible_source',
  );
  const accepted = await host.ports.BillingExport.submitUsageStatement({
    period_id: '2026-10', content_ref: 'content://org1/usage.csv',
    fields: ['input_tokens', 'output_tokens', 'cached_input_tokens', 'run_count'],
  });
  assert.deepEqual(accepted, { accepted: true, statement_id: 'stmt-2026-10' });
});

test('connector descriptors are validated and admin-only reads stay read-only', async () => {
  const host = createWeMeetHost(weMeetSource());
  assert.deepEqual(await host.ports.ConnectorProvider.listDescriptors('org1'), [
    { key: 'wemeet.docs', version: 1, auth_kind: 'internal', statuses: ['available'] },
  ]);
  const broken = createWeMeetHost({
    ...weMeetSource(),
    connectors: [{ key: 'Docs', version: 0, auth_kind: 'basic', statuses: [] }],
  });
  await assert.rejects(
    broken.ports.ConnectorProvider.listDescriptors('org1'),
    (error) => error.port === 'ConnectorProvider' && error.reason === 'pattern_mismatch',
  );
});

test('work runtime never imports the host adapter and the adapter writes no SQL', () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const workFiles = ['mock-server.mjs', 'r0a-client.mjs', 'generate-client.mjs'];
  for (const file of workFiles) {
    const source = read(file);
    assert.ok(!/we-meet-host-adapter|host-ports|stub-host/.test(source), `${file} must not import host adapters`);
    assert.ok(!/\b(public|core|meeting|message)\.[a-z_]+\b/.test(source), `${file} must not name foreign schemas`);
  }
  const adapter = read('we-meet-host-adapter.mjs');
  const stub = read('stub-host.mjs');
  for (const [name, source] of [['adapter', adapter], ['stub', stub]]) {
    assert.ok(!/INSERT INTO|UPDATE\s+work\.|DELETE FROM|RAISE EXCEPTION/.test(source), `${name} writes no SQL`);
  }
  assert.ok(!/meeting|message_|we_meet_session/.test(stub), 'stub host knows nothing about WeMeet');
});
