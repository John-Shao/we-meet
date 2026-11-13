// #49 / J39 audit-scope gate.
//
// The 2026-11-10 card E ruling set the external-audit range as "everything R0b has implemented at
// the moment it triggers". That is only checkable if somebody can name the set, so audit-scope.mjs
// derives it from four authorities in the tree and r0b-audit-scope.json records the result. This
// gate fails when the record no longer matches the tree, when an entry point arrives without a
// classification, or when one of the four derivations goes silent - the last matters because a
// regex that stops matching looks exactly like an audit surface that shrank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARCHITECTURE_FILE,
  CLASSIFICATIONS,
  DEFAULT_CLASSIFICATION,
  DUTY_ROLES,
  SURFACES,
  V2_PREFIX,
  buildManifest,
  chainCommands,
  functionGrants,
  handlerCommands,
  namedAdjudications,
  namedCandidates,
  producerMentions,
  registeredRoutes,
  scopeRule,
  validateAuditScope,
  v2Routes,
} from '../audit-scope.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MANIFEST = join(ROOT, 'docs/plan/assets/work-r0a-design-2026-10-25/r0b-audit-scope.json');
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8').replace(/\r\n/g, '\n'));

// 2026-11-13 readings, kept as floors rather than exact counts: the surface grows when a slice
// lands, and a floor is what tells a real shrink apart from a derivation that stopped matching.
const FLOORS = {
  routes: 40,
  v2: 4,
  chain: 60,
  handler: 4,
  grantFunctions: 200,
  dutyGranted: 2,
  entries: 40,
};

test('the shipped manifest is what the repo produces today', () => {
  assert.deepEqual(manifest, buildManifest(manifest), 'the manifest predates the tree - regenerate it');
  assert.deepEqual(validateAuditScope(manifest), []);
  assert.equal(
    manifest.generatedBy,
    'node docs/plan/assets/work-r0a-design-2026-10-25/audit-scope.mjs --write',
    'the manifest must say how to regenerate itself, and only one command may do it',
  );
});

test('every enumerated entry point is classified and points at a file that exists', () => {
  assert.ok(manifest.entries.length >= FLOORS.entries, `only ${manifest.entries.length} entry points enumerated`);
  const surfaces = SURFACES.map((surface) => manifest.entries.filter((e) => e.surface === surface).length);
  for (const [index, surface] of SURFACES.entries()) {
    assert.ok(surfaces[index] > 0, `the ${surface} derivation contributed nothing to the manifest`);
  }
  for (const entry of manifest.entries) {
    assert.ok(CLASSIFICATIONS.includes(entry.classification), `${entry.name} has no declared class`);
    assert.ok(existsSync(join(ROOT, entry.origin)), `${entry.name} points at ${entry.origin}`);
    if (entry.classification === DEFAULT_CLASSIFICATION) continue;
    const cited = String(entry.decision).match(/docs\/plan\/[^\s,、;；()（）]+\.md/);
    assert.ok(cited, `${entry.name} left the default class without a decision`);
    assert.ok(existsSync(join(ROOT, cited[0])), `${entry.name} cites ${cited[0]}, which is not in the repo`);
  }
  // The default is the whole point of the gate: anything not deliberately moved stays auditable.
  assert.equal(
    manifest.entries.filter((entry) => entry.classification === DEFAULT_CLASSIFICATION).length,
    manifest.entries.length,
    'an entry left the default class; this gate does not decide that, a signed ruling does',
  );
});

test('the four derivations each still have a live producer', () => {
  assert.ok(registeredRoutes().length >= FLOORS.routes, 'the router scan found almost no routes');
  const v2 = new Set(v2Routes().map((route) => `${route.method} ${route.path}`));
  assert.ok(v2.size >= FLOORS.v2, `only ${v2.size} routes under ${V2_PREFIX}`);
  for (const route of [
    'GET /work/v2/admin/local-policy',
    'PATCH /work/v2/admin/local-policy',
    'POST /work/v2/admin/governance-event-cursor',
    'GET /work/v2/runs/{runId}/reconciliations',
  ]) {
    assert.ok(v2.has(route), `${route} is no longer registered`);
  }
  assert.ok(chainCommands().size >= FLOORS.chain, 'the increments scan found almost no R0b functions');
  assert.ok(handlerCommands().size >= FLOORS.handler, 'the v2 handler scan found almost no SQL call sites');
  const grants = functionGrants();
  assert.ok(grants.size >= FLOORS.grantFunctions, 'the tail catalog holds almost no function grants');
  const duty = [...grants].filter(([, roles]) => DUTY_ROLES.some((role) => roles.has(role)));
  assert.ok(duty.length >= FLOORS.dutyGranted, 'no function is EXECUTE-granted to an R0b duty role anymore');

  // Same floors, read back out of the manifest: the derivations are not just alive, they are the
  // rows that are here.
  const names = new Set(manifest.entries.map((entry) => entry.name));
  for (const route of v2) assert.ok(names.has(route), `${route} registered but not enumerated`);
  const derived = new Map(namedAdjudications().map((record) => [record.name, record]));
  for (const [name] of duty) assert.ok(names.has(name), `${name} is granted to a duty role but not enumerated`);
  assert.equal(derived.size, namedCandidates().length, 'the candidate table and the authority text disagree');
});

test('the two #49 names without a producer stay without one, and the scan is not vacuous', () => {
  // Positive control first: the same scan must find things that do exist, or "zero mentions" means
  // nothing.
  assert.ok(producerMentions('consume_governance_events').length > 0, 'the producer scan found no implemented command');
  assert.ok(producerMentions('set_local_policy').length > 0, 'the producer scan found no implemented command');
  for (const token of ['SeedWorkMemberState', 'seed_work_member_state', 'ListGovernanceEvents', 'list_governance_events']) {
    assert.deepEqual(producerMentions(token), [], `${token} now has a producer - #49 said these were unimplemented`);
  }
  const records = new Map(manifest.namedAdjudications.map((record) => [record.name, record]));
  assert.equal(records.get('SeedWorkMemberState').outcome, 'no-producer');
  assert.equal(records.get('ListGovernanceEvents').outcome, 'alias');
  assert.equal(records.get('ListGovernanceEvents').implementation, 'consume_governance_events');
  assert.ok(
    manifest.entries.some((entry) => entry.name === 'consume_governance_events'),
    'the alias points at a command that is not enumerated',
  );
});

test('the scope rule is quoted from the ruling, not restated', () => {
  const ruling = readFileSync(join(ROOT, 'docs/plan/work-r0b-device-plane-weight-decision-2026-11-10.md'), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n');
  assert.ok(
    ruling.includes(manifest.scopeRuleSource),
    'scopeRuleSource is no longer a verbatim line of the 2026-11-10 ruling',
  );
  assert.equal(manifest.scopeRuleSource, scopeRule());
  assert.match(manifest.scopeRuleSource, /范围＝触发那一刻已实现的一切 R0b 新入口/);
  assert.match(manifest.scopeRuleSource, /S1\/S2\/S4\/S11\/S14\/S15/);
  // The candidate list is read out of the architecture sentence, so the sentence has to still be there.
  const gate = readFileSync(ARCHITECTURE_FILE, 'utf8').replace(/\r\n/g, '\n');
  assert.match(gate, /等需独立复核的入口/);
  assert.deepEqual(manifest.namedAdjudications.map((record) => record.name), namedCandidates());
});

test('tampering with the record trips the rule it is supposed to protect', () => {
  const cases = [
    ['drop an entry point', (m) => m.entries.splice(0, 1)],
    [
      'invent a class',
      (m) => {
        m.entries[0].classification = 'fine-i-guess';
      },
    ],
    [
      'leave the default class without a decision',
      (m) => {
        m.entries[0].classification = 'excluded-by-adjudication';
      },
    ],
    [
      'cite a decision document that does not exist',
      (m) => {
        m.entries[0].classification = 'excluded-by-adjudication';
        m.entries[0].decision = 'docs/plan/work-r0b-no-such-decision-2026-11-13.md';
      },
    ],
    [
      'point an entry at a file that is not there',
      (m) => {
        m.entries[0].origin = 'src/work/internal/api/gone.go';
      },
    ],
    [
      'remove the reason an sql entry is callable',
      (m) => {
        m.entries.find((entry) => entry.surface === 'sql-chain').callableBy = [];
      },
    ],
    [
      'keep a stale chain tail',
      (m) => {
        m.chainTip -= 1;
      },
    ],
    [
      'restate the scope rule instead of quoting it',
      (m) => {
        m.scopeRuleSource = m.scopeRuleSource.replace('一切', '全部');
      },
    ],
    [
      'leave a #49 candidate undispositioned',
      (m) => {
        m.namedAdjudications = m.namedAdjudications.filter((record) => record.name !== 'release_restriction');
      },
    ],
    [
      'invent a candidate the authority text does not name',
      (m) => {
        m.namedAdjudications.push({ name: 'something_else', outcome: 'in-scope', holds: true });
      },
    ],
    [
      'keep an adjudication whose own check no longer holds',
      (m) => {
        m.namedAdjudications[0].holds = false;
      },
    ],
  ];
  const caught = [];
  for (const [label, tamper] of cases) {
    const clone = structuredClone(manifest);
    tamper(clone);
    const problems = validateAuditScope(clone);
    assert.ok(problems.length > 0, `tamper passed unnoticed: ${label}`);
    caught.push(label);
  }
  assert.equal(caught.length, cases.length);

  // And the legitimate exception shape must pass, or the only way to satisfy the gate is to delete
  // rows.
  const signed = structuredClone(manifest);
  const [first] = signed.entries;
  first.classification = 'excluded-by-adjudication';
  first.decision = 'docs/plan/work-r0b-device-plane-weight-decision-2026-11-10.md §2 审计闸（J39/#49）';
  assert.deepEqual(validateAuditScope(signed).filter((problem) => problem.startsWith(first.name)), []);
});
