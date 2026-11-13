// 2026-11-13, review batch B1: goNoGo() could say `go=true`, and 33 checklist items could sit in
// status done/waived while their own notes carried live holes - the 11-15/16 drill window, the
// legal/DPA signature, 28 unproduced metric series, four surfaces outside the frozen contract.
// Nothing machine-readable distinguished "closed and nothing left" from "closed with a hole", so a
// green go was read as the former. `validateControls` has required closeCondition on controls since
// the start; this is the same rule for the checklist, plus the field pair goNoGo prints.
//
// The rule that makes this more than prose-in-a-new-key: residualSource must be a verbatim substring
// of that same item's own note/evidence, asserted here per item. A residual therefore cannot be
// written by guessing what the item "probably" still owes - it has to quote the item, or the gate
// goes red.
//
// 2026-11-13 (review batch C) changed one thing in this file: goNoGo() takes the SLO asset next to the
// checklist, so the shipped gate prints go=false with a named measurement blocker. That is the same
// failure this file was written against - a verdict read as "nothing outstanding" - now applied to
// what was measured. See docs/plan/work-project.md §5.2 for the take command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goNoGo, residuals, validateChecklist } from '../../work-r0a-ops-2026-10-25/ops-model.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');
const OPS = join(HERE, '..', '..', 'work-r0a-ops-2026-10-25');
const checklist = JSON.parse(readFileSync(join(OPS, 'pilot-checklist.json'), 'utf8'));
const slo = JSON.parse(readFileSync(join(OPS, 'slo-pilot.json'), 'utf8'));

// One item is allowed to say nothing is outstanding. The list is deliberately explicit so a new
// closure cannot adopt "none" without naming itself here first.
const NOTHING_OUTSTANDING = ['C05'];
// Residuals whose own text never states what reopens them. Ratchet: recorded holes without a
// trigger are the weaker half of the pair, so this may shrink but not grow without a dated
// correction in this file.
const UNSTATED_REOPEN_CAP = 7;

const closed = () => checklist.items.filter((i) => ['done', 'waived'].includes(i.status));
const ownText = (item) => [item.note ?? '', ...(item.evidence ?? [])].join('\n');

test('the shipped checklist passes the residual rule, and the rule can still bite', () => {
  assert.deepEqual(validateChecklist(checklist), [],
    'the real checklist must validate clean, including the residual fields');
  // Positive control: an otherwise identical item without a residual must produce exactly the new
  // issue. Without this, an accidentally permissive validator would look like a passing gate.
  const control = {
    categories: checklist.categories,
    items: [
      { id: 'K1', category: 'ops', title: 't', owner: 'o', status: 'done', blocking: true, gate: 'pilot',
        evidence: ['e'], note: 'n', residual: 'a hole', reopenCondition: 'when it matters', residualSource: 'n' },
      { id: 'K2', category: 'ops', title: 't', owner: 'o', status: 'done', blocking: true, gate: 'pilot',
        evidence: ['e'], note: 'n' },
    ],
  };
  assert.deepEqual(validateChecklist(control), ['checklist K2 is done without a residual statement'],
    'the validator must reject a closed item with no residual and nothing else');
  // And the two weaker shapes it must also reject: a residual with no trigger, a residual with no quote.
  for (const drop of ['reopenCondition', 'residualSource']) {
    const clone = structuredClone(control);
    delete clone.items[0][drop];
    assert.ok(validateChecklist(clone).some((m) => m.includes('K1')),
      `dropping ${drop} from a residual-bearing item must produce an issue`);
  }
});

test('every closed item carries the three residual fields, in both directions', () => {
  const items = closed();
  assert.equal(items.length, checklist.items.length,
    'all items are closed today; if a new item opens in todo/partial it needs its own rule here, not a silent skip');
  assert.ok(items.length >= 30, `expected at least 30 closed items, found ${items.length}`);
  for (const item of items) {
    assert.ok(typeof item.residual === 'string' && item.residual.trim() !== '', `${item.id} has no residual`);
    if (item.residual === 'none') {
      assert.ok(NOTHING_OUTSTANDING.includes(item.id),
        `${item.id} claims nothing is outstanding; add it to NOTHING_OUTSTANDING only with the item text to back it`);
      assert.equal(item.reopenCondition, 'none', `${item.id} says none but carries a reopen condition`);
      continue;
    }
    // Floor is anchored on the shortest real residual in the shipped file: C32 is a one-line waived
    // scale item at 34 chars, so anything under 30 is filler ("n/a", "TBD"), not a residual.
    assert.ok(item.residual.length >= 30,
      `${item.id} residual is ${item.residual.length} chars - too short to state what is still not true`);
    assert.ok(typeof item.reopenCondition === 'string' && item.reopenCondition.trim() !== '',
      `${item.id} has a residual with no reopen condition`);
    assert.ok(item.residualSource.length >= 8, `${item.id} residualSource is too short to pin anything`);
    assert.ok(ownText(item).includes(item.residualSource),
      `${item.id}.residualSource is not verbatim in that item's own note/evidence - a residual must be quoted ` +
      'from the item, not inferred from it');
  }
  const claimed = items.filter((i) => i.residual === 'none').map((i) => i.id).sort();
  assert.deepEqual(claimed, [...NOTHING_OUTSTANDING].sort(),
    'the "nothing outstanding" set must match in both directions');
});

test('the residual count is a live number that goNoGo prints alongside go', () => {
  const r = residuals(checklist);
  const g = goNoGo(checklist, slo);
  assert.equal(r.residualCount, g.residualCount, 'goNoGo and residuals() must not disagree');
  // 2026-11-13 (review batch C): this test used to assert `go=true` plus a non-zero residual count,
  // which is the pairing it still exists to protect. The colour changed because the gate learned to
  // read slo-pilot.json - all 12 pilot metrics say not_measured while C17 declares it needs them
  // measured - so the honest version pins which blocker is open and keeps the pairing claim intact.
  assert.equal(g.go, false, 'a green gate here would mean the unmeasured SLO stopped being read');
  assert.deepEqual(
    g.blockers.map((item) => `${item.id}:${item.reason ?? 'unclosed'}`),
    ['C17:slo_not_measured'],
    'the only open blocker is the measurement half, not a checklist row that drifted back to partial');
  assert.equal(g.startBlockerCount + g.pilotBlockerCount + g.scaleBlockerCount, 0,
    'the checklist buckets are clear; blockerCount is not evidence that a row reopened');
  assert.ok(r.residualCount >= 20,
    `expected at least 20 residuals, found ${r.residualCount} - a mass reset to "none" is not a closure`);
  // The whole point of the field: the verdict and the residual count are printed in the same reading,
  // whichever way the verdict goes. A red gate does not mean the closed rows are hole-free either.
  assert.ok(g.residualCount > 0, 'the gate verdict must be reported next to a non-zero residual count');
  assert.equal(g.unstatedReopenCount, r.unstatedReopenCount);
  assert.ok(g.unstatedReopenCount >= 1, 'the sentinel is exercised, not dead code');
  assert.ok(g.unstatedReopenCount <= UNSTATED_REOPEN_CAP,
    `${g.unstatedReopenCount} residuals have no stated reopen trigger (cap ${UNSTATED_REOPEN_CAP}, the 2026-11-13 ` +
    'reading): record the trigger in the item, or write a dated correction here explaining why it cannot exist');
});

test('the sentinel is used verbatim so the count means what it says', () => {
  const SENTINEL = "not stated in the item's own text.";
  const users = closed().filter((i) => (i.reopenCondition ?? '').startsWith(SENTINEL));
  for (const item of users) {
    assert.equal(item.reopenCondition, SENTINEL,
      `${item.id} uses the sentinel with trailing prose; that splits the count two ways and hides items in it`);
  }
  assert.equal(users.length, residuals(checklist).unstatedReopenCount,
    'the model count and a direct count over the shipped JSON must agree');
});

test('the doc points at a take command that prints both residual fields', () => {
  const doc = readFileSync(join(REPO, 'docs', 'plan', 'work-project.md'), 'utf8');
  // What is pinned is the command, not a copied number: a prose reading rots the moment an item
  // moves, and the 2026-11-13 rewrite of §5.2 exists to stop exactly that.
  const cmd = doc.match(/node --input-type=module -e "[^\n]*goNoGo\(c,\s*s\)[^\n]*/);
  assert.ok(cmd,
    'work-project.md §5.2 must carry the command that prints the gate state, not a hand-copied answer');
  assert.ok(cmd[0].includes("'residual='+g.residualCount"),
    'the documented command must print the residual count, or go=true is still the only number a reader sees');
  assert.ok(cmd[0].includes("'unstatedReopen='+g.unstatedReopenCount"),
    'and the weaker half - a residual with no stated trigger - must be visible in the same reading');
  // 2026-11-13 (review batch C): the same argument applies to what was measured. A reader who copies
  // the documented command must get the SLO asset, or the gate prints a verdict from one file and the
  // second half stays invisible - which is how C17 read green for six weeks.
  assert.ok(/slo-pilot\.json/.test(cmd[0]),
    'the documented command must load slo-pilot.json, since goNoGo() now refuses to decide without it');
  assert.ok(cmd[0].includes("'measurement='+g.measurementBlockerCount"),
    'the measurement blocker count must print, or the red verdict has no stated reason');
  assert.ok(cmd[0].includes("'slo='+g.sloMeasuredCount+'/'+g.sloMetricCount"),
    'and the measured/total split must print next to it');
});
