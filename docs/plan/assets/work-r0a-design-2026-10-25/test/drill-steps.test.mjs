// The 11-15/16 drill is run by a human reading the step tables in
// docs/plan/work-r0a-drill-checklist-2026-11-15.md, while the results land in
// work-r0a-ops-2026-10-25/drill-2026-11-15/verdict.json. Nothing compared the two, and the
// drift that produced is exactly the kind that costs evidence on drill day:
//   * 2026-11-04 whole-file pass: T-31-1..T-31-5 (the conditional #31 shape-transition steps)
//     existed only in the markdown - the operator could run them and had nowhere to record a
//     verdict, so the evidence would have been lost silently.
//   * Same pass: ruling A (2026-11-03) took the C13 master-key rotation out of R0a, but the
//     table still listed C13-1..8 as actions. An executor following the table would have run
//     an offline re-encryption that the code取证 says breaks GCM auth on every stored object.
// So the two files must agree on step ids both ways, the ruling must be visible in the table
// itself, and the template's summary count must be its own length.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKLIST = fileURLToPath(new URL('../../../work-r0a-drill-checklist-2026-11-15.md', import.meta.url));
const VERDICT = fileURLToPath(new URL('../../work-r0a-ops-2026-10-25/drill-2026-11-15/verdict.json', import.meta.url));
const DRILL_README = fileURLToPath(new URL('../../work-r0a-ops-2026-10-25/drill-2026-11-15/README.md', import.meta.url));
const DRILL_DIR = fileURLToPath(new URL('../../work-r0a-ops-2026-10-25/drill-2026-11-15/', import.meta.url));
const EVIDENCE_MARKER = '【落点已对齐';

// Rows of the schedule table start with a date cell, not a step id.
const DATE_CELL = /^\d{2}-\d{2}$/;

const mdRows = (() => {
  const text = readFileSync(CHECKLIST, 'utf8');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*\|/.exec(line);
    if (!match || DATE_CELL.test(match[1]) || match[1] === '步') continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    rows.push({ step: match[1], action: cells[1] ?? '', cells });
  }
  return rows;
})();

const mdSteps = [...new Set(mdRows.map((row) => row.step))];
const verdict = JSON.parse(readFileSync(VERDICT, 'utf8'));
const verdictSteps = verdict.steps.map((row) => row.step);

// S1-R06 is the recovery step this template owns; the checklist writes it as prose in
// section 3 rather than as a table row, so it is intentionally not a markdown step.
const TEMPLATE_ONLY_STEPS = ['S1-R06'];

const EXCLUDED = 'excluded_by_ruling_A';
const mdMarkedExcluded = mdRows
  .filter((row) => row.action.startsWith('**不执行'))
  .map((row) => row.step);
const verdictExcluded = verdict.steps.filter((row) => row.verdict === EXCLUDED).map((row) => row.step);

test('the checklist step tables are parsed at a credible size', () => {
  assert.ok(
    mdSteps.length >= 60,
    `expected at least 60 checklist steps, parsed ${mdSteps.length} - a parser that silently matches nothing would pass every assertion below`,
  );
});

test('every checklist step has a field in verdict.json', () => {
  const missing = mdSteps.filter((step) => !verdictSteps.includes(step));
  assert.deepEqual(missing, [], `verdict.json has no slot for ${missing.join(', ')}`);
});

test('verdict.json lists no step the checklist dropped without saying so', () => {
  const extra = verdictSteps.filter((step) => !mdSteps.includes(step));
  assert.deepEqual(
    extra.sort(),
    [...TEMPLATE_ONLY_STEPS].sort(),
    `steps recorded only in verdict.json (delete them or add them to the checklist): ${extra.join(', ')}`,
  );
});

test('steps ruled out of this drill are marked in the table and in the template alike', () => {
  assert.deepEqual(
    mdMarkedExcluded.sort(),
    verdictExcluded.sort(),
    `table says 不执行 for ${mdMarkedExcluded.join(', ')} but verdict.json marks ${verdictExcluded.join(', ')}`,
  );
  assert.ok(mdMarkedExcluded.length >= 1, 'the ruling-A exclusion set went empty - re-read the 2026-11-03 ruling before removing exclusions');
  assert.ok(!mdMarkedExcluded.includes('C13-0'), 'C13-0 is the audit confirmation ruling A keeps; excluding it would hide the 驱动不存在 finding');
});

test('the drill README names every step family that the checklist uses', () => {
  // That line is how an arriving executor learns which families exist. It was stale on
  // 2026-11-04 (T-31, N01, N03 and S1-1..4 were missing), which is the same class of drift
  // as a step with no recording slot, so it fails instead of being tolerated.
  const familyLine = readFileSync(DRILL_README, 'utf8').split(/\r?\n/).find((line) => line.includes('关联清单')) ?? '';
  assert.ok(familyLine.length > 0, 'drill README lost the 关联清单 line that lists step families');
  const family = (step) => (step.includes('-') ? step.slice(0, step.lastIndexOf('-')) : /^[A-Za-z]+/.exec(step)[0]);
  const missing = [...new Set(mdSteps.map(family))].filter((name) => !familyLine.includes(name));
  assert.deepEqual(missing, [], `drill README step-family line does not mention: ${missing.join(', ')}`);
});

test('verdict.json is self-consistent and every step keeps its recording slots', () => {
  assert.equal(verdict.summary.total, verdict.steps.length, 'summary.total drifted from the number of step fields');
  const required = ['step', 'section', 'verdict', 'ts', 'evidence', 'notes'];
  for (const row of verdict.steps) {
    assert.deepEqual(Object.keys(row).sort(), [...required].sort(), `step ${row.step} has the wrong recording slots`);
    assert.ok(
      row.verdict === null || row.verdict === EXCLUDED,
      `step ${row.step} carries verdict "${row.verdict}" before the drill ran - only null (to fill) or ${EXCLUDED} (ruled out) are allowed`,
    );
    assert.ok(Array.isArray(row.evidence), `step ${row.step}.evidence must be an array of paths`);
    assert.equal(typeof row.notes, 'string', `step ${row.step}.notes must be a string`);
  }
});

test('the drill evidence carrier exists and no instruction still points at the never-created tree', () => {
  // Section 10 of the checklist prescribes drills/2026-11-15-*/verdict.md, a tree that was
  // never created; the shipped carrier is drill-2026-11-15 (verdict.json rows plus
  // attachments/). On drill day the recorder would otherwise file evidence into a directory
  // that does not exist while the sign-off mapping reads a different one.
  for (const required of ['README.md', 'verdict.json', join('attachments', 'README.md')]) {
    assert.ok(existsSync(join(DRILL_DIR, required)), `drill template is missing ${required}`);
  }
  const checklistText = readFileSync(CHECKLIST, 'utf8');
  const mentioning = checklistText.split(/\r?\n/).filter((line) => line.includes('`verdict.md`'));
  assert.ok(mentioning.length >= 1, 'expected the checklist to reference verdict.md at least once - zero matches would make the next assertion vacuous');
  const unaligned = mentioning.filter((line) => !line.includes(EVIDENCE_MARKER));
  assert.deepEqual(
    unaligned.map((line) => line.slice(0, 80)),
    [],
    `instructions still name verdict.md with no landing-spot alignment note (${unaligned.length} lines): an executor would write evidence where nothing reads it back`,
  );
});

test('every step table row carries as many cells as its own header', () => {
  // 2026-11-04: P9 held a sixth cell - an "evidence" column this table does not have - which
  // silently shifted 负责 and 时限 one column right. On drill day that reads as "someone else
  // owns this step, due at the wrong time". Cell count is the one structural property of these
  // tables that prose editing never shows you, so it has to be an assertion.
  const splitCells = (line) => {
    const parts = line.trim().split(/(?<!\\)\|/);
    if (parts[0] === '') parts.shift();
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
  };
  const isDivider = (cells) =>
    cells.length > 0 && cells.every((cell) => /^[\s:|-]+$/.test(cell.replace(/\\\|/g, '')));

  const lines = readFileSync(CHECKLIST, 'utf8').split(/\r?\n/);
  const mismatches = [];
  let tables = 0;
  let table = null;
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (inFence) table = null;
      continue;
    }
    if (inFence) continue;
    if (/^\s*\|/.test(line)) {
      if (table === null) {
        table = { cols: null, start: index + 1 };
        tables += 1;
      }
      const cells = splitCells(line);
      if (isDivider(cells)) continue;
      if (table.cols === null) table.cols = cells.length;
      else if (cells.length !== table.cols) {
        mismatches.push(`table@${table.start} line ${index + 1}: ${cells.length} cells vs header ${table.cols}`);
      }
      continue;
    }
    table = null;
  }
  // Floor: if the parser ever stops seeing tables, the assertion above would pass over nothing.
  assert.ok(tables >= 12, `parsed only ${tables} tables in the checklist - the shape check is looking at the wrong file or the wrong syntax`);
  assert.deepEqual(mismatches, [], `rows that shift the 负责/时限 columns for whoever runs the drill:\n${mismatches.join('\n')}`);
});
