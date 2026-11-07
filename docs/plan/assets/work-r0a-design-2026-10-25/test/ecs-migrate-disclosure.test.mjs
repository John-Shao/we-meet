// 2026-11-07 (#97): ecs-migrate.sh is not in the release package and nothing in rollout or CI calls
// it, so it is an operator convenience wrapper - and its default binary is a developer's home copy.
// Measured on the pilot host: that home copy was an Oct-29 build while /usr/local/bin/work-migrate
// was the current build from that day's rollout. The chain is embedded in the binary, so the default
// would run something predating 0028..0034 against a ledger-34 database. Changing the default is a
// visible behaviour change and is registered for a ruling instead of being decided here; what this
// guard pins is that the hazard stays disclosed and the documented escape hatch keeps working.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const SCRIPT = join(ASSET_DIR, '..', '..', 'src', 'work', 'scripts', 'ecs-migrate.sh');
const text = readFileSync(SCRIPT, 'utf8');
const lines = text.split(/\r?\n/);
const header = lines.filter((l) => /^\s*#/.test(l)).join('\n');
const code = lines.filter((l) => !/^\s*#/.test(l)).join('\n');

test('the binary-selection hazard is disclosed where an operator will read it', () => {
  assert.match(header, /WORK_MIGRATE_BIN/, 'the header must name the override it tells people to use');
  assert.match(header, /\/usr\/local\/bin\/work-migrate/, 'and name the installed binary to point at');
  assert.match(header, /embedded in work-migrate|chain is embedded/,
    'the reason an old binary is dangerous must be stated, not just "use the new one"');
  assert.match(code, /WORK_MIGRATE_BIN:-/,
    'the override the header recommends must actually exist in the code');
});

test('the credential handling stays out of argv and out of stdout', () => {
  assert.doesNotMatch(code, /set -x|xtrace/, 'xtrace would print the DSN with the password');
  assert.doesNotMatch(code, /echo[^\n]*\$\{?password/, 'the password must never be echoed');
  assert.doesNotMatch(code, /echo[^\n]*WORK_DATABASE_URL/, 'nor the assembled DSN');
  assert.match(code, /compgen -v/,
    'the diagnostic must list variable NAMES only (compgen -v), which is what makes it safe');
  assert.match(code, /exec "\$binary" "\$@"/,
    'the DSN travels in the environment via exec, not as a command-line argument');
});

test('the wrapper still refuses to run unprivileged and still fails closed without a password', () => {
  assert.match(code, /EUID\} -ne 0/, 'the sudo requirement must stay');
  assert.match(code, /if \[\[ -z "\$password" \]\]; then/, 'a missing password must be a refusal');
  assert.match(code, /exit 2/, 'and it must exit non-zero, not continue with an empty credential');
});
