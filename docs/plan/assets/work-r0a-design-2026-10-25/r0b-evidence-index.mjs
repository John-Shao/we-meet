import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..', '..', '..');
export const ARCHITECTURE_FILE = join(ROOT, 'docs/work/design/work-r0b-architecture-2026-10-30.md');
export const EXPERIENCE_FILE = join(ROOT, 'docs/work/design/work-r0b-experience-validation-2026-10-30.md');
export const INDEX_FILE = join(HERE, 'r0b-evidence-index.json');
export const GATE_MARKER = '**每片的证据门';
export const STATUSES = ['covered', 'partial', 'not_run', 'out_of_scope'];
export const GATES = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7'];
export const OUT_OF_SCOPE_RULINGS = new Map([
  ['EV63', {
    ruling: 'docs/work/design/work-r0b-architecture-2026-10-30.md',
    rulingQuote: 'S1 设备公网模型入口砍，本机推理用 device_local',
  }],
  ['EV95', {
    ruling: 'docs/work/design/work-r0b-b03-reconciliation-carrier-2026-11-10.md',
    rulingQuote: 'EV95（recovery 通道）',
  }],
  ['EV116', {
    ruling: 'docs/work/design/work-r0b-architecture-2026-10-30.md',
    rulingQuote: '选择性云同步移出 R0b 本期',
  }],
]);

const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

function declaresTestSymbol(path, text, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (path.endsWith('.go')) {
    const declaration = new RegExp(`^\\s*func\\s+${escaped}\\s*\\(`, 'm').test(text);
    const subtest = [`t.Run("${symbol}"`, `t.Run(\`${symbol}\``].some((literal) => text.includes(literal));
    return (symbol.startsWith('Test') && declaration) || subtest;
  }
  if (path.endsWith('.rs')) return new RegExp(`^\\s*(?:async\\s+)?fn\\s+${escaped}\\s*\\(`, 'm').test(text);
  if (path.endsWith('.py')) return new RegExp(`^\\s*def\\s+${escaped}\\s*\\(`, 'm').test(text);
  if (/\.(?:mjs|cjs|js|ts|tsx)$/.test(path)) {
    return [`'${symbol}'`, `"${symbol}"`, `\`${symbol}\``].some((literal) => text.includes(literal));
  }
  return text.includes(symbol);
}

export function evidenceGateSource() {
  const lines = readText(ARCHITECTURE_FILE).split('\n');
  const hits = lines.filter((line) => line.includes(GATE_MARKER));
  if (hits.length !== 1) {
    throw new Error(`expected exactly one ${GATE_MARKER} line, found ${hits.length}`);
  }
  return hits[0];
}

function expandEv(text) {
  const ids = [];
  for (const match of text.matchAll(/EV(\d+)(?:[–-]EV?(\d+))?/g)) {
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
      throw new Error(`invalid EV range in ${text}`);
    }
    for (let value = from; value <= to; value += 1) ids.push(`EV${String(value).padStart(2, '0')}`);
  }
  return ids;
}

export function allEvidenceIds() {
  return new Set(expandEv(evidenceGateSource()));
}

export function requiredGates() {
  const source = evidenceGateSource();
  const gates = new Map();
  for (const match of source.matchAll(/(I[1-7])→([^；;]+)/g)) {
    for (const id of expandEv(match[2])) {
      if (gates.has(id)) {
        // I7 reuses these three gates rather than defining new unique EV IDs.
        if (match[1] === 'I7' && ['EV51', 'EV106', 'EV107'].includes(id)) continue;
        throw new Error(`${id} appears in more than one implementation gate`);
      }
      gates.set(id, match[1]);
    }
  }
  return gates;
}

export function loadIndex() {
  return JSON.parse(readText(INDEX_FILE));
}

export function validateEvidenceIndex(index) {
  const problems = [];
  if (!index || !Array.isArray(index.gates)) return ['evidence index has no gates array'];
  if (index.architectureGateSource !== evidenceGateSource()) {
    problems.push('architectureGateSource is not the verbatim §6.1 evidence-gate line');
  }
  const required = requiredGates();
  for (const id of allEvidenceIds()) {
    if (!required.has(id)) problems.push(`${id} appears in the §6.1 gate line without an I1-I6 owner`);
  }
  const seen = new Set();
  for (const entry of index.gates) {
    if (!entry || typeof entry.id !== 'string') {
      problems.push('evidence entry has no id');
      continue;
    }
    if (seen.has(entry.id)) problems.push(`${entry.id} is duplicated`);
    seen.add(entry.id);
    if (!required.has(entry.id)) problems.push(`${entry.id} is not an architecture §6.1 gate`);
    if (entry.gate !== required.get(entry.id)) problems.push(`${entry.id} names the wrong implementation gate`);
    const authorityRows = readText(EXPERIENCE_FILE).split('\n').filter((line) => line.startsWith(`| ${entry.id} /`));
    if (authorityRows.length !== 1) {
      problems.push(`${entry.id} must have exactly one row in the experience-validation authority`);
    }
    if (typeof entry.requirement !== 'string' || !entry.requirement.trim()) problems.push(`${entry.id} has no requirement`);
    if (!STATUSES.includes(entry.status)) problems.push(`${entry.id} has invalid status ${entry.status}`);
    if (!Array.isArray(entry.gaps)) problems.push(`${entry.id} has no gaps array`);
    if (entry.gaps.some((gap) => typeof gap !== 'string' || !gap.trim())) {
      problems.push(`${entry.id} has an empty gap`);
    }
    if (!Array.isArray(entry.evidence)) {
      problems.push(`${entry.id} has no evidence array`);
      continue;
    }
    if (entry.status === 'covered' && entry.gaps.length > 0) problems.push(`${entry.id} is covered but still lists gaps`);
    if (entry.status === 'partial' && entry.evidence.length === 0) {
      problems.push(`${entry.id} is partial without executable evidence; use not_run`);
    }
    if (entry.status === 'not_run' && entry.evidence.length > 0) {
      problems.push(`${entry.id} is not_run but cites executable evidence; use partial`);
    }
    if (['partial', 'not_run'].includes(entry.status) && entry.gaps.length === 0) {
      problems.push(`${entry.id} is ${entry.status} without naming a gap`);
    }
    if (entry.status === 'out_of_scope' && entry.gaps.length > 0) {
      problems.push(`${entry.id} is out_of_scope but still lists implementation gaps`);
    }
    if (entry.status === 'out_of_scope') {
      const expected = OUT_OF_SCOPE_RULINGS.get(entry.id);
      if (!expected) {
        problems.push(`${entry.id} has no registered whole-gate scope ruling`);
      } else if (entry.ruling !== expected.ruling || entry.rulingQuote !== expected.rulingQuote) {
        problems.push(`${entry.id} does not cite its registered whole-gate scope ruling verbatim`);
      } else if (!existsSync(join(ROOT, entry.ruling))) {
        problems.push(`${entry.id} cites missing ruling ${entry.ruling}`);
      } else if (!readText(join(ROOT, entry.ruling)).includes(entry.rulingQuote)) {
        problems.push(`${entry.id} ruling quote is not present in ${entry.ruling}`);
      }
    }
    for (const evidence of entry.evidence) {
      if (!evidence || typeof evidence.path !== 'string' || typeof evidence.test !== 'string') {
        problems.push(`${entry.id} has malformed evidence`);
        continue;
      }
      if (!evidence.path || !evidence.test.trim()) {
        problems.push(`${entry.id} has empty evidence`);
        continue;
      }
      if (/^(?:[A-Za-z]:|[\\/])/.test(evidence.path) || evidence.path.split(/[\\/]/).includes('..')) {
        problems.push(`${entry.id} evidence path is not repository-relative: ${evidence.path}`);
        continue;
      }
      const path = join(ROOT, evidence.path);
      if (!existsSync(path)) {
        problems.push(`${entry.id} cites missing evidence file ${evidence.path}`);
        continue;
      }
      if (!declaresTestSymbol(evidence.path, readText(path), evidence.test)) {
        problems.push(`${entry.id} cites missing test symbol ${evidence.test} in ${evidence.path}`);
      }
    }
    if (entry.status === 'covered' && entry.evidence.length === 0) {
      problems.push(`${entry.id} is covered without executable evidence`);
    }
  }
  for (const id of required.keys()) {
    if (!seen.has(id)) problems.push(`${id} is missing from the evidence index`);
  }
  return problems;
}
