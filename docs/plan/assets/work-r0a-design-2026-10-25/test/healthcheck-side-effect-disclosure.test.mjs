// 2026-11-07 (#97): work-healthcheck.sh is live (a timer runs it) and had no coverage. The finding
// that made it urgent is not a missing test but a false statement in its own header: it claimed
// "External paging/email delivery is intentionally not wired here" while the body invokes
// work-health-alert.py, which sends mail to every configured recipient. An operator believing that
// header would run the probe by hand to collect evidence and page people - the exact accident the
// runbook warns about. This guard keeps the disclosure tied to the code that causes the side effect,
// and checks that the read-only alternatives it names are paths the script really writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const ECS = join(ASSET_DIR, '..', '..', 'src', 'work', 'deploy', 'ecs');
const probe = readFileSync(join(ECS, 'work-healthcheck.sh'), 'utf8');
const alert = readFileSync(join(ECS, 'work-health-alert.py'), 'utf8');

// strip comments for the "what does it actually do" readings, so prose cannot satisfy them
const probeCode = probe.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
const header = probe.split(/\r?\n/).filter((l) => /^\s*#/.test(l)).join('\n');

test('the probe really invokes the mail-sending alert script', () => {
  assert.match(probeCode, /work-health-alert\.py/,
    'the invocation disappeared - either the side effect is gone (then update this guard and the header) or it was hidden');
  assert.match(alert, /send_mail\s*\(/, 'the alert script no longer sends mail; re-check the disclosure');
  assert.match(alert, /recipients/, 'the recipient loop is what makes this a paging action, not a local log write');
});

test('the header discloses the side effect instead of denying it', () => {
  assert.doesNotMatch(header, /delivery is intentionally not wired/i,
    'the old false claim is back: this probe does trigger email on a status transition');
  assert.doesNotMatch(header, /not wired here/i, 'same denial in another wording');
  assert.match(header, /SIDE EFFECT/, 'the warning must be unmissable to someone about to run it by hand');
  assert.match(header, /work-health-alert\.py/, 'the disclosure must name the thing that sends the mail');
  assert.match(header, /SMTP|email/i, 'and must say what channel it uses');
});

test('the read-only alternatives named in the header are paths the script really writes', () => {
  // born from a real mistake: the first corrected header named /var/lib/work/health-status,
  // which the script never writes. A suggested safe alternative must exist, or it is not safe.
  for (const path of ['/var/lib/work/health.json', '/var/log/work-health-alerts.log']) {
    assert.ok(header.includes(path), `the header should offer ${path} as the read-only alternative`);
    assert.ok(probeCode.includes(path),
      `${path} is offered as a safe read but the script never writes it - do not invent alternatives`);
  }
});
