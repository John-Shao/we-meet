// The 0040-0043 rollout pre-flight readings are taken by two shell scripts that run as root on
// the production host. "Root on production" plus "read-only" is a claim, not a fact, until a
// machine checks it - so this gate refuses the scripts the moment they gain a state-changing
// command, and keeps a positive control (the real rollout script) to prove the scan has teeth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const PREFLIGHT = join(ROOT, 'docs', 'plan', 'assets', 'work-r0a-ops-2026-10-25', 'preflight');
const PROJECT_DOC = join(ROOT, 'docs', 'plan', 'work-project.md');
const READ_SCRIPTS = [
  'rollout-preflight-ledger-read.sh',
  'rollout-preflight-package-shape-read.sh',
];
const WRITE_SCRIPT = join(ROOT, 'src', 'work', 'deploy', 'ecs', 'rollout-r0a-0027.sh');

const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
// Line-ending checks must see the bytes bash will see, not the normalised text the other
// assertions read: `read()` turns CRLF into LF, so a CR check through it can never fail.
const readRaw = (file) => readFileSync(file, 'latin1');

const writePatterns = [
  [/\bsystemctl\s+(start|stop|restart|reload|kill|enable|disable|mask|unmask|daemon-reload|set-property|revert|link)\b/, 'systemctl state change'],
  [/\bkill(pp|)\s+\d/, 'kill signal'],
  [/\b(shutdown|reboot|halt)\b/, 'machine power'],
  [/\b(mkdir|rmdir|touch|tee|chmod|chown|ln)\s/, 'filesystem write'],
  [/\b(cp|mv|install|truncate|rm)\s+-/, 'file mutation'],
  [/\b(docker|podman|kubectl|helm|apt|apt-get|systemd-run|journalctl\s+--vacuum)\b/, 'external mutator'],
  [/\bgit\s+(apply|checkout|commit|push|reset|clean)\b/, 'git mutation'],
  [/\bwork-migrate\s+(apply|snapshot|adopt)\b/, 'migrator write'],
  [/\bwork-e2e-seed\b/, 'seeding binary'],
  [/>>?\s*([^\s;|)]+)/, 'redirect target'],
];

// Every redirect must land in /dev/null or nowhere; anything else would be a host write.
function writeHits(text) {
  const hits = [];
  for (const [pattern, label] of writePatterns) {
    for (const match of text.matchAll(new RegExp(pattern, 'g'))) {
      if (label === 'redirect target') {
        const target = match[1];
        if (target.startsWith('/dev/null') || !target.startsWith('/')) continue;
        hits.push(`${label} -> ${target}`);
        continue;
      }
      hits.push(label);
    }
  }
  return hits;
}

// The SQL these scripts run has to be a read, not a read-shaped write. Only the lines that
// actually invoke psql count - `grep -a -c "$n"` shares the `-c "…"` shape and is not SQL.
function sqlCallSites(text) {
  return text
    .split('\n')
    .filter((line) => /^\s*(\$P|sudo -u postgres psql)\b/.test(line))
    .flatMap((line) => [...line.matchAll(/-c\s+"([^"]+)"/g)].map((match) => match[1].trim()));
}

test('the pre-flight readings have a repo home, and the status source points at it', () => {
  for (const name of READ_SCRIPTS) {
    const file = join(PREFLIGHT, name);
    assert.ok(existsSync(file), `pre-flight script is not in the repo: ${name}`);
    assert.ok(statSync(file).size > 400, `${name} looks truncated`);
    assert.ok(!readRaw(file).includes('\r'), `${name} must be LF - CRLF would break bash on the host`);
  }
  const doc = read(PROJECT_DOC);
  for (const name of READ_SCRIPTS) {
    assert.ok(
      doc.includes(`preflight/${name}`),
      `work-project.md does not name ${name}, so its readings would have no reproducible source`,
    );
  }
  assert.ok(doc.includes('sudo -S -p "" bash /var/tmp/pf.sh'), 'the take command no longer matches how these scripts are run');
  assert.ok(doc.includes('rm -f /var/tmp/pf.sh'), 'the take command no longer removes the script it uploaded');
});

test('neither pre-flight script can change host state, and the scan is not vacuous', () => {
  for (const name of READ_SCRIPTS) {
    const hits = writeHits(read(join(PREFLIGHT, name)));
    assert.deepEqual(hits, [], `${name} contains state-changing commands: ${[...new Set(hits)].join(', ')}`);
  }
  // positive control: the same predicate must bite the script that actually deploys
  const control = writeHits(read(WRITE_SCRIPT));
  assert.ok(control.length > 0, `the write-verb scan found nothing even in ${WRITE_SCRIPT}, so it cannot be trusted here`);
  assert.ok(
    control.includes('systemctl state change'),
    'the scan should flag the rollout script’s systemctl stop/restart - if it does not, the predicate is broken',
  );
});

test('every SQL these scripts run is a read, counted rather than assumed', () => {
  const all = READ_SCRIPTS.flatMap((name) => sqlCallSites(read(join(PREFLIGHT, name))));
  assert.ok(all.length >= 10, `expected at least 10 psql call sites across the pre-flight scripts, saw ${all.length}`);
  const nonRead = all.filter(
    (sql) => !/^(select|with)\b/i.test(sql) || /\b(insert|update|delete|alter|create|drop|grant|revoke|truncate|copy|vacuum|set\s+role|set_config|do)\b/i.test(sql),
  );
  assert.deepEqual(nonRead, [], `non-read SQL in a read-only script: ${JSON.stringify(nonRead)}`);
});

test('the readings the status source quotes are printed by the scripts themselves', () => {
  const text = READ_SCRIPTS.map((name) => read(join(PREFLIGHT, name))).join('\n');
  const doc = read(PROJECT_DOC);
  const labels = [
    'tip_version=',
    'ledger_rows=',
    'open_runs=',
    'held_reservations=',
    'outbox_pending=',
    'work_tables=',
    'work_functions=',
    'RELEASE_COMMIT=',
    'MIGRATION_TAIL=',
    'RELEASE_DIRTY=',
    'package_migrations_dir=',
    'embed ',
    'active=',
  ];
  // A label only counts as printed when the line that carries it is a printing line:
  // a shell `echo`, or a psql literal (`select 'label='||…`). A bare mention in a comment
  // or a `for f in LABEL …` list would otherwise satisfy the check without printing anything.
  const lines = text.split('\n');
  const notPrinted = labels.filter(
    (label) => !lines.some((line) => line.includes(label) && (/\becho\b/.test(line) || /select '/.test(line))),
  );
  assert.deepEqual(notPrinted, [], 'a quoted reading has no printing line in the scripts: ' + JSON.stringify(notPrinted));
  const quoted = ['tip_version=39', 'RELEASE_DIRTY=0', 'open_runs=1', 'held_reservations=1', 'outbox_pending=0', 'package_migrations_dir=ABSENT'];
  const unstated = quoted.filter((token) => !doc.includes(token));
  assert.deepEqual(unstated, [], 'the scripts print a label the status source stopped quoting - re-read and update the row');
});
