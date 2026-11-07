// 2026-11-07 (#97): the health probe decides when people get paged, and it had no runtime coverage.
// Its two output paths are now injectable (defaults unchanged), so this guard executes the shipped
// file with every external command stubbed - no network, no systemd, no mail. It pins the degraded
//判定 for each independent cause, that a clean run does not append to the alert log, and that a
// failing alert delivery cannot stop the status file from being written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const SCRIPT = join(ASSET_DIR, '..', '..', 'src', 'work', 'deploy', 'ecs', 'work-healthcheck.sh');

const bashProbe = spawnSync('bash', ['-c', 'command -v date >/dev/null && command -v mv >/dev/null'], { encoding: 'utf8' });
assert.equal(bashProbe.status, 0, `this gate executes the shipped bash probe; bash/date/mv unavailable: ${bashProbe.stderr || bashProbe.error}`);

const sandbox = mkdtempSync(join(tmpdir(), 'r0a-health-'));
const bin = join(sandbox, 'bin');
mkdirSync(bin, { recursive: true });
const stub = (name, body) => {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { encoding: 'utf8' });
  chmodSync(p, 0o755);
};

const runProbe = (env = {}) => {
  const runDir = mkdtempSync(join(sandbox, 'run-'));
  const script = join(runDir, 'work-healthcheck.sh');
  copyFileSync(SCRIPT, script);
  const state = join(runDir, 'state');
  const log = join(runDir, 'alerts.log');
  const alertArgs = join(runDir, 'alert.args');
  const syncFile = join(runDir, 'sync.txt');
  writeFileSync(syncFile, env.FAKE_SYNC !== undefined ? env.FAKE_SYNC : '{"mode":"full","errors":[]}', { encoding: 'utf8' });
  const loggerArgs = join(runDir, 'logger.args');
  stub('curl', `case "$*" in *127.0.0.1:8080*) printf '%s' "\${FAKE_API:-200}";; *) printf '%s' "\${FAKE_HOST:-200}";; esac`);
  stub('systemctl', [
    'case "$1" in',
    '  show) printf \'%s\\n\' "${FAKE_UNIT_RESULT:-success}" ;;',
    '  is-active) printf \'%s\\n\' "${FAKE_ACTIVE:-active}" ;;',
    '  is-enabled) exit "${FAKE_ENABLED_RC:-0}" ;;',
    'esac',
  ].join('\n'));
  stub('journalctl', 'cat "$FAKE_SYNC_FILE"');
  stub('openssl', 'exit "${FAKE_OPENSSL_RC:-0}"');
  stub('python3', `printf '%s\\n' "$*" > "${alertArgs}"; exit "\${FAKE_ALERT_RC:-0}"`);
  stub('logger', `printf '%s\\n' "$*" >> "${loggerArgs}"`);
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      WORK_HEALTH_STATE_DIR: state,
      WORK_HEALTH_ALERT_LOG: log,
      WORK_HEALTH_PYTHON: join(bin, 'python3'),
      WORK_HEALTH_ALERT_SCRIPT: join(runDir, 'work-health-alert.py'),
      FAKE_SYNC_FILE: syncFile,
      ...env,
    },
  });
  const healthPath = join(state, 'health.json');
  const health = existsSync(healthPath) ? JSON.parse(readFileSync(healthPath, 'utf8')) : null;
  return {
    status: result.status,
    text: `${result.stdout}\n${result.stderr}`,
    health,
    log: existsSync(log) ? readFileSync(log, 'utf8') : null,
    alert: existsSync(alertArgs) ? readFileSync(alertArgs, 'utf8').trim() : null,
    logger: existsSync(loggerArgs) ? readFileSync(loggerArgs, 'utf8') : '',
  };
};

test('a healthy probe reports ok, tells the alert script, and appends nothing', () => {
  const run = runProbe();
  assert.ok(run.health, `no status file written:\n${run.text}`);
  assert.equal(run.health.status, 'ok', JSON.stringify(run.health));
  assert.equal(run.health.issues, '', JSON.stringify(run.health));
  assert.ok((run.alert || '').trim().endsWith(' ok'), `the alert script must be told the status: ${run.alert}`);
  assert.equal(run.log, null, 'a clean probe must not append to the degraded log');
});

test('a failed observe-list unit degrades and names that unit', () => {
  const run = runProbe({ FAKE_UNIT_RESULT: 'failed' });
  assert.equal(run.health.status, 'degraded', JSON.stringify(run.health));
  assert.match(run.health.issues, /work-reconcile-scan\.service_failed/, run.health.issues);
  assert.ok((run.alert || '').includes(' degraded'), `the alert script must be told the status: ${run.alert}`);
  assert.ok(run.log && run.log.includes('status=degraded'), 'a degraded probe must append to the log');
});

test('an unhealthy API endpoint degrades with the code it actually saw', () => {
  const run = runProbe({ FAKE_API: '503' });
  assert.equal(run.health.status, 'degraded', JSON.stringify(run.health));
  assert.match(run.health.issues, /work_api_http=503/, run.health.issues);
});

test('no directory-sync report in the window degrades rather than reading as clean', () => {
  const run = runProbe({ FAKE_SYNC: '' });
  assert.equal(run.health.status, 'degraded', JSON.stringify(run.health));
  assert.match(run.health.issues, /sync_no_report_30m/, run.health.issues);
});

test('a sync report carrying errors degrades', () => {
  const run = runProbe({ FAKE_SYNC: '{"mode":"full","errors":["x"]}' });
  assert.equal(run.health.status, 'degraded', JSON.stringify(run.health));
  assert.match(run.health.issues, /sync_errors/, run.health.issues);
});

test('alert delivery failure cannot stop the status file, and is logged as a failure', () => {
  const run = runProbe({ FAKE_ALERT_RC: '1' });
  assert.ok(run.health, 'the status file must still be written when delivery fails');
  assert.equal(run.health.status, 'ok', JSON.stringify(run.health));
  assert.match(run.logger, /health alert delivery failed/,
    `the delivery failure must be recorded, got: ${run.logger}`);
});
