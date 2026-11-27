import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = join(HERE, '..', '..', '..');
const ECS = join(ASSET_DIR, '..', '..', 'src', 'work', 'deploy', 'ecs');
const VERIFY = join(ECS, 'verify-r0a-0027.sh');
const toBashPath = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
const env = {
  ...process.env,
  ...(process.platform === 'win32' ? { MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' } : {}),
};

const openssl = (args) => {
  const result = spawnSync('openssl', args, { encoding: 'utf8', env });
  assert.equal(result.status, 0, `openssl ${args[0]} failed: ${result.stderr || result.error}`);
  return result.stdout;
};

const verify = (cert, key, ca, cn = 'work-governance-events') => spawnSync(
  'bash',
  [toBashPath(VERIFY), '--verify-governance-client', toBashPath(cert), toBashPath(key), toBashPath(ca), cn],
  { encoding: 'utf8', env },
);

const issueCa = (dir, name) => {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  openssl([
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', `/CN=${name}`,
  ]);
  return { key, cert };
};

const issueLeaf = ({ dir, ca, cn = 'work-governance-events', eku = 'clientAuth', days = 1, name = 'client' }) => {
  const key = join(dir, `${name}.key`);
  const csr = join(dir, `${name}.csr`);
  const cert = join(dir, `${name}.crt`);
  const ext = join(dir, `${name}.ext`);
  openssl([
    'req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${cn}`,
  ]);
  writeFileSync(ext, [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature',
    `extendedKeyUsage=${eku}`,
    '',
  ].join('\n'));
  openssl([
    'x509', '-req', '-in', csr, '-CA', ca.cert, '-CAkey', ca.key,
    '-CAcreateserial', '-days', String(days), '-sha256', '-extfile', ext, '-out', cert,
  ]);
  return { key, csr, cert, ext };
};

const withPki = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'governance-client-cert-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('governance client certificate preflight accepts only a valid dedicated identity', () => {
  withPki((dir) => {
    const ca = issueCa(dir, 'work-host-ca');
    const client = issueLeaf({ dir, ca });

    const valid = verify(client.cert, client.key, ca.cert);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /work_governance_client_cert=true/);

    const wrongCn = issueLeaf({ dir, ca, cn: 'work-control-plane', name: 'wrong-cn' });
    assert.notEqual(verify(wrongCn.cert, wrongCn.key, ca.cert).status, 0, 'wrong CN must fail');

    const wrongEku = issueLeaf({ dir, ca, eku: 'serverAuth', name: 'wrong-eku' });
    assert.notEqual(verify(wrongEku.cert, wrongEku.key, ca.cert).status, 0, 'serverAuth must fail');

    const other = issueLeaf({ dir, ca, name: 'other-key' });
    assert.notEqual(verify(client.cert, other.key, ca.cert).status, 0, 'mismatched key must fail');

    const otherCa = issueCa(dir, 'other-ca');
    assert.notEqual(verify(client.cert, client.key, otherCa.cert).status, 0, 'untrusted CA must fail');

    const expired = issueLeaf({ dir, ca, days: 0, name: 'expired' });
    assert.notEqual(verify(expired.cert, expired.key, ca.cert).status, 0, 'expired certificate must fail');

    assert.notEqual(verify(join(dir, 'missing.crt'), client.key, ca.cert).status, 0, 'missing cert must fail');
  });
});
