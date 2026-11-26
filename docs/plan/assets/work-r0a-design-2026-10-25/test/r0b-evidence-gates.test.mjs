import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCHITECTURE_FILE,
  EXPERIENCE_FILE,
  OUT_OF_SCOPE_RULINGS,
  ROOT,
  allEvidenceIds,
  evidenceGateSource,
  loadIndex,
  requiredGates,
  validateEvidenceIndex,
} from '../r0b-evidence-index.mjs';

const index = loadIndex();
const byId = new Map(index.gates.map((entry) => [entry.id, entry]));
const text = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

test('the shipped R0b evidence index matches both authorities and the tree', () => {
  assert.deepEqual(validateEvidenceIndex(index), []);
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.mapping.mode, 'static-test-symbol-index');
  assert.match(index.mapping.limitation, /does not execute the cited Go\/Rust\/Python suites/);
  assert.equal(index.architectureGateSource, evidenceGateSource());
  assert.ok(text(ARCHITECTURE_FILE).split('\n').includes(index.architectureGateSource));
  assert.ok(text(EXPERIENCE_FILE).split('\n').some((line) => line.startsWith(`| ${index.gates[0].id} /`)));
});

test('architecture section 6.1 yields exactly 29 unique gates with I7 sharing only the named three', () => {
  const gates = requiredGates();
  assert.equal(gates.size, 29);
  assert.deepEqual([...gates.keys()].sort(), [...allEvidenceIds()].sort());
  assert.deepEqual([...gates.keys()].sort(), [...byId.keys()].sort());
  assert.equal(gates.get('EV51'), 'I4');
  assert.equal(gates.get('EV106'), 'I1');
  assert.equal(gates.get('EV107'), 'I1');
  for (const gate of ['I1', 'I2', 'I3', 'I4', 'I5', 'I6']) {
    assert.ok([...gates.values()].includes(gate), `${gate} has no unique EV gate`);
  }
  assert.match(index.architectureGateSource, /与 I1／I4 共用 EV106\/EV107\/EV51/);
});

test('the baseline does not overstate completion', () => {
  const counts = Object.fromEntries(
    ['covered', 'partial', 'not_run', 'out_of_scope'].map((status) => [
      status,
      index.gates.filter((entry) => entry.status === status).length,
    ]),
  );
  assert.deepEqual(counts, { covered: 17, partial: 8, not_run: 0, out_of_scope: 4 });
  for (const entry of index.gates) {
    if (entry.status !== 'not_run') continue;
    assert.deepEqual(entry.evidence, [], `${entry.id} is not_run but claims executable evidence`);
    assert.ok(entry.gaps.length > 0, `${entry.id} is not_run without a gap`);
  }
});

test('the only whole-gate exclusions carry an authoritative ruling verbatim', () => {
  assert.deepEqual(
    index.gates.filter((entry) => entry.status === 'out_of_scope').map((entry) => entry.id).sort(),
    ['EV106', 'EV116', 'EV63', 'EV95'],
  );
  assert.equal(byId.get('EV116').rulingQuote, '选择性云同步移出 R0b 本期');
  assert.equal(byId.get('EV63').rulingQuote, 'S1 设备公网模型入口砍，本机推理用 device_local');
  assert.equal(byId.get('EV95').rulingQuote, 'EV95（recovery 通道）');
  assert.equal(byId.get('EV106').rulingQuote, '本期 Host 不先发 `WorkMemberState`，也不先把 `Membership.work_seat` 转只读；改为在 Membership 之上提供统一适配层。');
  assert.deepEqual([...OUT_OF_SCOPE_RULINGS.keys()].sort(), ['EV106', 'EV116', 'EV63', 'EV95']);
  for (const id of ['EV116', 'EV63', 'EV106']) {
    const entry = byId.get(id);
    assert.ok(text(join(ROOT, entry.ruling)).includes(entry.rulingQuote));
  }
});

test('tampering with the evidence record trips the invariant it is meant to protect', () => {
  const partial = () => structuredClone(byId.get('EV84'));
  const cases = [
    ['drop a required gate', (clone) => clone.gates.splice(0, 1)],
    ['duplicate a gate', (clone) => clone.gates.push(structuredClone(clone.gates[0]))],
    ['invent a gate', (clone) => clone.gates.push({ ...partial(), id: 'EV999', gate: 'I1' })],
    ['name the wrong implementation gate', (clone) => { clone.gates[0].gate = 'I2'; }],
    ['restate the architecture gate line', (clone) => { clone.architectureGateSource = '29 evidence gates'; }],
    ['erase the requirement', (clone) => { clone.gates[0].requirement = ' '; }],
    ['invent a status', (clone) => { clone.gates[0].status = 'probably-fine'; }],
    ['fabricate a test symbol', (clone) => { clone.gates[0].evidence[0].test = 'TestDefinitelyNotInThisFile'; }],
    ['cite a helper instead of a test', (clone) => {
      clone.gates[0].evidence[0] = {
        path: 'src/work/internal/migrate/r0b_resolution_test.go',
        test: 'issueResolutionSigned',
      };
    }],
    ['cite a missing evidence file', (clone) => { clone.gates[0].evidence[0].path = 'src/work/internal/api/gone.go'; }],
    ['escape the repository with an evidence path', (clone) => { clone.gates[0].evidence[0].path = '../outside.go'; }],
    ['call partial complete while keeping a gap', (clone) => { clone.gates[0].status = 'covered'; }],
    ['call partial complete without executable evidence', (clone) => {
      clone.gates[0].status = 'covered';
      clone.gates[0].gaps = [];
      clone.gates[0].evidence = [];
    }],
    ['call partial complete without naming the missing work', (clone) => {
      clone.gates[0].status = 'partial';
      clone.gates[0].gaps = [];
    }],
    ['call partial without any executable evidence', (clone) => { clone.gates[0].evidence = []; }],
    ['call not_run while citing executable evidence', (clone) => { clone.gates[0].status = 'not_run'; }],
    ['call not_run without naming the gap', (clone) => {
      const entry = clone.gates.find((candidate) => candidate.status === 'partial');
      entry.status = 'not_run';
      entry.evidence = [];
      entry.gaps = [];
    }],
    ['exclude a gate without a ruling', (clone) => {
      const entry = clone.gates.find((candidate) => candidate.id === 'EV116');
      entry.ruling = '';
    }],
    ['exclude a gate with a missing ruling file', (clone) => {
      clone.gates.find((candidate) => candidate.id === 'EV116').ruling = 'docs/work/design/no-such-ruling.md';
    }],
    ['exclude a gate without a verbatim ruling quote', (clone) => {
      delete clone.gates.find((candidate) => candidate.id === 'EV116').rulingQuote;
    }],
    ['invent an out-of-scope ruling quote', (clone) => {
      clone.gates.find((candidate) => candidate.id === 'EV116').rulingQuote = 'all evidence is optional';
    }],
    ['exclude a gate with no registered whole-gate ruling', (clone) => {
      const entry = clone.gates.find((candidate) => candidate.id === 'EV118');
      entry.status = 'out_of_scope';
      entry.gaps = [];
      entry.evidence = [];
      entry.ruling = 'docs/work/design/work-r0b-architecture-2026-10-30.md';
      entry.rulingQuote = 'S1 设备公网模型入口砍，本机推理用 device_local';
    }],
    ['keep implementation gaps on an excluded gate', (clone) => {
      clone.gates.find((candidate) => candidate.id === 'EV116').gaps.push('not implemented');
    }],
  ];
  for (const [label, tamper] of cases) {
    const clone = structuredClone(index);
    tamper(clone);
    assert.ok(validateEvidenceIndex(clone).length > 0, `tamper passed unnoticed: ${label}`);
  }
  assert.equal(cases.length, 23);
});

test('every evidence citation resolves to a real file and exact test symbol', () => {
  const citations = index.gates.flatMap((entry) => entry.evidence);
  assert.ok(citations.length >= 40, `only ${citations.length} executable citations mapped`);
  for (const citation of citations) assert.equal(typeof citation.test, 'string');
});
