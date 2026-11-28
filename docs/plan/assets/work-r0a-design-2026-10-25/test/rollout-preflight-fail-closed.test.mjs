import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..', '..', '..')
const PREFLIGHT = join(ROOT, 'docs', 'plan', 'assets', 'work-r0a-ops-2026-10-25', 'preflight')
const LEDGER = join(PREFLIGHT, 'rollout-preflight-ledger-read.sh')
const PACKAGE = join(PREFLIGHT, 'rollout-preflight-package-shape-read.sh')
const ROLLOUT = join(ROOT, 'src/work/deploy/ecs/rollout-r0a-0027.sh')
const BINARIES = [
  'work-api',
  'work-authz',
  'work-cancel',
  'work-content-proxy',
  'work-directory-sync',
  'work-e2e-seed',
  'work-egress',
  'work-export',
  'work-gateway',
  'work-governance-events',
  'work-migrate',
  'work-operator-entitlement',
  'work-provider-setup',
  'work-reconcile',
  'work-relay',
  'work-replay',
  'work-worker',
]

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('preflight defaults track the authoritative deployed and repository migration tips', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'src/work/migrations/manifest.json'), 'utf8'))
  const status = JSON.parse(readFileSync(join(ROOT, 'docs/work/status.inputs.json'), 'utf8'))
  const repoTail = Math.max(...manifest.increments.map((entry) => entry.version))
  const deployedTip = status.migration.tip_deployed
  const ledger = readFileSync(LEDGER, 'utf8')
  const packageShape = readFileSync(PACKAGE, 'utf8')

  assert.ok(
    ledger.includes('EXPECTED_LEDGER_TIP="${EXPECTED_LEDGER_TIP:-' + deployedTip + '}"'),
    `ledger preflight default must be the deployed tip ${deployedTip}`,
  )
  assert.ok(
    ledger.includes('EXPECTED_MIGRATION_TAIL="${EXPECTED_MIGRATION_TAIL:-' + repoTail + '}"'),
    `ledger preflight target must be the repository tail ${repoTail}`,
  )
  assert.ok(
    packageShape.includes('EXPECTED_MIGRATION_TAIL="${EXPECTED_MIGRATION_TAIL:-' + repoTail + '}"'),
    `package preflight default must be the repository tail ${repoTail}`,
  )
})

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'work-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const releases = join(root, 'releases')
  const release = join(releases, 'work-release-0097')
  const installed = join(root, 'installed')
  const fakeBin = join(root, 'fake-bin')
  const backup = join(root, 'backup')
  for (const dir of [release, installed, fakeBin, backup]) mkdirSync(dir, { recursive: true })

  writeFileSync(join(release, 'RELEASE_COMMIT'), '0123456789abcdef\n')
  writeFileSync(join(release, 'MIGRATION_TAIL'), '97\n')
  writeFileSync(join(release, 'RELEASE_DIRTY'), '0\n')
  writeFileSync(join(release, 'BINARIES'), `${BINARIES.join('\n')}\n`)
  writeFileSync(join(release, 'rollout-r0a-0027.sh'), '#!/usr/bin/env bash\nsystemctl restart work-api\n')
  writeFileSync(join(release, 'verify-r0a-0027.sh'), '#!/usr/bin/env bash\nexit 0\n')
  for (const binary of BINARIES) {
    writeFileSync(join(release, binary), `package ${binary}\n`)
    writeFileSync(join(installed, binary), `installed ${binary}\n`)
  }
  for (const name of ['work-content-backup.py', 'work-content-backup.service', 'work-content-backup.timer']) {
    writeFileSync(join(release, name), `${name} payload\n`)
  }

  const hostPy = join(backup, 'work-content-backup.py')
  const hostService = join(backup, 'work-content-backup.service')
  const hostTimer = join(backup, 'work-content-backup.timer')
  writeFileSync(hostPy, readFileSync(join(release, 'work-content-backup.py'), 'utf8').replace(/\n/g, '\r\n'))
  copyFileSync(join(release, 'work-content-backup.service'), hostService)
  copyFileSync(join(release, 'work-content-backup.timer'), hostTimer)

  const sudo = join(fakeBin, 'sudo')
  writeFileSync(
    sudo,
    `#!/usr/bin/env bash
if [ "$1" = "-u" ] && [ "$2" = "postgres" ] && [ "$3" = "psql" ]; then
  sql="\${@: -1}"
  if [ -n "\${FAKE_FAIL_SQL:-}" ] && [[ "$sql" == *"$FAKE_FAIL_SQL"* ]]; then
    echo "fake psql failure: $sql" >&2
    exit 1
  fi
  case "$sql" in
    *"max(version)"*) echo "\${FAKE_LEDGER_TIP:-62}" ;;
    *"count(*) from work.schema_migration"*) echo "\${FAKE_LEDGER_TIP:-62}" ;;
    *"to_regclass"*) echo "\${FAKE_DEVICE_RELATION:-t}" ;;
    *"count(*) from work.device_dispatch"*) echo "\${FAKE_DEVICE_ROWS:-0}" ;;
    *"count(*) from work.run"*) echo "\${FAKE_OPEN_RUNS:-0}" ;;
    *"count(*) from work.quota_reservation"*) echo "0" ;;
    *"count(*) from work.outbox"*) echo "0" ;;
    *"information_schema.tables"*) echo "80" ;;
    *"pg_proc"*) echo "120" ;;
    *) echo "FAKE_SQL_RESULT" ;;
  esac
  exit 0
fi
exec "$@"
`,
  )
  chmodSync(sudo, 0o755)

  const manifest = () => {
    const lines = readdirSync(release)
      .filter((name) => name !== 'SHA256SUMS')
      .sort()
      .map((name) => `${sha256(join(release, name))}  ${name}`)
    writeFileSync(join(release, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  }
  manifest()

  const env = {
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    WORK_RELEASE_ROOT: releases,
    PF_RELEASE_DIR: release,
    WORK_INSTALL_BIN_DIR: installed,
    WORK_BACKUP_PY: hostPy,
    WORK_BACKUP_SERVICE: hostService,
    WORK_BACKUP_TIMER: hostTimer,
  }
  const run = (script, overrides = {}) =>
    spawnSync('bash', [script], {
      cwd: ROOT,
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 30_000,
    })
  return { root, release, installed, hostPy, hostService, hostTimer, manifest, run }
}

test('ledger preflight passes the 62-to-97 starting state and tolerates a CRLF host backup', (t) => {
  const f = fixture(t)
  const ledger = f.run(LEDGER)
  assert.equal(ledger.status, 0, ledger.stderr)
  assert.match(ledger.stdout, /tip_version=62/)
  assert.match(ledger.stdout, /ledger_rows=62/)
  assert.match(ledger.stdout, /device_dispatch_rows=0/)
  assert.match(ledger.stdout, /PF RESULT=PASS/)

  const pkg = f.run(PACKAGE)
  assert.equal(pkg.status, 0, pkg.stderr)
  assert.match(pkg.stdout, /MIGRATION_TAIL=97/)
  assert.match(pkg.stdout, /declared_binaries=17/)
  assert.match(pkg.stdout, /work-content-backup\.py host_sha256=[a-f0-9]{64} package_sha256=[a-f0-9]{64}/)
  assert.match(pkg.stdout, /PF RESULT=PASS/)
})

test('a wrong ledger tip is a stop, not a warning', (t) => {
  const f = fixture(t)
  const result = f.run(LEDGER, { FAKE_LEDGER_TIP: '61' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ledger tip is 61, expected 62/)
  assert.match(result.stdout, /PF RESULT=FAIL/)
})

test('an invalid or backwards target migration tail is a stop', (t) => {
  const f = fixture(t)
  for (const [target, message] of [
    ['abc', /EXPECTED_MIGRATION_TAIL is not a number/],
    ['61', /EXPECTED_MIGRATION_TAIL 61 is below EXPECTED_LEDGER_TIP 62/],
  ]) {
    const result = f.run(LEDGER, { EXPECTED_MIGRATION_TAIL: target })
    assert.equal(result.status, 1)
    assert.match(result.stderr, message)
  }
})

test('a non-empty device_dispatch blocks 0055', (t) => {
  const f = fixture(t)
  const result = f.run(LEDGER, { FAKE_DEVICE_ROWS: '2' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /device_dispatch has 2 rows/)
})

test('an absent device_dispatch table is the safe zero-row case', (t) => {
  const f = fixture(t)
  const result = f.run(LEDGER, { FAKE_DEVICE_RELATION: 'f' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /device_dispatch_rows=0 relation=ABSENT/)
})

test('an unreadable ledger probe fails closed', (t) => {
  const f = fixture(t)
  const result = f.run(LEDGER, { FAKE_FAIL_SQL: 'max(version)' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /tip_version unreadable/)
})

test('an unreadable device_dispatch probe fails closed', (t) => {
  const f = fixture(t)
  const result = f.run(LEDGER, { FAKE_FAIL_SQL: 'to_regclass' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /could not determine whether work\.device_dispatch exists/)
})

test('runtime preflight requires zero open runs while migration preflight only records them', (t) => {
  const f = fixture(t)
  const migration = f.run(LEDGER, { FAKE_OPEN_RUNS: '3', REQUIRE_DRAINED: '0' })
  assert.equal(migration.status, 0, migration.stderr)
  assert.match(migration.stdout, /open_runs=3/)

  const runtime = f.run(LEDGER, { FAKE_OPEN_RUNS: '3', REQUIRE_DRAINED: '1', EXPECTED_LEDGER_TIP: '97' })
  assert.equal(runtime.status, 1)
  assert.match(runtime.stderr, /runtime swap requires zero open runs, found 3/)
})

test('a dirty or wrong-tail package is rejected', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.release, 'RELEASE_DIRTY'), '1\n')
  writeFileSync(join(f.release, 'MIGRATION_TAIL'), '45\n')
  f.manifest()
  const result = f.run(PACKAGE)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /RELEASE_DIRTY is 1, expected 0/)
  assert.match(result.stderr, /package migration tail is 45, expected 97/)
})

test('a corrupted package checksum is rejected', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.release, 'work-api'), 'tampered\n')
  const result = f.run(PACKAGE)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /SHA256SUMS verification failed/)
})

test('a mismatched host backup copy blocks the runtime step', (t) => {
  const f = fixture(t)
  writeFileSync(f.hostPy, 'different host script\n')
  const result = f.run(PACKAGE)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /work-content-backup\.py differs from the package after CR stripping/)
})

test('a missing host backup copy is recorded as first-install, not as a mismatch', (t) => {
  const f = fixture(t)
  unlinkSync(f.hostService)
  const result = f.run(PACKAGE)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /work-content-backup\.service host=MISSING allowed=first-install/)
})

test('a package missing the backup trio cannot pass', (t) => {
  const f = fixture(t)
  unlinkSync(join(f.release, 'work-content-backup.timer'))
  f.manifest()
  const result = f.run(PACKAGE)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /packaged asset is missing: work-content-backup\.timer/)
})

const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"

function consumerPreflightFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'work-consumer-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fakeBin = join(root, 'fake-bin')
  const release = join(root, 'release')
  const cancelEnv = join(root, 'work-cancel.env')
  const workerEnv = join(root, 'work-worker.env')
  const governanceEnv = join(root, 'work-governance-events.env')
  const cert = join(root, 'client.crt')
  const key = join(root, 'client.key')
  const ca = join(root, 'ca.crt')
  const clientCa = join(root, 'client-ca.crt')
  for (const dir of [fakeBin, release]) mkdirSync(dir, { recursive: true })
  for (const file of [workerEnv, cert, key, ca, clientCa]) writeFileSync(file, 'fixture\n')
  writeFileSync(join(release, 'verify-r0a-0027.sh'), '#!/usr/bin/env bash\nexit 0\n')
  writeFileSync(join(fakeBin, 'runuser'), `#!/usr/bin/env bash
sql="\${@: -1}"
case "$sql" in
  *"select id from work.org"*) printf '%s\\n' "$FAKE_ORGS" ;;
  *"pg_roles"*) echo work_governance_events_login ;;
  *) exit 1 ;;
esac
`)
  chmodSync(join(fakeBin, 'runuser'), 0o755)

  const rollout = readFileSync(ROLLOUT, 'utf8')
  const start = rollout.indexOf('read_env_exact() {')
  const end = rollout.indexOf('\necho "== 1. preflight =="', start)
  assert.ok(start >= 0 && end > start, 'could not locate rollout consumer preflight functions')
  const bashPath = (value) => value.replaceAll('\\', '/')
  const functions = rollout
    .slice(start, end)
    .replaceAll('/etc/work/work-cancel.env', bashPath(cancelEnv))
    .replaceAll('/etc/work/work-worker.env', bashPath(workerEnv))
    .replaceAll('/etc/work/work-governance-events.env', bashPath(governanceEnv))
  const env = {
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    FAKE_ORGS: 'org-a\norg-b',
  }
  const run = (call) => spawnSync('bash', ['-c', `set -euo pipefail\nRELEASE=${shellQuote(bashPath(release))}\n${functions}\n${call}`], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  const governance = [
    'WORK_GOVERNANCE_ORGS=org-a org-b',
    'WORK_DATABASE_URL=postgresql://work_governance_events_login:secret@127.0.0.1:5432/work?sslmode=disable',
    `WORK_GOVERNANCE_HOST_BASE_URL=${bashPath(cert)}`,
    `WORK_GOVERNANCE_CLIENT_CERT=${bashPath(cert)}`,
    `WORK_GOVERNANCE_CLIENT_KEY=${bashPath(key)}`,
    `WORK_GOVERNANCE_CA=${bashPath(ca)}`,
    `WORK_GOVERNANCE_CLIENT_CA=${bashPath(clientCa)}`,
  ].join('\n') + '\n'
  writeFileSync(cancelEnv, 'WORK_CANCEL_ORGS=org-a org-b\n')
  writeFileSync(governanceEnv, governance)
  return {
    setCancelEnv: (value) => writeFileSync(cancelEnv, value),
    setGovernanceEnv: (value) => writeFileSync(governanceEnv, value),
    governanceEnv: governance,
    runCancel: () => run('verify_cancel_org_coverage'),
    runGovernance: () => run('verify_governance_consumer'),
  }
}

test('cancel consumer preflight accepts exact orgs and rejects duplicate org ids', (t) => {
  const f = consumerPreflightFixture(t)
  const pass = f.runCancel()
  assert.equal(pass.status, 0, pass.stderr)
  assert.match(pass.stdout, /work-cancel org coverage: 2 organization\(s\), exact match/)

  f.setCancelEnv('WORK_CANCEL_ORGS=org-a org-a org-b\n')
  const duplicate = f.runCancel()
  assert.equal(duplicate.status, 1)
  assert.match(duplicate.stderr, /duplicate configured ids:/)
  assert.match(duplicate.stderr, /WORK_CANCEL_ORGS must exactly cover every work\.org id/)
})

test('governance consumer preflight accepts exact config and rejects duplicate org ids', (t) => {
  const f = consumerPreflightFixture(t)
  const pass = f.runGovernance()
  assert.equal(pass.status, 0, pass.stderr)
  assert.match(pass.stdout, /governance consumer preflight: dedicated role\/mTLS identity and 2 organization\(s\) verified/)

  f.setGovernanceEnv(f.governanceEnv.replace('WORK_GOVERNANCE_ORGS=org-a org-b', 'WORK_GOVERNANCE_ORGS=org-a org-a org-b'))
  const duplicate = f.runGovernance()
  assert.equal(duplicate.status, 1)
  assert.match(duplicate.stderr, /duplicate configured ids:/)
  assert.match(duplicate.stderr, /WORK_GOVERNANCE_ORGS must exactly cover every work\.org id/)
})

test('consumer preflight rejects duplicate required env keys instead of taking the last value', (t) => {
  const f = consumerPreflightFixture(t)
  f.setCancelEnv('WORK_CANCEL_ORGS=org-a org-b\nWORK_CANCEL_ORGS=org-a org-b\n')
  const cancel = f.runCancel()
  assert.equal(cancel.status, 1)
  assert.match(cancel.stderr, /WORK_CANCEL_ORGS must appear exactly once .*found 2/)

  f.setGovernanceEnv(f.governanceEnv + 'WORK_GOVERNANCE_ORGS=org-a org-b\n')
  const governance = f.runGovernance()
  assert.equal(governance.status, 1)
  assert.match(governance.stderr, /WORK_GOVERNANCE_ORGS must appear exactly once .*found 2/)
})
