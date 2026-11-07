// 2026-11-07 (#97): verify-r0a-0015.sh and verify-r0a-0016.sh have no caller in any script, unit or
// CI job - their only references are their own usage lines and historical drill evidence. They are
// not dead weight to delete (the evidence cites that exact text) but they are dangerous to run: they
// only know the units and probes of their own rollout, so against a ledger-34 host they print a
// clean-looking report that says nothing about 0017..0034. The header now says so; this guard keeps
// the warning attached and refuses the easy fake fix of marking everything historical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const ECS = join(ASSET_DIR, '..', '..', 'src', 'work', 'deploy', 'ecs');
const SUCCESSOR = 'verify-r0a-0027.sh';
const headerOf = (name) => readFileSync(join(ECS, name), 'utf8')
  .split(/\r?\n/).filter((l) => /^\s*#/.test(l)).join('\n');

const legacy = ['verify-r0a-0015.sh', 'verify-r0a-0016.sh'];

test('each legacy verify says it is historical and names the current one', () => {
  for (const name of legacy) {
    const header = headerOf(name);
    assert.match(header, /HISTORICAL/, `${name} must be marked historical`);
    assert.ok(header.includes(SUCCESSOR), `${name} must name ${SUCCESSOR} as the current check`);
    assert.match(header, /NOT acceptance/i,
      `${name} must say a clean-looking run is not acceptance, otherwise the warning is decorative`);
  }
  assert.ok(existsSync(join(ECS, SUCCESSOR)),
    `the successor named in both headers must exist: ${SUCCESSOR}`);
});

test('the current verify is not itself marked historical', () => {
  // without this, "mark everything historical" would satisfy the test above while leaving
  // operators with no usable acceptance check at all
  const current = headerOf(SUCCESSOR);
  assert.doesNotMatch(current, /HISTORICAL/,
    `${SUCCESSOR} is the current acceptance check and must not carry the historical marker`);
  assert.doesNotMatch(current, /do not use this to accept a current host/i,
    'nor the do-not-use warning');
});

test('the legacy scripts are still the read-only checks their evidence cites', () => {
  // the annotation is comment-only: neither script may have gained a write while being labelled
  for (const name of legacy) {
    const code = readFileSync(join(ECS, name), 'utf8')
      .split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /\b(install|systemctl (restart|stop|start)|psql[^\n]*-c[^\n]*(INSERT|UPDATE|DELETE))\b/i,
      `${name} must stay read-only; the historical label is not a licence to change its behaviour`);
  }
});
