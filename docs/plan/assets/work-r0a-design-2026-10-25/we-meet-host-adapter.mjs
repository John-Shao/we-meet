/**
 * WeMeet Host adapter for the R0a Work ports (ADR-0021 reference implementation).
 *
 * It shows the only sanctioned coupling between Work and WeMeet: WeMeet answers
 * directory/entitlement/notification/connector questions, and Work writes the
 * answers into its own projection through work.sync_org_projection /
 * work.sync_member_projection. Nothing here reads or writes a WeMeet business
 * table, and nothing here converts WeMeet token quota into a Work cents budget —
 * that ledger belongs to Work (U2 方案 B).
 *
 * Where the current P1-A payload cannot fill a required port field, the adapter
 * raises HostPortError instead of inventing a value; C31 stays open until those
 * fields exist or Work supplies them itself.
 */

import {
  HostPortError,
  createHostPorts,
} from './host-ports.mjs';

const MEMBER_STATE_MAP = {
  active: 'active',
  invited: 'invited',
  pending: 'invited',
  disabled: 'suspended',
  suspended: 'suspended',
  removed: 'left',
  left: 'left',
};

const ORG_STATE_MAP = {
  active: 'active',
  suspended: 'suspended',
  archived: 'archived',
  disabled: 'suspended',
};

function gap(port, method, field, reason, detail = null) {
  throw new HostPortError({ port, method, field, reason, detail });
}

function requireField(port, method, source, field) {
  if (source === null || source === undefined || source[field] === undefined || source[field] === null) {
    gap(port, method, field, 'missing_field');
  }
  return source[field];
}

function mapMemberStatus(port, method, raw) {
  const state = requireField(port, method, raw, 'state');
  const status = MEMBER_STATE_MAP[state];
  if (!status) gap(port, method, 'state', 'value_not_allowed', String(state));
  return status;
}

function mapOrgStatus(port, method, raw) {
  const state = requireField(port, method, raw, 'status');
  const status = ORG_STATE_MAP[state];
  if (!status) gap(port, method, 'status', 'value_not_allowed', String(state));
  return status;
}

/**
 * @param source WeMeet fixtures: { org, memberships, sessions, connectors, notifier }
 *   org:        { id, name?, status, home_region?, revision? }
 *   memberships:[{ org_id, user_id, subject_id?, role, state, work_seat?, revision? }]
 *   sessions:   Map|object of sessionRef -> { user_id, org_id, is_admin }
 *   connectors: [{ key, version, auth_kind, statuses }]
 *   notifier:   { record(message) }
 */
export function createWeMeetHost(source) {
  const membershipsOf = (orgId) =>
    (source.memberships ?? []).filter((row) => row.org_id === orgId);

  const identity = {
    async getOrganization(orgId) {
      const org = source.org?.id === orgId ? source.org : null;
      if (!org) gap('IdentityDirectory', 'getOrganization', 'org', 'unknown_org', orgId);
      return {
        org_id: requireField('IdentityDirectory', 'getOrganization', org, 'id'),
        // P1-A 的组织展示名当前不在租户接口里；没有就返回 null，由管理页显示占位文案。
        name: org.name ?? null,
        status: mapOrgStatus('IdentityDirectory', 'getOrganization', org),
        home_region: requireField('IdentityDirectory', 'getOrganization', org, 'home_region'),
        revision: requireField('IdentityDirectory', 'getOrganization', org, 'revision'),
      };
    },
    async listMemberships(orgId) {
      return membershipsOf(orgId).map((row) => ({
        // Work 只认 subject_id；P1-A 目前只回 user_id 时这里是真实缺口，不猜测映射。
        subject_id: row.subject_id
          ?? gap('IdentityDirectory', 'listMemberships', 'subject_id', 'missing_field', 'p1a_returns_user_id_only'),
        status: mapMemberStatus('IdentityDirectory', 'listMemberships', row),
        role: requireField('IdentityDirectory', 'listMemberships', row, 'role'),
        revision: requireField('IdentityDirectory', 'listMemberships', row, 'revision'),
      }));
    },
    async resolveSubject(sessionRef) {
      const sessions = source.sessions ?? {};
      const row = sessions instanceof Map ? sessions.get(sessionRef) : sessions[sessionRef];
      if (!row) return null;
      return {
        subject_id: requireField('IdentityDirectory', 'resolveSubject', row, 'user_id'),
        org_id: requireField('IdentityDirectory', 'resolveSubject', row, 'org_id'),
        is_admin: Boolean(row.is_admin),
      };
    },
  };

  const entitlement = {
    async getWorkSeat(orgId, subjectId) {
      const row = membershipsOf(orgId).find(
        (candidate) => candidate.subject_id === subjectId || candidate.user_id === subjectId,
      );
      if (!row) {
        gap('Entitlement', 'getWorkSeat', 'membership', 'unknown_subject', subjectId);
      }
      if (typeof row.work_seat !== 'boolean') {
        // 席位必须是布尔事实。P1-A 只有 token 配额，把 tokens_used>0 当席位是伪造。
        gap('Entitlement', 'getWorkSeat', 'work_seat', 'incompatible_source', 'token_quota_only');
      }
      return {
        subject_id: row.subject_id ?? row.user_id,
        work_seat: row.work_seat,
        status: mapMemberStatus('Entitlement', 'getWorkSeat', row),
        revision: requireField('Entitlement', 'getWorkSeat', row, 'revision'),
      };
    },
    async getOrgCeiling(orgId) {
      const rows = membershipsOf(orgId);
      return {
        org_id: orgId,
        seats_total: rows.length,
        seats_used: rows.filter((row) => row.work_seat === true).length,
        work_enabled: source.org?.work_enabled !== false,
      };
    },
  };

  const notification = {
    async deliver(message) {
      if (!message?.channel || !message?.subject_id) {
        gap('Notification', 'deliver', 'message', 'missing_field');
      }
      if (message.channel === 'webhook' && !/^https:\/\//.test(message.url ?? '')) {
        gap('Notification', 'deliver', 'url', 'pattern_mismatch', 'https required');
      }
      const unsafe = Object.keys(message).filter((key) => /body|content|text|goal|title/i.test(key));
      if (unsafe.length > 0) {
        // 通知只带标识与类型：正文留在 Work，不进 Host 通道，也不进对方日志。
        gap('Notification', 'deliver', unsafe[0], 'incompatible_source', 'no_content_allowed');
      }
      // 正文不进 Work 库：适配器只记录渠道与主题，测试据此断言没有正文。
      source.notifier?.record({ channel: message.channel, subject_id: message.subject_id, kind: message.kind });
      return { delivered: true, channel: message.channel };
    },
  };

  const billingExport = {
    async submitUsageStatement(statement) {
      if (!statement?.content_ref || !/^[a-z0-9-]{3,64}$/.test(String(statement.period_id ?? ''))) {
        gap('BillingExport', 'submitUsageStatement', 'statement', 'missing_field');
      }
      if (Array.isArray(statement.fields) && statement.fields.some((field) => /token/i.test(field))) {
        // WeMeet 计费侧不能要求 Work 交出 token 计数；Work 只交 cents 账单引用。
        gap('BillingExport', 'submitUsageStatement', 'fields', 'incompatible_source', 'token_fields');
      }
      return { accepted: true, statement_id: `stmt-${statement.period_id}` };
    },
  };

  const connectorProvider = {
    async listDescriptors(orgId) {
      if (!orgId) gap('ConnectorProvider', 'listDescriptors', 'orgId', 'missing_field');
      return (source.connectors ?? []).map((row) => ({
        key: requireField('ConnectorProvider', 'listDescriptors', row, 'key'),
        version: requireField('ConnectorProvider', 'listDescriptors', row, 'version'),
        auth_kind: requireField('ConnectorProvider', 'listDescriptors', row, 'auth_kind'),
        statuses: requireField('ConnectorProvider', 'listDescriptors', row, 'statuses'),
      }));
    },
  };

  return createHostPorts({
    IdentityDirectory: identity,
    Entitlement: entitlement,
    Notification: notification,
    BillingExport: billingExport,
    ConnectorProvider: connectorProvider,
  });
}

/**
 * The projection payload Work Core accepts — it mirrors the argument lists of
 * work.sync_org_projection / work.sync_member_projection, so the adapter is the
 * only writer and the app/worker roles stay unprivileged.
 */
export async function buildDirectoryProjection(host, orgId) {
  const org = await host.ports.IdentityDirectory.getOrganization(orgId);
  const members = await host.ports.IdentityDirectory.listMemberships(orgId);
  const seats = await Promise.all(members.map((member) => host.ports.Entitlement.getWorkSeat(orgId, member.subject_id)));
  const seatBySubject = new Map(seats.map((seat) => [seat.subject_id, seat]));
  return {
    org: {
      org_id: org.org_id,
      name: org.name,
      status: org.status,
      execution_enabled: org.status === 'active',
      home_region: org.home_region,
      revision: org.revision,
    },
    members: members.map((member) => ({
      org_id: orgId,
      subject_id: member.subject_id,
      status: member.status,
      role: member.role,
      work_seat: seatBySubject.get(member.subject_id)?.work_seat ?? false,
      revision: Math.max(member.revision, seatBySubject.get(member.subject_id)?.revision ?? 0),
    })),
  };
}

/**
 * Entitlement narrowing: a member who lost seat/status must not start new work.
 * Stopping an in-flight run is a domain command (work.request_cancel) issued by
 * the orchestration layer, never a direct table write from this adapter.
 */
export function narrowingHints(previous, next) {
  const before = new Map((previous ?? []).map((row) => [row.subject_id, row]));
  return next
    .filter((row) => {
      const old = before.get(row.subject_id);
      if (!old) return false;
      return (old.work_seat && !row.work_seat)
        || (old.status === 'active' && row.status !== 'active');
    })
    .map((row) => ({
      org_id: row.org_id,
      subject_id: row.subject_id,
      reason: row.status === 'active' ? 'seat_revoked' : 'membership_inactive',
      action: 'request_cancel',
    }));
}
