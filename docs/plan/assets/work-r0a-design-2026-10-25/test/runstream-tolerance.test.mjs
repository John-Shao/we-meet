// 2026-11-06 (#56-B closure): the runstream gauge's tolerance for "held reservations parked on a
// terminal Run" was raised to 2 on 2026-11-04 to cover two known drill leftovers, with the recorded
// condition that it goes back to 0 once the reservations are closed. The pilot host did go back to
// 0 - the template did not, and `install_env` builds a missing env file FROM the template, so any
// reinstall or new host would silently re-adopt a tolerance of 2 and stop alerting on the first two
// leaks. Nothing in the suite covered either file, which is how the drift survived six days.
// This gate pins the value, the wrapper's fallback, and the fact that the effective tolerance is
// printed - a control whose number nobody declares is how the next drift stays invisible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const WORK_ROOT = join(ASSET_DIR, '..', '..', 'src', 'work');
const TEMPLATE = join(WORK_ROOT, 'deploy', 'ecs', 'work-runstream-scan.env.example');
const WRAPPER = join(WORK_ROOT, 'scripts', 'run-runstream-gauges.sh');

const template = readFileSync(TEMPLATE, 'utf8');
const wrapper = readFileSync(WRAPPER, 'utf8');

const KEY = 'WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL';
const countOccurrences = (text, needle) => text.split(needle).length - 1;

test('the shipped env template tolerates zero leaked reservations', () => {
  const assignments = [...template.matchAll(/^WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL=(\S+)\s*$/gm)]
    .map((match) => match[1]);
  assert.equal(assignments.length, 1,
    `the template must declare the tolerance exactly once, found ${assignments.length}: a second later ` +
    'line would win and the file would read as 0 while shipping something else');
  assert.equal(assignments[0], '0',
    `template tolerance = ${assignments[0]}, want 0: ${KEY} is the alert threshold for reservations ` +
    'held on terminal Runs, and a nonzero default re-opens the #56-B exemption for every new install');
});

test('the wrapper fails safe when the key is absent', () => {
  // The `-` belongs to the `:-` default marker, not to the value: matching it into the capture group
  // reads `-0`, which fails a correct file and so would have taught the next reader to distrust this gate.
  // Digits-only also means a non-numeric fallback drops the count to 0 and fails the assertion above.
  const defaults = [...wrapper.matchAll(/MAX_HELD_ON_TERMINAL="\$\{WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL:-([0-9]+)\}"/g)]
    .map((match) => match[1]);
  assert.equal(defaults.length, 1, `expected exactly one fallback for the tolerance, found ${defaults.length}`);
  assert.equal(defaults[0], '0',
    `fallback = ${defaults[0]}, want 0: a missing env key must not silently tolerate leaks`);
});

test('the effective tolerance is reported by the script itself', () => {
  // The value an operator must trust comes from the run's own output, not from a doc or my memory of
  // the file - so a drift is visible in the evidence rather than only in the repo.
  assert.match(wrapper, /summary:.*max_held_on_terminal=\$MAX_HELD_ON_TERMINAL/,
    'the summary line must print the effective tolerance');
  assert.match(wrapper, /BREACH .*超过容差 \$MAX_HELD_ON_TERMINAL/,
    'the breach line must name the tolerance it compared against');
});

test('no other shipped env example re-declares the tolerance', () => {
  const siblings = ['work-reconcile-scan.env.example', 'work-worker.env.example', 'work-export.env.example']
    .filter((name) => {
      try {
        readFileSync(join(WORK_ROOT, 'deploy', 'ecs', name), 'utf8');
        return true;
      } catch {
        return false;
      }
    });
  for (const name of siblings) {
    const body = readFileSync(join(WORK_ROOT, 'deploy', 'ecs', name), 'utf8');
    assert.equal(countOccurrences(body, `${KEY}=`), 0,
      `${name} also sets ${KEY}; one knob needs one home or the effective value depends on load order`);
  }
  assert.ok(siblings.length >= 1, 'the sibling list resolved to nothing, so this check would be vacuous');
});
