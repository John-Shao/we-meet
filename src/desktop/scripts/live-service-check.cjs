// Real service preflight only: this is NOT desktop PKCE or UI acceptance.
// Supply the explicitly authorized demo credentials through environment variables.
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

;(async () => {
  const origin = 'https://meet.we-meet.online'
  const phone = process.env.WEMEET_DEMO_PHONE
  const otp = process.env.WEMEET_DEMO_OTP
  if (!/^1380000000[0-9]$/.test(phone || '') || !otp) {
    throw new Error('Set WEMEET_DEMO_PHONE (authorized demo range) and WEMEET_DEMO_OTP')
  }
  const checks = []
  let accessToken
  const request = async (endpoint, body, authenticated = false) => {
    const response = await fetch(origin + endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authenticated ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(30000),
    })
    const data = await response.json().catch(() => null)
    return { response, data }
  }
  const record = (endpoint, status, passed) => {
    checks.push({ endpoint, status, passed: Boolean(passed) })
    console.log(`${passed ? 'PASS' : 'FAIL'} ${endpoint}: HTTP ${status}`)
  }
  try {
    const sent = await request('/api/mobile/auth/send-otp/', { phone })
    record('/api/mobile/auth/send-otp/', sent.response.status, sent.response.ok && sent.data?.success === true)
    if (!checks.at(-1).passed) { process.exitCode = 1; return }
    const login = await request('/api/mobile/auth/verify-otp/', { phone, otp })
    record('/api/mobile/auth/verify-otp/', login.response.status, login.response.ok && typeof login.data?.access_token === 'string')
    if (!checks.at(-1).passed) { process.exitCode = 1; return }
    accessToken = login.data.access_token
    // No response bodies, credentials, user identities or document titles are persisted.
    for (const endpoint of ['/api/v1.0/users/me/', '/api/v1.0/rooms/',
      '/api/v1.0/meeting-records/', '/api/v1.0/docs/my-documents/']) {
      const result = await request(endpoint, undefined, true)
      record(endpoint, result.response.status, result.response.ok && result.data !== null)
    }
    const im = await request('/api/v1.0/im/token/', {}, true)
    record('/api/v1.0/im/token/', im.response.status, im.response.ok && typeof im.data?.token === 'string' && typeof im.data?.ws_url === 'string')
    const docs = await request('/api/v1.0/docs/session/', { next: '/' }, true)
    const ticket = typeof docs.data?.url === 'string' ? new URL(docs.data.url) : null
    const trustedTicket = ticket?.origin === 'https://docs.we-meet.online' && ticket.pathname === '/api/v1.0/session-from-ticket/'
    record('/api/v1.0/docs/session/', docs.response.status, docs.response.ok && trustedTicket)
    if (trustedTicket) {
      const redeemed = await fetch(ticket, { redirect: 'manual', signal: AbortSignal.timeout(30000) })
      const cookies = redeemed.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
      record('docs:session-from-ticket', redeemed.status, [302, 303].includes(redeemed.status) && Boolean(cookies))
      if (cookies) {
        const me = await fetch('https://docs.we-meet.online/api/v1.0/users/me/', {
          headers: { Cookie: cookies }, redirect: 'error', signal: AbortSignal.timeout(30000),
        })
        record('docs:users/me', me.status, me.ok)
      }
    }
  } finally {
    accessToken = undefined
    if (checks.length !== 10 || checks.some(check => !check.passed)) process.exitCode = 1
    const output = path.resolve(__dirname, '../test-results')
    mkdirSync(output, { recursive: true })
    writeFileSync(path.join(output, 'live-service-check.json'), JSON.stringify({
      testedAt: new Date().toISOString(), origin, authMethod: 'existing mobile OTP API', checks,
      passed: checks.length === 10 && checks.every(check => check.passed),
      limitation: 'Service API preflight only. No desktop system-browser PKCE, callback, session restart, business UI, media, message delivery or file transfer acceptance.',
    }, null, 2))
  }
})().catch(() => { console.error('Service preflight failed; no response bodies or credentials logged.'); process.exitCode = 1 })
