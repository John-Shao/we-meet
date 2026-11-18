// Local-e2e TEST DOUBLE for the Host v3 Bearer access port (M2b ruling 乙). It stands in for
// Django Host + its mTLS ingress so the real Electron shell can drive the real work-api /
// gateway / Broker chain without the full Host stack. It is NOT a production component and
// does NOT weaken the real port: the token signature IS verified (jose against the local
// Keycloak JWKS), the mTLS client certificate IS required and its CN checked, and the response
// is the exact closed wire shape host.Client.decodeVerifyResponse accepts (four keys, no more).
// What it does NOT do (registered deviations): no org-membership lookup (org_id is the seeded
// e2e org), no auth_epoch persistence (session_revision is a constant 1), no revocation check.
// The real Host verification face is covered by the M1b pytest suite and the production config.
//
// Usage: node scripts/work-e2e-host-stub.mjs  (env: E2E_FIXTURES, E2E_ORG, E2E_ISSUER, E2E_PORT)
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import path from 'node:path'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const fixtures = process.env.E2E_FIXTURES
const org = process.env.E2E_ORG
const issuer = process.env.E2E_ISSUER ?? 'http://localhost:8083/realms/meet'
const port = Number(process.env.E2E_PORT ?? 8444)
if (!fixtures || !org) throw new Error('E2E_FIXTURES and E2E_ORG are required')
const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`))

const server = createServer({
  key: readFileSync(path.join(fixtures, 'host-stub-server.key')),
  cert: readFileSync(path.join(fixtures, 'host-stub-server.pem')),
  ca: readFileSync(path.join(fixtures, 'ca.pem')),
  requestCert: true,
  rejectUnauthorized: true,
}, async (request, response) => {
  const send = (status, value) => {
    response.statusCode = status
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(value))
  }
  if (request.method !== 'POST' || request.url !== '/work-host/v3/sessions/verify') return send(404, { code: 'not_found' })
  const peer = request.socket.getPeerCertificate()
  if (!peer?.subject?.CN || peer.subject.CN !== 'work-control-plane') return send(401, { code: 'session_invalid' })
  const header = request.headers.authorization ?? ''
  if (!header.startsWith('Bearer ')) return send(401, { code: 'session_invalid' })
  try {
    const { payload } = await jwtVerify(header.slice(7), jwks, { issuer })
    if (typeof payload.sub !== 'string' || !payload.sub) return send(401, { code: 'session_invalid' })
    console.log(`verify ok sub=${payload.sub} org=${org}`)
    return send(200, { subject_id: payload.sub, org_id: org, session_revision: 1, verified_at: new Date().toISOString() })
  } catch (error) {
    console.log(`verify refused: ${error.message}`)
    return send(401, { code: 'session_invalid' })
  }
})
server.listen(port, '127.0.0.1', () => console.log(`e2e host stub listening on https://127.0.0.1:${port} (issuer ${issuer})`))