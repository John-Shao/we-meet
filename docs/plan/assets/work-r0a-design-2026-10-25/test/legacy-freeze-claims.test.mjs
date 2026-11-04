// C29 (2026-11-04): the legacy Work stack was deleted on 2026-10-28, yet several live documents still
// told people to expect it - the cutover plan promised "unchanged legacy behaviour restored" after a
// rollback, the pilot runbook still carried a 180-day read-only retention proposal awaiting legal, and
// the archive page's own copy called legacy tasks "read-only" while showing nothing but the id.
// A restored-behaviour instruction is worse than a stale one: on duty day an operator waits for a state
// that cannot exist. So the corrections are annotated in place (history kept) and this gate stops the
// claims from coming back un-annotated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLAN_DIR = join(HERE, '..', '..', '..');
const LOCALES = join(HERE, '..', '..', '..', '..', '..', 'src', 'frontend', 'src', 'locales');
const MARKER = '2026-11-04';

const DOCS = [
  join(PLAN_DIR, 'work-r0a-pilot-operations-runbook-2026-10-26.md'),
  join(PLAN_DIR, 'work-r0a-host-wire-decision-2026-10-28.md'),
  join(PLAN_DIR, 'work-r0a-frontend-design-2026-10-25.md'),
  join(PLAN_DIR, 'work-r0a-drill-checklist-2026-11-15.md'),
];

// Phrases that would send someone to data or routes that no longer exist.
const DEAD_CLAIMS = [
  /legacy behaviour restored/i,
  /shows legacy page/i,
  /旧数据只读 180 天/,
  /180 天方案或替代/,
];

const cutover = JSON.parse(
  readFileSync(join(HERE, '..', '..', 'work-r0a-ops-2026-10-25', 'cutover-plan.json'), 'utf8'),
);

test('the corpus is really scanned, so a broken pattern cannot pass by matching nothing', () => {
  let seen = 0;
  for (const file of DOCS) {
    const text = readFileSync(file, 'utf8');
    if (/legacy|旧/i.test(text)) seen += 1;
  }
  assert.ok(seen >= 3, `only ${seen} of ${DOCS.length} documents mention legacy/旧 - the scan is looking at the wrong place`);
});

test('every dead legacy claim carries the dated correction on the same line', () => {
  const offenders = [];
  for (const file of DOCS) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!DEAD_CLAIMS.some((pattern) => pattern.test(line))) return;
      if (!line.includes(MARKER)) offenders.push(`${file.split(/[\\/]/).pop()}:${index + 1} ${line.trim().slice(0, 70)}`);
    });
  }
  assert.deepEqual(offenders, [], `instructions that still promise deleted behaviour with no correction on the line:\n${offenders.join('\n')}`);
});

test('the archive notice does not promise read-only access to data that is gone', () => {
  const languages = ['de', 'en', 'fr', 'nl', 'zh'];
  const problems = [];
  for (const language of languages) {
    const work = JSON.parse(readFileSync(join(LOCALES, language, 'work.json'), 'utf8'));
    const notice = (work.archive || {}).legacyNotice;
    if (typeof notice !== 'string' || notice.length === 0) {
      problems.push(`${language}: archive.legacyNotice missing`);
      continue;
    }
    if (!notice.includes('{{task}}')) problems.push(`${language}: placeholder {{task}} lost`);
    if (/read-only|只读|schreibgesch|lecture seule|alleen-lezen/i.test(notice)) {
      problems.push(`${language}: still calls legacy tasks readable`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the cutover plan keeps the old retention status but does not present it as open', () => {
  const retention = cutover.legacy_retention || {};
  // Non-destructive: the original value survives, so the audit trail is intact and the gate checks
  // the pairing rather than demanding the sentence be erased.
  assert.equal(retention.status_before_2026_11_04, 'proposal_pending_legal', 'the pre-correction status must be preserved verbatim');
  assert.notEqual(retention.status, 'proposal_pending_legal', 'status still asks legal to decide a retention period for data that was deleted');
  assert.ok(typeof retention.correction === 'string' && retention.correction.includes(MARKER), 'legacy_retention.correction names the 2026-11-04 finding');
});

test('the rolled_back state does not claim a restorable legacy route without the correction', () => {
  const rolledBack = (cutover.states || {}).rolled_back || {};
  const value = String(rolledBack.legacy_routes || '');
  assert.ok(/unchanged legacy behaviour restored/.test(value), 'the original wording should still be readable in the file');
  assert.ok(value.includes(MARKER), 'restoration claim is presented without the 2026-11-04 correction that it cannot be honoured');
});
