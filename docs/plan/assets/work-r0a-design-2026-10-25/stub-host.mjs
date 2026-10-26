/**
 * Stub Host for the standalone Work product (ADR-0021 extraction evidence).
 *
 * It implements the same five ports with plain local data — a small directory,
 * a seat table, an outbox-shaped notifier, a billing sink and a connector
 * catalogue. Its existence is the executable argument that Work does not need
 * WeMeet: the projection payload it produces is identical in shape to the
 * WeMeet adapter's, and it touches no WeMeet concept or table.
 *
 * R0a scope: design asset + local run only (the real extraction drill is R1).
 */

import { createHostPorts } from './host-ports.mjs';

export function createStubHost(initial = {}) {
  const state = {
    orgs: new Map(initial.orgs ?? []),
    members: new Map(initial.members ?? []),
    seats: new Map(initial.seats ?? []),
    connectors: initial.connectors ?? [],
    delivered: [],
    statements: [],
  };

  const identity = {
    async getOrganization(orgId) {
      const org = state.orgs.get(orgId);
      if (!org) return null;
      return { ...org };
    },
    async listMemberships(orgId) {
      return [...state.members.values()]
        .filter((row) => row.org_id === orgId)
        .map((row) => ({
          subject_id: row.subject_id,
          status: row.status,
          role: row.role,
          revision: row.revision,
        }));
    },
    async resolveSubject(sessionRef) {
      const row = state.members.get(sessionRef);
      if (!row) return null;
      return {
        subject_id: row.subject_id,
        org_id: row.org_id,
        is_admin: row.role === 'owner' || row.role === 'admin',
      };
    },
  };

  const entitlement = {
    async getWorkSeat(orgId, subjectId) {
      const member = state.members.get(subjectId);
      if (!member || member.org_id !== orgId) {
        return { subject_id: subjectId, work_seat: false, status: 'left', revision: 0 };
      }
      const seat = state.seats.get(subjectId);
      return {
        subject_id: subjectId,
        work_seat: seat?.work_seat ?? false,
        status: member.status,
        revision: Math.max(member.revision, seat?.revision ?? 0),
      };
    },
    async getOrgCeiling(orgId) {
      const members = [...state.members.values()].filter((row) => row.org_id === orgId);
      return {
        org_id: orgId,
        seats_total: members.length,
        seats_used: members.filter((row) => state.seats.get(row.subject_id)?.work_seat).length,
        work_enabled: state.orgs.get(orgId)?.status === 'active',
      };
    },
  };

  const notification = {
    async deliver(message) {
      state.delivered.push({ channel: message.channel, subject_id: message.subject_id, kind: message.kind });
      return { delivered: true, channel: message.channel };
    },
  };

  const billingExport = {
    async submitUsageStatement(statement) {
      state.statements.push(statement);
      return { accepted: true, statement_id: `stub-${statement.period_id}` };
    },
  };

  const connectorProvider = {
    async listDescriptors() {
      return state.connectors.map((row) => ({ ...row }));
    },
  };

  return {
    state,
    host: createHostPorts({
      IdentityDirectory: identity,
      Entitlement: entitlement,
      Notification: notification,
      BillingExport: billingExport,
      ConnectorProvider: connectorProvider,
    }),
  };
}

export const STUB_FIXTURE = {
  orgs: [[
    'acme',
    {
      org_id: 'acme',
      name: 'Acme 独立版',
      status: 'active',
      home_region: 'cn-north',
      revision: 1,
    },
  ]],
  members: [
    ['acme-owner', {
      org_id: 'acme', subject_id: 'acme-owner', status: 'active', role: 'owner', revision: 1,
    }],
    ['acme-admin', {
      org_id: 'acme', subject_id: 'acme-admin', status: 'active', role: 'admin', revision: 1,
    }],
    ['acme-guest', {
      org_id: 'acme', subject_id: 'acme-guest', status: 'left', role: 'member', revision: 2,
    }],
  ],
  seats: [
    ['acme-owner', { work_seat: true, revision: 1 }],
    ['acme-admin', { work_seat: true, revision: 1 }],
    ['acme-guest', { work_seat: false, revision: 2 }],
  ],
  connectors: [
    { key: 'work.docs', version: 1, auth_kind: 'internal', statuses: ['available'] },
  ],
};
