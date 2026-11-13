#!/usr/bin/env node
/**
 * R0b audit-scope enumerator (#49 / J39).
 *
 * The 2026-11-10 ruling fixed the audit gate as "everything R0b has implemented at the moment it
 * triggers", which is a rule with no producer: nobody could name the set, so the sentence could not
 * be checked, and the architecture doc still carried it as 待裁. This module derives the set from the
 * repo itself and r0b-audit-scope.json records it, so a new entry point has to be a deliberate edit
 * to an audit list rather than something a reader later discovers was never in scope.
 *
 * Four derivations, each from a different authority in the tree:
 *   http        - routes registered in internal/api/bootstrap.go whose resolved path starts /work/v2.
 *                 §1.4 declares every R0b relative path under that prefix, so the prefix is the
 *                 repo's own marker, not a convention invented here.
 *   sql-chain   - functions created by an increment at or after 0028 (the R0b side of the chain, the
 *                 tip being read from migrations/manifest.json rather than hardcoded) that still hold
 *                 EXECUTE at the tip for a role other than work_owner.
 *   sql-handler - functions a v2 handler actually executes (SELECT work.<fn>), which catches the
 *                 governance commands implemented before 0028 that the chain rule would miss.
 *   sql-duty    - functions EXECUTE-granted to the two R0b duty roles provisioned by
 *                 deploy/ecs/provision-r0b-roles.sh.
 *
 * Regenerate deliberately:
 *   node docs/plan/assets/work-r0a-design-2026-10-25/audit-scope.mjs --write
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const WORK = join(ROOT, 'src', 'work');
const PLAN = join(ROOT, 'docs', 'plan');
const API_DIR = join(WORK, 'internal', 'api');
const MIG_DIR = join(WORK, 'migrations');
export const MANIFEST_PATH = join(HERE, 'r0b-audit-scope.json');
// The 2026-11-10 card E ruling is what makes the audit scope a rule rather than a wish; the manifest
// quotes it verbatim so the gate can tell whether the enumeration still describes that rule.
export const SCOPE_RULE_FILE = join(
  PLAN,
  'work-r0b-device-plane-weight-decision-2026-11-10.md',
);
export const SCOPE_RULE_MARKER = '审计闸（J39/#49）';

// R0b opens its side of the chain after the R0a tail. Anything at or above this increment version is
// R0b-authored SQL; earlier R0b faces are picked up by the handler and duty derivations instead.
export const R0B_CHAIN_START = 28;
export const V2_PREFIX = '/work/v2';
export const DUTY_ROLES = ['work_governance_events', 'work_operator'];
// work_owner owns and defines; a grant to anyone else is a callable surface.
export const OWNER_ROLE = 'work_owner';

const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

function pathConstants() {
  const consts = new Map();
  for (const file of readdirSync(API_DIR).sort()) {
    if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
    const source = readText(join(API_DIR, file));
    for (const match of source.matchAll(/^(?:\t|const\s+)([A-Z][A-Za-z0-9]*)\s*=\s*(.+)$/gm)) {
      consts.set(match[1], { value: match[2].trim(), file });
    }
  }
  const resolve = (name, depth = 0) => {
    const entry = consts.get(name);
    if (!entry) throw new Error(`unresolved path constant: ${name}`);
    if (depth > 8) throw new Error(`path constant cycle: ${name}`);
    if (entry.value.startsWith('"')) return entry.value.slice(1, -1);
    return entry.value
      .split('+')
      .map((part) => {
        const value = part.trim();
        return value.startsWith('"') ? value.slice(1, -1) : resolve(value, depth + 1);
      })
      .join('');
  };
  return { consts, resolve };
}

/** Every mux.HandleFunc registration in the router, with its path constant resolved. */
export function registeredRoutes() {
  const { resolve } = pathConstants();
  const source = readText(join(API_DIR, 'bootstrap.go'));
  const routes = [];
  for (const match of source.matchAll(/mux\.HandleFunc\("([A-Z]+) ?"\s*\+\s*([A-Za-z0-9_.]+)/g)) {
    routes.push({ method: match[1], path: resolve(match[2].split('.').pop()) });
  }
  for (const match of source.matchAll(/mux\.HandleFunc\("([A-Z]+) ([^"+]+)"/g)) {
    routes.push({ method: match[1], path: match[2] });
  }
  const key = (route) => `${route.method} ${route.path}`;
  return routes.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function v2Routes() {
  return registeredRoutes().filter((route) => route.path.startsWith(V2_PREFIX));
}

/** Files that declare a /work/v2 path constant - the handlers behind this audit surface. */
export function v2HandlerFiles() {
  const { consts, resolve } = pathConstants();
  const files = new Set();
  for (const [name, entry] of consts) {
    if (!name.endsWith('Path')) continue;
    if (resolve(name).startsWith(V2_PREFIX)) files.add(entry.file);
  }
  return [...files].sort();
}

/** Commands the v2 handlers execute, resolved straight out of their SQL call sites. */
export function handlerCommands() {
  const found = new Map();
  for (const file of v2HandlerFiles()) {
    const source = readText(join(API_DIR, file));
    for (const match of source.matchAll(/SELECT\s+work\.([a-z_][a-z0-9_]*)\s*\(/gi)) {
      if (!found.has(match[1])) found.set(match[1], file);
    }
  }
  return found;
}

export function migrationManifest() {
  return JSON.parse(readText(join(MIG_DIR, 'manifest.json')));
}

export function tipCatalogEntry() {
  const manifest = migrationManifest();
  const increments = manifest.increments ?? [];
  if (increments.length === 0) throw new Error('manifest lists no increments - nothing to read the chain tail from');
  const tip = increments.reduce((best, item) => (item.version > best.version ? item : best));
  return { tip, catalog: JSON.parse(readText(join(MIG_DIR, tip.catalog))) };
}

/** Function names created by an increment at or after the R0b side of the chain. */
export function chainCommands() {
  const found = new Map();
  for (const file of readdirSync(join(MIG_DIR, 'increments')).sort()) {
    const version = Number(file.slice(0, 4));
    if (!Number.isInteger(version) || version < R0B_CHAIN_START) continue;
    const source = readText(join(MIG_DIR, 'increments', file));
    for (const match of source.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+work\.([a-z_][a-z0-9_]*)/gi)) {
      if (!found.has(match[1])) found.set(match[1], { version, file });
    }
  }
  return found;
}

export function functionGrants() {
  const { catalog } = tipCatalogEntry();
  const grants = new Map();
  for (const grant of catalog.grants ?? []) {
    if (grant.object_type !== 'function' || grant.privilege !== 'EXECUTE') continue;
    const name = String(grant.object).split('(')[0];
    if (!grants.has(name)) grants.set(name, new Set());
    grants.get(name).add(grant.grantee);
  }
  return grants;
}

/** Function bodies as they are in effect at the chain tail - the only place a call edge is authoritative. */
export function catalogFunctions() {
  const { catalog } = tipCatalogEntry();
  const byName = new Map();
  for (const fn of catalog.functions ?? []) byName.set(fn.name, fn);
  return byName;
}

export function scopeRule() {
  const lines = readText(SCOPE_RULE_FILE).split('\n');
  const hits = lines.filter((line) => line.includes(SCOPE_RULE_MARKER));
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one ${SCOPE_RULE_MARKER} line in the ruling file, found ${hits.length} - the audit rule has no single authority text to enumerate against`,
    );
  }
  return hits[0];
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const walk = (dir, accept, out = []) => {
  for (const item of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      // catalogs/ and node_modules/ are generated snapshots, not sources: their embedded comments
      // would read as mentions of a command that was never implemented.
      if (item.name === 'catalogs' || item.name === 'node_modules' || item.name === '.gocache') continue;
      walk(path, accept, out);
    } else if (accept(path)) {
      out.push(path);
    }
  }
  return out;
};

/**
 * Places a command could actually be produced: SQL that defines it, Go or Python that registers or
 * calls it. Comment lines are stripped, because the two spec names in the architecture text are
 * quoted in comments precisely to say they are not implemented yet.
 */
export function producerMentions(token) {
  const files = [
    ...walk(join(WORK, 'migrations'), (p) => p.endsWith('.sql')),
    ...walk(join(WORK, 'internal'), (p) => p.endsWith('.go')),
    ...walk(join(WORK, 'cmd'), (p) => p.endsWith('.go')),
    ...walk(join(ROOT, 'src', 'backend', 'core', 'api'), (p) => p.endsWith('.py')),
  ];
  const mentions = [];
  for (const file of files) {
    const text = readText(file);
    text.split('\n').forEach((line, index) => {
      if (!line.includes(token)) return;
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('--') || code.startsWith('*') || code.startsWith('#')) return;
      mentions.push(`${file.replace(/\\/g, '/')}:${index + 1}`);
    });
  }
  return mentions;
}

/**
 * The enumerated surface. `surface` says which derivation put it here, which is what a reviewer
 * follows to re-check it; an entry can be reached from more than one derivation and the first one
 * named wins, so the list stays one row per entry point.
 */
export function deriveScope() {
  const grants = functionGrants();
  const chain = chainCommands();
  const handlers = handlerCommands();
  const { tip } = tipCatalogEntry();
  const entries = new Map();

  for (const route of v2Routes()) {
    entries.set(`http ${route.method} ${route.path}`, {
      surface: 'http',
      name: `${route.method} ${route.path}`,
      callableBy: ['http'],
      origin: 'src/work/internal/api/bootstrap.go',
    });
  }
  for (const [name, where] of chain) {
    const grantees = [...(grants.get(name) ?? [])].filter((role) => role !== OWNER_ROLE).sort();
    if (grantees.length === 0) continue;
    entries.set(`sql ${name}`, {
      surface: 'sql-chain',
      name,
      callableBy: grantees,
      origin: `src/work/migrations/increments/${where.file}`,
    });
  }
  for (const [name, file] of handlers) {
    if (entries.has(`sql ${name}`)) continue;
    entries.set(`sql ${name}`, {
      surface: 'sql-handler',
      name,
      callableBy: [...(grants.get(name) ?? [])].filter((role) => role !== OWNER_ROLE).sort(),
      origin: `src/work/internal/api/${file}`,
    });
  }
  for (const [name, grantees] of grants) {
    const duty = DUTY_ROLES.filter((role) => grantees.has(role));
    if (duty.length === 0 || entries.has(`sql ${name}`)) continue;
    entries.set(`sql ${name}`, {
      surface: 'sql-duty',
      name,
      callableBy: [...grantees].filter((role) => role !== OWNER_ROLE).sort(),
      origin: `src/work/migrations/${tip.catalog}`,
    });
  }
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The entry points the architecture text itself names when it says they are still 待裁 (#49).
 * Read out of that sentence rather than retyped, so a candidate added to the sentence has to be
 * adjudicated here instead of waiting for a reader to notice it was never in scope.
 */
export const ARCHITECTURE_FILE = join(PLAN, 'work-r0b-architecture-2026-10-30.md');
export const CANDIDATE_SPAN_START = '另登记了';
export const CANDIDATE_SPAN_END = '等需独立复核的入口';

export function implementationGateSentence() {
  const line = readText(ARCHITECTURE_FILE)
    .split('\n')
    .find((candidate) => candidate.includes('实现准入') && candidate.includes(CANDIDATE_SPAN_END));
  if (!line) throw new Error('the 实现准入 sentence that raised #49 is no longer in the architecture text');
  return line;
}

export function namedCandidates() {
  const line = implementationGateSentence();
  const start = line.indexOf(CANDIDATE_SPAN_START);
  const end = line.indexOf(CANDIDATE_SPAN_END);
  if (start < 0 || end < start) throw new Error('the #49 candidate list is not delimited in the 实现准入 sentence');
  const names = new Set();
  for (const match of line.slice(start, end).matchAll(/`([^`]+)`/g)) names.add(match[1]);
  for (const match of line.matchAll(/`(GET|POST|PATCH|PUT|DELETE) (\/work\/v2[^`]*)`/g)) names.add(`${match[1]} ${match[2]}`);
  return [...names].sort();
}

/** Where each named candidate landed once the surface is enumerable, and how that is checked. */
const DISPOSITIONS = {
  advance_governance_event_cursor: {
    outcome: 'in-scope',
    derivedAs: ['sql advance_governance_event_cursor', 'http POST /work/v2/admin/governance-event-cursor'],
  },
  release_restriction: {
    outcome: 'covered-transitively',
    // No role other than work_owner holds EXECUTE at the tail, so the chain rule cannot see it; it is
    // reachable through apply_execution_entitlement, which is in scope. The edge is read from the body
    // that is actually in effect at the tail, not from a call site that a later increment replaced.
    parent: 'apply_execution_entitlement',
  },
  SeedWorkMemberState: {
    outcome: 'no-producer',
    tokens: ['SeedWorkMemberState', 'seed_work_member_state'],
    absentNote: 'src/work/deploy/ecs/provision-r0b-roles.sh says the one-time Host write port is deliberately absent',
  },
  ListGovernanceEvents: {
    outcome: 'alias',
    tokens: ['ListGovernanceEvents', 'list_governance_events'],
    implementation: 'consume_governance_events',
  },
  consume_governance_events: {
    outcome: 'in-scope',
    derivedAs: ['sql consume_governance_events'],
  },
  'PATCH /work/v2/admin/local-policy': {
    outcome: 'in-scope',
    derivedAs: ['http PATCH /work/v2/admin/local-policy', 'sql set_local_policy'],
  },
};

export function namedAdjudications() {
  const derived = deriveScope();
  const keys = new Set(derived.map((entry) => `${entry.surface === 'http' ? 'http' : 'sql'} ${entry.name}`));
  const grants = functionGrants();
  const functions = catalogFunctions();
  const records = [];
  for (const name of namedCandidates()) {
    const disposition = DISPOSITIONS[name];
    if (!disposition) {
      throw new Error(`${name} is named as a #49 candidate in the architecture text but has no disposition here`);
    }
    const record = { name, outcome: disposition.outcome };
    if (disposition.outcome === 'in-scope') {
      record.derivedAs = disposition.derivedAs;
      record.present = disposition.derivedAs.filter((key) => keys.has(key));
      record.holds = record.present.length === disposition.derivedAs.length;
    } else if (disposition.outcome === 'covered-transitively') {
      const parent = functions.get(disposition.parent);
      record.parent = disposition.parent;
      record.callableBy = [...(grants.get(name) ?? [])].filter((role) => role !== OWNER_ROLE).sort();
      record.reachesFromParent = Boolean(parent?.definition?.includes(`work.${name}(`));
      record.parentInScope = keys.has(`sql ${disposition.parent}`);
      record.notIndependentlyCallable = record.callableBy.length === 0 && !keys.has(`sql ${name}`);
      record.holds = record.reachesFromParent && record.parentInScope && record.notIndependentlyCallable;
    } else {
      record.producerMentions = disposition.tokens.map((token) => producerMentions(token));
      record.noProducer = record.producerMentions.every((mentions) => mentions.length === 0);
      if (disposition.implementation) {
        record.implementation = disposition.implementation;
        record.implementedAs = keys.has(`sql ${disposition.implementation}`);
      }
      if (disposition.absentNote) record.absentNote = disposition.absentNote;
      record.holds = record.noProducer && (record.implementedAs ?? true);
    }
    records.push(record);
  }
  return records;
}

export function buildManifest(existing) {
  const { tip } = tipCatalogEntry();
  const derived = deriveScope();
  const previous = new Map((existing?.entries ?? []).map((entry) => [entry.name, entry]));
  return {
    generatedBy: 'node docs/plan/assets/work-r0a-design-2026-10-25/audit-scope.mjs --write',
    chainTip: tip.version,
    chainTipCatalog: tip.catalog,
    entries: derived.map((entry) => {
      const before = previous.get(entry.name);
      return {
        name: entry.name,
        surface: entry.surface,
        origin: entry.origin,
        callableBy: entry.callableBy,
        // Default per the 2026-11-10 ruling: implemented R0b entry points go to the external audit.
        // Anything else has to say which decision moved it, and the gate requires that citation.
        classification: before?.classification ?? 'external-audit-required',
        ...(before?.decision ? { decision: before.decision } : {}),
      };
    }),
    namedAdjudications: namedAdjudications(),
    scopeRule:
      '范围＝触发那一刻已实现的一切 R0b 新入口；本清单由 audit-scope.mjs 从仓库四处权威现读生成，' +
      '新增入口只有两种去向：留在默认的 external-audit-required，或带上具名决策引用改成例外。',
    scopeRuleFile: relative(ROOT, SCOPE_RULE_FILE).replace(/\\/g, '/'),
    scopeRuleSource: scopeRule(),
  };
}

export const SURFACES = ['http', 'sql-chain', 'sql-handler', 'sql-duty'];
export const DEFAULT_CLASSIFICATION = 'external-audit-required';
export const CLASSIFICATIONS = [DEFAULT_CLASSIFICATION, 'excluded-by-adjudication', 'internal-no-audit'];
export const OUTCOMES = ['in-scope', 'covered-transitively', 'alias', 'no-producer'];

/**
 * Why the shipped manifest is still trustworthy: it names exactly what the tree derives today, each
 * entry point points at a file that exists, and each is either in the default audit class or carries
 * a decision citing a real document. Returns messages rather than throwing so a caller can show all
 * of them at once.
 */
export function validateAuditScope(manifest, derived = deriveScope()) {
  const problems = [];
  const entries = manifest?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return ['the manifest enumerates no entry points - a blank audit surface is a broken derivation, not a finding'];
  }
  const manifestNames = new Set(entries.map((entry) => entry.name));
  const derivedNames = new Set(derived.map((entry) => entry.name));
  const unenumerated = [...derivedNames].filter((name) => !manifestNames.has(name));
  const stale = [...manifestNames].filter((name) => !derivedNames.has(name));
  if (unenumerated.length > 0) problems.push(`implemented but not enumerated: ${unenumerated.join(', ')}`);
  if (stale.length > 0) problems.push(`enumerated but no longer derivable from the tree: ${stale.join(', ')}`);
  const names = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) problems.push(`${entry.name}: enumerated twice`);
    names.add(entry.name);
    if (!SURFACES.includes(entry.surface)) {
      problems.push(`${entry.name}: surface ${entry.surface} is not one of ${SURFACES.join('/')}`);
    }
    if (!Array.isArray(entry.callableBy) || entry.callableBy.length === 0) {
      problems.push(`${entry.name}: no callable-by evidence - the derivation that put it here no longer says why`);
    } else if (entry.surface === 'http') {
      if (entry.callableBy[0] !== 'http') problems.push(`${entry.name}: an http entry must name http as its caller`);
    } else if (!entry.callableBy.every((role) => /^work_[a-z_]+$/.test(role))) {
      problems.push(`${entry.name}: callableBy holds something that is not a work role`);
    }
    if (!CLASSIFICATIONS.includes(entry.classification)) {
      problems.push(`${entry.name}: classification ${entry.classification} is not a declared class`);
    } else if (entry.classification !== DEFAULT_CLASSIFICATION) {
      const cited = String(entry.decision ?? '').match(/docs\/plan\/[^\s,、;；()（）]+\.md/);
      if (!cited) {
        problems.push(`${entry.name}: moved out of ${DEFAULT_CLASSIFICATION} without citing a docs/plan decision`);
      } else if (!existsSync(join(ROOT, cited[0]))) {
        problems.push(`${entry.name}: decision cites ${cited[0]}, which is not in the repo`);
      }
    }
    if (!entry.origin) problems.push(`${entry.name}: no origin to re-check`);
    else if (!existsSync(join(ROOT, entry.origin))) {
      problems.push(`${entry.name}: origin ${entry.origin} is not a file in the repo`);
    }
  }
  const { tip } = tipCatalogEntry();
  if (manifest.chainTip !== tip.version) {
    problems.push(`chainTip ${manifest.chainTip} is not the chain tail ${tip.version} - the grants were read from a snapshot nobody applies anymore`);
  }
  if (manifest.chainTipCatalog !== tip.catalog) {
    problems.push(`chainTipCatalog ${manifest.chainTipCatalog} is not the tail catalog ${tip.catalog}`);
  }
  if (manifest.scopeRuleSource !== scopeRule()) {
    problems.push('scopeRuleSource is no longer the ruling line the scope is derived from');
  }
  const records = manifest.namedAdjudications ?? [];
  const candidates = namedCandidates();
  const missing = candidates.filter((name) => !records.some((record) => record.name === name));
  const unlisted = records.map((record) => record.name).filter((name) => !candidates.includes(name));
  if (missing.length > 0) problems.push(`#49 candidates with no disposition: ${missing.join(', ')}`);
  if (unlisted.length > 0) problems.push(`dispositions for names the architecture text no longer lists: ${unlisted.join(', ')}`);
  for (const record of records) {
    if (!OUTCOMES.includes(record.outcome)) problems.push(`${record.name}: outcome ${record.outcome} is not declared`);
    if (record.holds !== true) problems.push(`${record.name}: its own machine check no longer holds (${record.outcome})`);
  }
  return problems;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli && process.argv.includes('--write')) {
  const existing = (() => {
    try {
      return JSON.parse(readText(MANIFEST_PATH));
    } catch {
      return undefined;
    }
  })();
  const manifest = buildManifest(existing);
  const problems = validateAuditScope(manifest);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`PROBLEM ${problem}`);
    console.error(`refused to write ${problems.length} problem(s) into the audit scope manifest`);
    process.exit(1);
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `wrote ${relative(ROOT, MANIFEST_PATH).replace(/\\/g, '/')} entries=${manifest.entries.length}` +
      ` adjudications=${manifest.namedAdjudications.length}` +
      ` unheld=${manifest.namedAdjudications.filter((record) => !record.holds).map((record) => record.name).join(',') || 'none'}`,
  );
} else if (isCli) {
  const derived = deriveScope();
  console.log(`derived entries=${derived.length}`);
  for (const entry of derived) console.log(`  ${entry.surface}\t${entry.name}\t${entry.callableBy.join(',')}`);
  for (const record of namedAdjudications()) {
    console.log(`  adjudication\t${record.name}\t${record.outcome}\tholds=${record.holds}`);
  }
  const committed = existsSync(MANIFEST_PATH) ? JSON.parse(readText(MANIFEST_PATH)) : undefined;
  if (!committed) {
    console.log('  manifest\tMISSING - run with --write');
  } else {
    const problems = validateAuditScope(committed);
    console.log(`  manifest\tentries=${committed.entries?.length ?? 'none'} problems=${problems.length}`);
    for (const problem of problems) console.log(`    PROBLEM ${problem}`);
  }
}
