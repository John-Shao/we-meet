/**
 * Work R0a Host port contracts (ADR-0021).
 *
 * Work Core talks to the surrounding product only through these five ports:
 * IdentityDirectory, Entitlement, Notification, BillingExport, ConnectorProvider.
 * R0a ships a WeMeet adapter; a standalone build swaps in its own IdP/SMTP/billing
 * implementation without touching Work tables or domain commands.
 *
 * This module is the executable shape of that boundary: it declares required
 * methods, validates the values that cross the boundary, and refuses
 * implementations that leak extra unspecified fields or omit required ones.
 * It is a design asset, not a production package: no network, no database.
 */

export const HOST_PORT_VERSION = 'r0a-host-v1';

export const PORT_NAMES = Object.freeze([
  'IdentityDirectory',
  'Entitlement',
  'Notification',
  'BillingExport',
  'ConnectorProvider',
]);

const ID = { type: 'string', minLength: 1, maxLength: 128 };
const ORG_ID = { type: 'string', minLength: 1, maxLength: 128 };
const REVISION = { type: 'integer', minimum: 0 };
const ORG_STATUSES = Object.freeze(['active', 'suspended', 'archived']);
const MEMBER_STATUSES = Object.freeze(['invited', 'active', 'suspended', 'left']);
const MEMBER_ROLES = Object.freeze(['owner', 'admin', 'member', 'viewer']);

/**
 * Port method contracts. `returns` describes the value Work is allowed to
 * consume; anything missing is a gap the adapter must report, and anything
 * extra is rejected so a Host cannot smuggle WeMeet-shaped fields into Work.
 */
export const PORT_CONTRACTS = Object.freeze({
  IdentityDirectory: {
    getOrganization: {
      args: ['orgId'],
      returns: {
        required: ['org_id', 'name', 'status', 'home_region', 'revision'],
        types: {
          org_id: ORG_ID,
          name: { type: ['string', 'null'], maxLength: 128 },
          status: { type: 'string', enum: ORG_STATUSES },
          home_region: { type: 'string', pattern: '^[a-z0-9-]{3,64}$' },
          revision: REVISION,
        },
      },
    },
    listMemberships: {
      args: ['orgId'],
      returns: {
        array: {
          required: ['subject_id', 'status', 'role', 'revision'],
          types: {
            subject_id: ID,
            status: { type: 'string', enum: MEMBER_STATUSES },
            role: { type: 'string', enum: MEMBER_ROLES },
            revision: REVISION,
          },
        },
      },
    },
    resolveSubject: {
      args: ['sessionRef'],
      returns: {
        nullable: true,
        required: ['subject_id', 'org_id', 'is_admin'],
        types: {
          subject_id: ID,
          org_id: ORG_ID,
          is_admin: { type: 'boolean' },
        },
      },
    },
  },
  Entitlement: {
    getWorkSeat: {
      args: ['orgId', 'subjectId'],
      returns: {
        required: ['subject_id', 'work_seat', 'status', 'revision'],
        types: {
          subject_id: ID,
          work_seat: { type: 'boolean' },
          status: { type: 'string', enum: MEMBER_STATUSES },
          revision: REVISION,
        },
      },
    },
    getOrgCeiling: {
      args: ['orgId'],
      returns: {
        required: ['org_id', 'seats_total', 'seats_used', 'work_enabled'],
        types: {
          org_id: ORG_ID,
          seats_total: { type: 'integer', minimum: 0 },
          seats_used: { type: 'integer', minimum: 0 },
          work_enabled: { type: 'boolean' },
        },
      },
    },
  },
  Notification: {
    deliver: {
      args: ['message'],
      returns: {
        required: ['delivered', 'channel'],
        types: {
          delivered: { type: 'boolean' },
          channel: { type: 'string', enum: ['in_app', 'email', 'webhook'] },
        },
      },
    },
  },
  BillingExport: {
    // 只导出「哪个主体在哪个周期用了多少 token」的请求；费用计算在 Work 之外，
    // Host 只接收 Work 生成的用量文件引用，不得要求 Work 交出金额。
    submitUsageStatement: {
      args: ['statement'],
      returns: {
        required: ['accepted', 'statement_id'],
        types: {
          accepted: { type: 'boolean' },
          statement_id: { type: ['string', 'null'], maxLength: 128 },
        },
      },
    },
  },
  ConnectorProvider: {
    listDescriptors: {
      args: ['orgId'],
      returns: {
        array: {
          required: ['key', 'version', 'auth_kind', 'statuses'],
          types: {
            key: { type: 'string', pattern: '^[a-z0-9_.-]{3,128}$' },
            version: { type: 'integer', minimum: 1 },
            auth_kind: { type: 'string', enum: ['oauth2', 'api_key', 'internal'] },
            statuses: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
});

export class HostPortError extends Error {
  constructor({ port, method, field, reason, detail = null }) {
    super(`${port}.${method}: ${reason}${field ? ` (${field})` : ''}${detail ? ` [${detail}]` : ''}`);
    this.name = 'HostPortError';
    this.code = 'host_port_error';
    Object.assign(this, { port, method, field, reason, detail });
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, spec, { port, method, field }) {
  const actual = typeOf(value);
  const allowed = Array.isArray(spec.type) ? spec.type : [spec.type];
  if (!allowed.includes(actual)) {
    throw new HostPortError({ port, method, field, reason: 'wrong_type', detail: `${actual}!=${allowed.join('|')}` });
  }
  if (actual === 'string') {
    if (spec.enum && !spec.enum.includes(value)) {
      throw new HostPortError({ port, method, field, reason: 'value_not_allowed', detail: value });
    }
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      throw new HostPortError({ port, method, field, reason: 'too_short' });
    }
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      throw new HostPortError({ port, method, field, reason: 'too_long' });
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
      throw new HostPortError({ port, method, field, reason: 'pattern_mismatch', detail: spec.pattern });
    }
  }
  if (actual === 'integer' && spec.minimum !== undefined && value < spec.minimum) {
    throw new HostPortError({ port, method, field, reason: 'below_minimum' });
  }
  return true;
}

export function assertContractValue(port, method, value, contract) {
  if (value === null && contract.nullable) return value;
  if (contract.array) {
    if (!Array.isArray(value)) {
      throw new HostPortError({ port, method, field: null, reason: 'expected_array' });
    }
    return value.map((item) => assertContractValue(port, method, item, contract.array));
  }
  if (typeof value !== 'object' || value === null) {
    throw new HostPortError({ port, method, field: null, reason: 'expected_object' });
  }
  for (const field of contract.required) {
    if (!(field in value)) {
      throw new HostPortError({ port, method, field, reason: 'missing_field' });
    }
    const spec = contract.types[field];
    if (!spec) {
      throw new HostPortError({ port, method, field, reason: 'undeclared_field_contract' });
    }
    matchesType(value[field], spec, { port, method, field });
  }
  for (const field of Object.keys(value)) {
    if (!contract.required.includes(field)) {
      throw new HostPortError({ port, method, field, reason: 'unexpected_field' });
    }
  }
  return value;
}

/**
 * Wraps a host implementation so Work only ever sees validated values.
 * Every port in PORT_NAMES must be present and implement every declared method.
 */
export function createHostPorts(implementations) {
  const missing = PORT_NAMES.filter((port) => !implementations[port]);
  if (missing.length > 0) {
    throw new HostPortError({
      port: missing.join(','), method: null, field: null, reason: 'port_not_implemented',
    });
  }
  const wrapped = {};
  for (const port of PORT_NAMES) {
    const impl = implementations[port];
    const methods = PORT_CONTRACTS[port];
    const view = {};
    for (const [method, contract] of Object.entries(methods)) {
      if (typeof impl[method] !== 'function') {
        throw new HostPortError({ port, method, field: null, reason: 'method_not_implemented' });
      }
      view[method] = async (...args) => {
        if (args.length !== contract.args.length) {
          throw new HostPortError({ port, method, field: null, reason: 'arity_mismatch' });
        }
        const value = await impl[method](...args);
        return assertContractValue(port, method, value, contract.returns);
      };
    }
    for (const key of Object.keys(impl)) {
      if (!(key in methods)) {
        throw new HostPortError({ port, method: key, field: null, reason: 'method_not_in_contract' });
      }
    }
    wrapped[port] = Object.freeze(view);
  }
  return Object.freeze({ version: HOST_PORT_VERSION, ports: wrapped });
}

export function portMethods(port) {
  return Object.freeze(Object.keys(PORT_CONTRACTS[port]));
}

export const MEMBER_STATUS_SET = MEMBER_STATUSES;
export const MEMBER_ROLE_SET = MEMBER_ROLES;
export const ORG_STATUS_SET = ORG_STATUSES;
