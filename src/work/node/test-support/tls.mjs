// Test-only PKI for the mTLS advanceRuntime transport tests. Certificates are
// generated with the local OpenSSL CLI into a temporary directory; no fixture
// private key is committed.

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function openssl(args, cwd) {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

export async function createTLSFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'work-runtime-tls-'));
  try {
    const caConfig = `[req]
prompt = no
distinguished_name = dn
x509_extensions = v3_ca
[dn]
CN = work-runtime-test-ca
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`;
    await writeFile(join(dir, 'ca.cnf'), caConfig);
    openssl([
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
      '-keyout', 'ca.key', '-out', 'ca.crt', '-config', 'ca.cnf',
    ], dir);

    const serverConfig = `[req]
prompt = no
distinguished_name = dn
req_extensions = v3_req
[dn]
CN = localhost
[v3_req]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
DNS.1 = localhost
IP.1 = 127.0.0.1
`;
    await writeFile(join(dir, 'server.cnf'), serverConfig);
    openssl([
      'req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', 'server.key', '-out', 'server.csr', '-config', 'server.cnf',
    ], dir);
    openssl([
      'x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-CAcreateserial', '-out', 'server.crt', '-days', '1', '-sha256',
      '-extfile', 'server.cnf', '-extensions', 'v3_req',
    ], dir);

    const clientConfig = `[req]
prompt = no
distinguished_name = dn
req_extensions = v3_req
[dn]
CN = work-go-worker
[v3_req]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = clientAuth
`;
    await writeFile(join(dir, 'client.cnf'), clientConfig);
    openssl([
      'req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', 'client.key', '-out', 'client.csr', '-config', 'client.cnf',
    ], dir);
    openssl([
      'x509', '-req', '-in', 'client.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-CAcreateserial', '-out', 'client.crt', '-days', '1', '-sha256',
      '-extfile', 'client.cnf', '-extensions', 'v3_req',
    ], dir);

    const [ca, cert, key, clientCert, clientKey] = await Promise.all([
      readFile(join(dir, 'ca.crt')),
      readFile(join(dir, 'server.crt')),
      readFile(join(dir, 'server.key')),
      readFile(join(dir, 'client.crt')),
      readFile(join(dir, 'client.key')),
    ]);
    return {
      dir,
      ca,
      cert,
      key,
      clientCert,
      clientKey,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
