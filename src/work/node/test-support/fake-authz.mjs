// Test-only mTLS authorization service for the advanceRuntime capability hop.
// It answers the three parent commands (claim / renew / issue_capability) and
// records the request body so tests can assert the thin wire, the parent client
// certificate and the holder/heartbeat binding.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:https';

export async function createFakeAuthz(pki, { respond, holderId = 'holder-test' } = {}) {
  const requests = [];
  let handler = respond ?? (() => undefined);
  let issuedCount = 0;

  function commandOf(path) {
    return typeof path === 'string' ? path.split('/').pop() : '';
  }

  // Defaults mirror the signed shapes: claim/renew answer with a lease,
  // issue_capability with one opaque token. A test handler may override one
  // command and return undefined for the rest.
  function defaultResult(record) {
    const command = commandOf(record.path);
    if (command === 'claim_runtime_execution') {
      return {
        status: 200,
        body: {
          execution_id: record.body?.execution_id,
          holder_id: holderId,
          state: 'claimed',
        },
      };
    }
    if (command === 'renew_runtime_execution') {
      return {
        status: 200,
        body: {
          execution_id: record.body?.execution_id,
          holder_id: record.body?.holder_id,
          state: 'active',
          lease_until: new Date(Date.now() + 30_000).toISOString(),
        },
      };
    }
    if (command === 'issue_capability') {
      issuedCount += 1;
      return {
        status: 200,
        body: {
          token: `opaque-token-${issuedCount}-${randomBytes(8).toString('hex')}`,
          generation: issuedCount,
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        },
      };
    }
    return { status: 404, body: { code: 'unknown_command' } };
  }

  const server = createServer({
    cert: pki.cert,
    key: pki.key,
    ca: pki.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  }, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      const record = {
        path: req.url,
        method: req.method,
        body,
        authorized: req.socket.authorized === true,
      };
      requests.push(record);

      let result;
      try {
        result = handler(record, requests.length);
      } catch {
        result = undefined;
      }
      if (result === undefined) {
        result = defaultResult(record);
      }
      const payload = Buffer.from(JSON.stringify(result.body ?? {}), 'utf8');
      res.writeHead(result.status ?? 200, {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        'cache-control': 'no-store',
      });
      res.end(payload);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    server,
    requests,
    url: `https://127.0.0.1:${server.address().port}`,
    config: {
      // The certificate CN is localhost; connect by IP with an explicit name.
      url: `https://127.0.0.1:${server.address().port}`,
      ca: pki.ca,
      cert: pki.clientCert,
      key: pki.clientKey,
      serverName: 'localhost',
      timeoutMs: 2000,
    },
    setRespond(next) {
      handler = next;
    },
    reset() {
      requests.length = 0;
      handler = respond ?? (() => undefined);
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
