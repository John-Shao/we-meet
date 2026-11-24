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
const BINARIES = [
  'work-migrate',
  'work-api',
  'work-authz',
  'work-relay',
  'work-worker',
  'work-export',
  'work-content-proxy',
  'work-egress',
  'work-host',
  'work-reconcile',
  'work-replay',
  'work-healthcheck',
]

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'work-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const releases = join(root, 'releases')
  const release = join(releases, 'work-release-0062')
  const installed = join(root, 'installed')
  const fakeBin = join(root, 'fake-bin')
  const backup = join(root, 'backup')
  for (const dir of [release, installed, fakeBin, backup]) mkdirSync(dir, { recursive: true })

  writeFileSync(join(release, 'RELEASE_COMMIT'), '0123456789abcdef\n')
  writeFileSync(join(release, 'MIGRATION_TAIL'), '62\n')
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
    *"max(version)"*) echo "\${FAKE_LEDGER_TIP:-39}" ;;
    *"count(*) from work.schema_migration"*) echo "62" ;;
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

test('ledger preflight passes the 39-to-62 starting state and tolerates a CRLF host backup', (t) => {
  const f = fixture(t)
  const ledger = f.run(LEDGER)
  assert.equal(ledger.status, 0, ledger.stderr)
  assert.match(ledger.stdout, /tip_version=39/)
  assert.match(ledger.stdout, /device_dispatch_rows=0/)
  assert.match(ledger.stdout, /PF RESULT=PASS/)

  const pkg = f.run(PACKAGE)
  assert.equal(pkg.status, 0, pkg.stderr)
  assert.match(pkg.stdout, /work-content-backup\.py host_sha256=[a-f0-9]{64} package_sha256=[a-f0-9]{64}/)
  assert.match(pkg.stdout, /PF RESULT=PASS/)
})

test('a wrong ledger tip is a stop, not a warning', (t) => {
  const f = fixture(t)
  const result = f.run(LEDGER, { FAKE_LEDGER_TIP: '40' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ledger tip is 40, expected 39/)
  assert.match(result.stdout, /PF RESULT=FAIL/)
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

  const runtime = f.run(LEDGER, { FAKE_OPEN_RUNS: '3', REQUIRE_DRAINED: '1', EXPECTED_LEDGER_TIP: '62' })
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
  assert.match(result.stderr, /package migration tail is 45, expected 62/)
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
