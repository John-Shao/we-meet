/**
 * R0a admin read adapter (reference).
 *
 * P1-A returns grant rows plus token entitlement. The R0a admin contract is
 * narrower in some fields and wider in others: it needs org role/revision,
 * subject mapping, a cents budget ledger, and async audit-export jobs. This
 * adapter maps only facts that exist; it throws AdminReadGapError instead of
 * inventing a value. That is the whole point — an admin screen must not show a
 * fabricated budget or a seat role the source never returned.
 *
 * It is source-shape documentation plus executable mapping, not a production
 * backend. Wiring it to a real endpoint still requires the platform identity
 * fields and the R0a budget/export stores (C31 remains partial until then).
 */

export const SEAT_ROLES = Object.freeze(['owner', 'admin', 'member', 'viewer']);
export const ORG_STATUSES = Object.freeze(['active', 'suspended', 'archived']);
export const SEAT_STATUSES = Object.freeze(['invited', 'active', 'suspended', 'left']);
export const EXPORT_FORMATS = Object.freeze(['csv', 'json']);

export class AdminReadGapError extends Error {
  constructor({ field, reason, detail = null }) {
    super(`${field}: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'AdminReadGapError';
    this.code = 'admin_read_gap';
    this.field = field;
    this.reason = reason;
    this.detail = detail;
  }
}

function gap(field, reason, detail = null) {
  throw new AdminReadGapError({ field, reason, detail });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function requireString(value, field) {
  if (!isNonEmptyString(value)) gap(field, 'missing_or_invalid_source');
  return value;
}

function requireNonNegativeInteger(value, field) {
  if (!isNonNegativeInteger(value)) gap(field, 'missing_or_invalid_source');
  return value;
}

/**
 * Describes which contract fields the given sources can actually fill.
 * `status`:
 *   supported  - direct value from a declared source
 *   derived    - deterministic mapping from source values
 *   missing    - no source field
 *   incompatible - a source exists but means something else (e.g. tokens)
 */
export function probeAdminSources(sources = {}) {
  const org = sources.org ?? {};
  const summary = sources.seatSummary ?? {};
  const budget = sources.budget ?? {};
  const memberships = sources.memberships ?? {};
  const grants = Array.isArray(sources.grants) ? sources.grants : null;
  const membershipComplete =
    grants !== null &&
    grants.length > 0 &&
    grants.every((grant) => {
      const membership = memberships[grant.user_id];
      return (
        membership &&
        isNonEmptyString(membership.subject_id) &&
        SEAT_ROLES.includes(membership.role) &&
        isNonNegativeInteger(membership.revision)
      );
    });

  const fields = [
    {
      field: 'org_id',
      status: isNonEmptyString(org.org_id) ? 'supported' : 'missing',
      source: 'platform organization context',
    },
    {
      field: 'name',
      status: isNonEmptyString(org.name) ? 'supported' : 'missing',
      source: 'platform organization context',
    },
    {
      field: 'status',
      status: ORG_STATUSES.includes(org.status) ? 'supported' : 'missing',
      source: 'platform organization context (enum normalized by adapter)',
    },
    {
      field: 'execution_enabled',
      status:
        typeof org.execution_enabled === 'boolean' ? 'derived' : 'missing',
      source: 'org kill switch AND platform execution gate',
    },
    {
      field: 'seats.total',
      status: isNonNegativeInteger(summary.total) ? 'supported' : 'missing',
      source: 'new admin read API field; P1-A summary has active/limit only',
    },
    {
      field: 'seats.active',
      status: isNonNegativeInteger(summary.active) ? 'supported' : 'missing',
      source: 'P1-A /grants/summary/ active',
    },
    {
      field: 'budget.limit_cents',
      status: isNonNegativeInteger(budget.limit_cents) ? 'supported' : 'missing',
      source: 'R0a budget ledger',
      note:
        sources.entitlement?.daily_token_budget != null
          ? 'P1-A provides daily_token_budget; tokens are not cents and cannot be converted'
          : undefined,
    },
    {
      field: 'budget.reserved_cents',
      status: isNonNegativeInteger(budget.reserved_cents) ? 'supported' : 'missing',
      source: 'R0a budget ledger',
    },
    {
      field: 'budget.settled_cents',
      status: isNonNegativeInteger(budget.settled_cents) ? 'supported' : 'missing',
      source: 'R0a budget ledger',
    },
    {
      field: 'audit_retention_days',
      status: isNonNegativeInteger(org.audit_retention_days) ? 'supported' : 'missing',
      source: 'R0a policy/organization setting',
    },
    {
      field: 'seat.subject_id',
      status: membershipComplete ? 'supported' : 'missing',
      source: 'platform identity mapping for every grant row',
    },
    {
      field: 'seat.role',
      status: membershipComplete ? 'supported' : 'missing',
      source: 'platform membership role for every grant row',
    },
    {
      field: 'seat.revision',
      status: membershipComplete ? 'supported' : 'missing',
      source: 'platform membership revision for every grant row',
    },
    {
      field: 'seat.work_seat',
      status: grants && grants.length > 0 ? 'derived' : 'missing',
      source: 'P1-A grant enabled + status + membership_state',
    },
    {
      field: 'seat.status',
      status: grants && grants.length > 0 ? 'derived' : 'missing',
      source: 'P1-A grant status + membership_state',
    },
    {
      field: 'audit_export.job',
      status:
        sources.auditExportSource?.kind === 'job_store' ? 'supported' : 'incompatible',
      source:
        sources.auditExportSource?.kind === 'job_store'
          ? 'R0a export job store'
          : 'P1-A is a synchronous CSV stream; no job id/status/one-time URL',
    },
  ];

  const supported = (name) =>
    fields.find((entry) => entry.field === name)?.status === 'supported';
  const derived = (name) =>
    ['supported', 'derived'].includes(
      fields.find((entry) => entry.field === name)?.status,
    );

  return {
    fields,
    ready: {
      overview:
        supported('org_id') &&
        supported('name') &&
        supported('status') &&
        derived('execution_enabled') &&
        supported('seats.total') &&
        supported('seats.active') &&
        supported('budget.limit_cents') &&
        supported('budget.reserved_cents') &&
        supported('budget.settled_cents') &&
        supported('audit_retention_days'),
      seats:
        supported('seat.subject_id') &&
        supported('seat.role') &&
        supported('seat.revision') &&
        derived('seat.work_seat') &&
        derived('seat.status'),
      auditExport: supported('audit_export.job'),
    },
  };
}

/**
 * Maps the contract AdminOverview. `execution_enabled` is the conjunction of
 * the org kill switch and the platform execution gate; an optional
 * `execution_gate` source defaults to "enabled" so the missing input is visible
 * in probeAdminSources rather than silently assumed in the mapping.
 */
export function mapAdminOverview(sources = {}) {
  const org = sources.org ?? {};
  const summary = sources.seatSummary ?? {};
  const budget = sources.budget ?? {};

  requireString(org.org_id, 'org_id');
  requireString(org.name, 'name');
  if (!ORG_STATUSES.includes(org.status)) gap('status', 'missing_or_invalid_source');

  if (typeof org.execution_enabled !== 'boolean') {
    gap('execution_enabled', 'missing_or_invalid_source');
  }
  const gate = org.execution_gate ?? 'enabled';
  if (!['enabled', 'suspended'].includes(gate)) {
    gap('execution_gate', 'missing_or_invalid_source');
  }

  requireNonNegativeInteger(summary.total, 'seats.total');
  requireNonNegativeInteger(summary.active, 'seats.active');
  if (summary.total < summary.active) {
    gap('seats.total', 'inconsistent_source', 'total < active');
  }

  if (
    !isNonNegativeInteger(budget.limit_cents) &&
    sources.entitlement?.daily_token_budget != null
  ) {
    gap(
      'budget.limit_cents',
      'incompatible_source',
      'daily_token_budget is tokens, contract requires cents; no conversion',
    );
  }
  requireNonNegativeInteger(budget.limit_cents, 'budget.limit_cents');
  requireNonNegativeInteger(budget.reserved_cents, 'budget.reserved_cents');
  requireNonNegativeInteger(budget.settled_cents, 'budget.settled_cents');
  if (!isNonEmptyString(budget.currency) || budget.currency.length !== 3) {
    gap('budget.currency', 'missing_or_invalid_source');
  }
  if (budget.reserved_cents + budget.settled_cents > budget.limit_cents) {
    // Reserved + settled may exceed the limit only if the ledger is mid-repair;
    // surfacing it prevents rendering a negative remaining budget as fact.
    gap('budget', 'inconsistent_source', 'reserved + settled > limit');
  }

  requireNonNegativeInteger(org.audit_retention_days, 'audit_retention_days');
  if (org.audit_retention_days < 1) gap('audit_retention_days', 'missing_or_invalid_source');

  return {
    org_id: org.org_id,
    name: org.name,
    status: org.status,
    execution_enabled: org.execution_enabled && gate === 'enabled',
    seats: { total: summary.total, active: summary.active },
    budget: {
      currency: budget.currency,
      limit_cents: budget.limit_cents,
      reserved_cents: budget.reserved_cents,
      settled_cents: budget.settled_cents,
    },
    audit_retention_days: org.audit_retention_days,
  };
}

function mapSeatStatus(grant, membershipState) {
  if (membershipState === 'left') return 'left';
  if (membershipState === 'invited') return 'invited';
  if (membershipState !== 'active') {
    gap('seat.status', 'unknown_membership_state', String(membershipState ?? ''));
  }
  if (['revoked', 'disabled', 'expired'].includes(grant.status)) return 'suspended';
  if (grant.status === 'active' && grant.enabled === true) return 'active';
  gap('seat.status', 'unknown_grant_state', String(grant.status ?? ''));
}

function mapSeat(grant, membership) {
  if (!grant || !isNonEmptyString(grant.user_id)) {
    gap('seat.subject_id', 'missing_or_invalid_source');
  }
  if (!membership) {
    gap(
      'seat.role',
      'missing_or_invalid_source',
      `no membership enrichment for ${grant.user_id}; P1-A grant rows have no role/revision`,
    );
  }
  if (!isNonEmptyString(membership.subject_id)) {
    gap('seat.subject_id', 'missing_or_invalid_source');
  }
  if (!SEAT_ROLES.includes(membership.role)) {
    gap('seat.role', 'missing_or_invalid_source');
  }
  if (!isNonNegativeInteger(membership.revision)) {
    gap('seat.revision', 'missing_or_invalid_source');
  }

  const membershipState = grant.membership_state;
  const status = mapSeatStatus(grant, membershipState);
  const work_seat =
    grant.enabled === true &&
    grant.status === 'active' &&
    membershipState === 'active';

  return {
    subject_id: membership.subject_id,
    role: membership.role,
    work_seat,
    status,
    revision: membership.revision,
  };
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor == null || cursor === '') return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed?.v !== 1 || !isNonNegativeInteger(parsed.offset)) {
      gap('cursor', 'invalid_cursor');
    }
    return parsed.offset;
  } catch (error) {
    if (error instanceof AdminReadGapError) throw error;
    gap('cursor', 'invalid_cursor');
  }
}

/**
 * Maps a page of seats. Missing role/revision fails the whole page instead of
 * returning a row with blanks: the contract has no nullable fields, and the UI
 * must show "source not ready" rather than a half-true permission view.
 */
export function mapSeatPage(sources = {}, { cursor = null, limit = 20 } = {}) {
  const grants = sources.grants;
  const memberships = sources.memberships ?? {};
  if (!Array.isArray(grants)) gap('seats', 'missing_or_invalid_source');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    gap('limit', 'invalid_limit');
  }

  const ordered = [...grants].sort((a, b) => {
    const left = String(a.user_id ?? '');
    const right = String(b.user_id ?? '');
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const offset = decodeCursor(cursor);
  if (offset > ordered.length) gap('cursor', 'invalid_cursor');

  const page = ordered.slice(offset, offset + limit);
  const items = page.map((grant) => mapSeat(grant, memberships[grant.user_id]));
  const nextOffset = offset + items.length;
  return {
    items,
    next_cursor: nextOffset < ordered.length ? encodeCursor(nextOffset) : null,
  };
}

function requireIsoDate(value, field) {
  if (!isNonEmptyString(value)) gap(field, 'missing_or_invalid_source');
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) gap(field, 'missing_or_invalid_source');
  return parsed;
}

/**
 * Creates an audit-export job only when a real job store is provided. A
 * synchronous CSV source cannot satisfy the contract's queued/running/ready
 * lifecycle, so it is rejected rather than wrapped in a fake ready job.
 */
export function createAuditExportJob(request = {}, source = {}, deps = {}) {
  if (!isNonEmptyString(request.client_request_id) ||
      request.client_request_id.length < 8 ||
      request.client_request_id.length > 128) {
    gap('client_request_id', 'missing_or_invalid_source');
  }
  if (!EXPORT_FORMATS.includes(request.format)) {
    gap('format', 'missing_or_invalid_source');
  }
  const from = requireIsoDate(request.from, 'from');
  const to = requireIsoDate(request.to, 'to');
  if (from > to) gap('from', 'inconsistent_source', 'from > to');

  if (source.kind !== 'job_store') {
    gap(
      'audit_export.job',
      'incompatible_source',
      'P1-A serves a synchronous CSV stream; R0a needs a job id, status and one-time download',
    );
  }
  if (typeof deps.createJob !== 'function') {
    gap('audit_export.store', 'not_configured');
  }
  const now = deps.now ? deps.now() : new Date().toISOString();
  const job = deps.createJob({
    client_request_id: request.client_request_id,
    from: request.from,
    to: request.to,
    format: request.format,
    requested_at: now,
  });
  return {
    id: requireString(job?.id, 'audit_export.id'),
    status: job?.status ?? 'queued',
    requested_at: job?.requested_at ?? now,
    ready_at: job?.ready_at ?? null,
    expires_at: job?.expires_at ?? null,
    download_url: job?.download_url ?? null,
  };
}
