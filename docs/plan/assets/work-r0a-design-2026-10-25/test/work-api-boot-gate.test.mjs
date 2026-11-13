// 2026-11-13 (卡片 V, #117, ruling 甲). work-api used to start serving without anyone asking whether
// the database behind it holds the migration chain compiled into the binary: cmd/work-api/main.go
// reads env, opens a pool and serves, and `work_api` has no SELECT on work.schema_migration by
// ruling - so the check cannot live in that process without widening the permission surface, which
// 乙 was rejected for. 甲 put a refusal in the boot path instead, and the carrier turned out to be a
// companion root unit rather than the literal `ExecStartPre` the ruling named, for two machine
// reasons read off the unit itself (ProtectHome=true masks /root, NoNewPrivileges=true strips sudo's
// setuid transition, and the migrator DSN only exists in /root/work-secrets.env).
//
// What this guard pins: the refusal exists, is opt-in, is reachable from a work-api start, is
// delivered by the package AND installed by the rollout, and did not buy itself a wider sandbox for
// the app unit or a second credential path. What it does NOT pin: whether the pilot host is running
// this build - that is the rollout's own radius, and nothing here deploys it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSET_DIR = fileURLToPath(new URL('..', import.meta.url));
const WORK_DIR = fileURLToPath(new URL('../../../../../src/work/', import.meta.url));
const ECS = join(WORK_DIR, 'deploy/ecs');
// WORK_DIR keeps its trailing separator (it comes from a URL ending in `/`), so path prefixes here
// are compared in one normalised form - on Windows `join` yields backslashes and the slice below
// would otherwise cut one character too many and rename cmd/ to md/.
const WORK_PREFIX = `${WORK_DIR.replace(/[\\/]+$/, '').replace(/\\/g, '/')}/`;
const CMD = join(WORK_DIR, 'cmd/work-migrate');
const WRAPPER = join(WORK_DIR, 'scripts/ecs-migrate.sh');
const ROLLOUT = join(ECS, 'rollout-r0a-0027.sh');
const API_UNIT = join(ECS, 'work-api.service');
const GATE_UNIT = join(ECS, 'work-chain-check.service');
const DOC = join(ASSET_DIR, '..', '..', 'work-project.md');

// Comment lines describe intent; only code lines may satisfy a structural assertion (the lesson
// release-assets.test.mjs recorded on 2026-11-05, when its own Chinese comment satisfied a check
// after the code stopped doing the work).
const code = (text, hash) => text
  .split(/\r?\n/)
  .map((line, index) => [line, index + 1])
  .filter(([line]) => !new RegExp(`^\\s*${hash}`).test(line));
const goCode = (text) => code(text, '//');
const unitCode = (text) => code(text, '#');

const mainGo = readFileSync(join(CMD, 'main.go'), 'utf8');
const wrapperText = readFileSync(WRAPPER, 'utf8');
const rolloutText = readFileSync(ROLLOUT, 'utf8');
const apiUnit = readFileSync(API_UNIT, 'utf8');
const gateUnit = readFileSync(GATE_UNIT, 'utf8');

const unitValue = (text, key) => {
  const lines = unitCode(text).filter(([line]) => new RegExp(`^\\s*${key}=`).test(line));
  return lines.map(([line]) => line.split('=').slice(1).join('=').trim());
};

test('the chain-tail refusal is an opt-in CLI policy, not a redefinition of status', () => {
  const lines = goCode(mainGo);
  const declared = lines.filter(([line]) => /fs\.Bool\("require-up-to-date"/.test(line));
  assert.equal(declared.length, 1, `expected exactly one declaration of -require-up-to-date, found ${declared.length}`);
  // The default must be false: rollout step 4 runs a plain `work-migrate status` and must keep
  // exiting 0, and a flag that defaults to refusing would silently convert every rollout into a
  // gate nobody asked for.
  assert.match(declared[0][0], /fs\.Bool\("require-up-to-date",\s*false,/, 'the refusal flag no longer defaults to opt-in');
  const guard = lines.filter(([line]) => /if\s+!\*requireUpToDate\s*\|\|/.test(line));
  assert.equal(guard.length, 1, `expected one guard line for the flag, found ${guard.length}`);
  assert.match(guard[0][0], /result\.State == "up_to_date"/, 'the guard no longer keys off the reported ledger state');
  const refusal = lines.filter(([line]) => /ledger_pending_increments/.test(line));
  assert.ok(refusal.length >= 1, 'the refusal code is gone - the flag parses and does nothing (死旋钮)');
  assert.ok(
    lines.some(([line]) => /return\s+&migrate\.Error\{/.test(line)),
    'the refusal must be a *migrate.Error, which is the type main() maps to a non-zero exit',
  );
  // One implementation, not two: the semantics stay in the CLI layer, so nothing else in the tree
  // can quietly grow a second copy of this judgement (卡片 V: 判据不新造第二套).
  const carriers = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'testdata') walk(abs);
      } else if (entry.endsWith('.go')) {
        const text = readFileSync(abs, 'utf8');
        const inCode = goCode(text).some(([line]) => line.includes('require-up-to-date'));
        if (inCode) carriers.push(abs.slice(WORK_PREFIX.length).replace(/\\/g, '/'));
      }
    }
  };
  walk(WORK_DIR);
  assert.deepEqual(
    [...new Set(carriers)].sort(),
    ['cmd/work-migrate/main.go', 'cmd/work-migrate/main_test.go'],
    `-require-up-to-date is implemented in more than one Go file: ${[...new Set(carriers)].join(', ')}`,
  );
});

test('a work-api start actually reaches the refusal, through the shipped wrapper', () => {
  const exec = unitValue(gateUnit, 'ExecStart');
  assert.equal(exec.length, 1, `the gate unit has ${exec.length} ExecStart lines, expected one`);
  assert.match(
    exec[0],
    /^\/usr\/local\/bin\/ecs-migrate\.sh status -require-up-to-date$/,
    `the boot gate does not call the refusal through the wrapper: ${exec[0]}`,
  );
  // The wrapper has to forward the flag, or the unit silently runs a plain status that always exits 0.
  assert.match(wrapperText, /^exec "\$binary" "\$@"$/m, 'ecs-migrate.sh no longer forwards its arguments');
  // #98=B: the wrapper's own default binary is a developer home copy, so the boot path must name the
  // installed one or a restart could run a build that predates the chain it is checking.
  const env = unitValue(gateUnit, 'Environment');
  assert.deepEqual(
    env,
    ['WORK_MIGRATE_BIN=/usr/local/bin/work-migrate'],
    `the gate unit must pin the wrapper to the installed binary, got ${JSON.stringify(env)}`,
  );
  assert.match(rolloutText, /install_binary work-migrate\b/, 'rollout no longer installs work-migrate - the gate would have no binary to run');
  assert.ok(
    /install[^\n]*"\$RELEASE\/ecs-migrate\.sh"[^\n]*\/usr\/local\/bin\/ecs-migrate\.sh/.test(rolloutText),
    'rollout does not install the wrapper the gate unit execs - packaged is not installed (卡片 W)',
  );
  // The verdict must come from the reading rollout already uses, not a second one: the same binary,
  // the same subcommand that step 4 runs after applying.
  assert.match(rolloutText, /work-migrate status/, 'rollout step 4 no longer runs `work-migrate status` - the shared judgement this gate reuses is gone');
});

test('the app unit kept its sandbox and gained no credential path', () => {
  // 甲 was chosen because it does not widen the permission surface. Two lines in the app unit are
  // that surface, so they are pinned as literally unchanged rather than asserted as "still sane".
  assert.deepEqual(unitValue(apiUnit, 'ProtectHome'), ['true'], 'work-api.service lost ProtectHome=true - the ruling traded nothing');
  assert.deepEqual(unitValue(apiUnit, 'NoNewPrivileges'), ['true'], 'work-api.service lost NoNewPrivileges=true');
  assert.deepEqual(
    unitValue(apiUnit, 'EnvironmentFile'),
    ['/etc/work/work-api.env'],
    'work-api.service gained an EnvironmentFile - a migrator DSN in the app process is exactly 乙',
  );
  const secretsLeak = unitCode(apiUnit).filter(([line]) => /Environment=.*(WORK_DATABASE_URL|WORK_MIGRATOR|work-secrets)/.test(line));
  assert.deepEqual(secretsLeak.map(([line]) => line.trim()), [], 'a migration credential was injected into the app unit');
  // The app unit's own comment describes the refusal, so the claim is scoped to the lines that could
  // actually perform it: no Exec* or Environment* line in work-api.service runs or names the check.
  const inAppUnit = unitCode(apiUnit).filter(([line]) => /^\s*(Exec|Environment)/.test(line) && /require-up-to-date/.test(line));
  assert.deepEqual(
    inAppUnit.map(([line]) => line.trim()),
    [],
    'the refusal moved back inside the app unit - it cannot authenticate there (ProtectHome masks /root)',
  );
  // The gate runs as root with its own sandbox, same shape as work-c16-log-scan.service, and is
  // pulled by work-api rather than enabled on its own.
  assert.deepEqual(unitValue(gateUnit, 'User'), ['root'], 'the chain check is not root - it cannot read the migrator secrets file');
  assert.deepEqual(
    unitValue(gateUnit, 'ProtectHome'),
    ['read-only'],
    'the chain check masks /root, which is where the only migrator DSN source is',
  );
  assert.doesNotMatch(gateUnit, /^\[Install\]$/m, 'the chain check was made enable-able on its own - it exists to gate work-api starts');
  assert.match(gateUnit, /^TimeoutStartSec=\d+/m, 'the chain check has no start timeout - a hung database would hang work-api forever');
  assert.deepEqual(
    unitValue(apiUnit, 'Requires').filter((v) => v.includes('work-chain-check.service')),
    ['work-chain-check.service'],
    'work-api no longer Requires the chain check - the refusal is decorative',
  );
  assert.ok(
    unitValue(apiUnit, 'After').some((v) => v.includes('work-chain-check.service')),
    'work-api does not order After the chain check - Requires alone would race it',
  );
});

test('the boot gate reaches the host, and a rollout that cannot serve it refuses to start', () => {
  // 卡片 V 的生效硬前置：unit 在 rollout 里的安装路径曾经为 0，只改仓库那一份到不了现网。
  assert.match(
    rolloutText,
    /install[^\n]*"\$RELEASE\/work-api\.service"[^\n]*\/etc\/systemd\/system\/work-api\.service/,
    'rollout does not install work-api.service - the boot gate would exist only in the repo',
  );
  assert.match(rolloutText, /^run systemctl enable work-api$/m, 'rollout installs work-api.service but never enables it');
  // A package carrying the gate without a readable secrets file means every work-api restart
  // CrashLoops. That is the intended refusal at runtime, but not a reason to walk into it blind.
  const preflight = goCode(rolloutText).filter(([line]) => /work-chain-check\.service/.test(line));
  assert.ok(preflight.length >= 2, `only ${preflight.length} rollout lines mention the gate unit - the preflight went away`);
  assert.ok(
    preflight.some(([line]) => /-r \/root\/work-secrets\.env/.test(line)),
    'rollout no longer checks that the secrets file the boot gate needs is readable',
  );
  assert.ok(
    rolloutText.includes('CrashLoop'),
    'the preflight stopped naming the failure mode an operator would otherwise have to derive',
  );
  assert.match(readFileSync(DOC, 'utf8'), /\*\*卡片 V｜/, 'this wiring has no card in work-project.md §5.0 to own the ruling');
});
