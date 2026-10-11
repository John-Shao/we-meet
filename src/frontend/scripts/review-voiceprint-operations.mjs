import { createRequire } from 'node:module'
import { createServer as httpServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
  .replace(/\\/g, '/')
  .replace(/\/$/, '')
const require = createRequire(`${root}/package.json`)
const { chromium, expect } = require('@playwright/test')
const { createServer, transformWithEsbuild } = await import(
  pathToFileURL(`${root}/node_modules/vite/dist/node/index.js`)
)
const owner = '44444444-4444-4444-8444-444444444444'
const org = '55555555-5555-4555-8555-555555555555'
const port = Number(process.env.VOICEPRINT_OPERATIONS_REVIEW_PORT || 5321)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid local port')
const origin = `http://127.0.0.1:${port}`
const artifact =
  process.env.VOICEPRINT_OPERATIONS_REVIEW_ARTIFACT_DIR ||
  `${root}/test-results/voiceprint-operations`
const fixture = {
  schema_version: 1,
  window_hours: 24,
  observed_at: '2026-10-11T08:00:00Z',
  available: false,
  queues: Object.fromEntries(
    ['encoding', 'quality', 'identification', 'deletion'].map((name) => [
      name,
      {
        states: { queued: 2, running: 1, failed: 4 },
        completed_in_window: 5,
        oldest_pending_seconds: 12,
        request_to_finish_p95_seconds: null,
      },
    ])
  ),
  contribution_cleanup: { queued: 2, purged: 3 },
  profiles: { paused: 6 },
  samples_in_window: { declared_quality_speech_ms: 30000 },
  suggestions_in_window: {
    human_rejected_suggestions: 7,
    results: Object.fromEntries(
      [
        'unknown',
        'ambiguous',
        'insufficient_audio',
        'mixed_speaker',
        'unavailable',
      ].map((name) => [name, 1])
    ),
  },
}
let revoked = false,
  reads = 0,
  invalidReads = 0,
  browser
const errors = [],
  blocked = [],
  cases = []
const api = httpServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization,content-type,x-voiceprint-owner'
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const valid =
    req.method === 'GET' &&
    req.url === `/api/v1.0/voiceprint/organizations/${org}/operations/` &&
    req.headers['x-voiceprint-owner'] === owner
  if (!valid) invalidReads++
  else reads++
  res.writeHead(!valid ? 404 : revoked ? 403 : 200, {
    'Content-Type': 'application/json',
  })
  res.end(
    JSON.stringify(
      !valid || revoked
        ? { code: 'voiceprint_organization_admin_required' }
        : fixture
    )
  )
})
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
const apiOrigin = `http://127.0.0.1:${api.address().port}`
process.env.VITE_API_BASE_URL = apiOrigin
const harness = `import React from 'react';import{createRoot}from'react-dom/client';
import '/src/styles/index.css';import '/src/i18n/init';
import{setTokens}from'/src/features/auth/utils/tokenStorage';
import{VoiceprintClient}from'/src/features/voiceprint/api';
import{VoiceprintOperationsPanel}from'/src/features/voiceprint/VoiceprintOperationsPanel';
localStorage.setItem('i18nextLng','zh');setTokens({accessToken:'isolated-synthetic-admin'});
createRoot(document.getElementById('root')).render(<main style={{maxWidth:720,margin:'auto',padding:16}}><VoiceprintOperationsPanel client={new VoiceprintClient('${org}','${owner}')}/></main>);`
const vite = await createServer({
  root,
  server: { host: '127.0.0.1', port, strictPort: true },
  plugins: [
    {
      name: 'voiceprint-operations-review',
      resolveId(id) {
        if (id === 'virtual:voiceprint-operations.tsx')
          return '\0virtual:voiceprint-operations.tsx'
      },
      async load(id) {
        if (id === '\0virtual:voiceprint-operations.tsx')
          return (
            await transformWithEsbuild(harness, 'operations.tsx', {
              loader: 'tsx',
              jsx: 'transform',
            })
          ).code
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== '/operations-review') return next()
          const html = await server.transformIndexHtml(
            req.url,
            '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:voiceprint-operations.tsx"></script></body></html>'
          )
          res.setHeader('Content-Type', 'text/html')
          res.end(html)
        })
      },
    },
  ],
})
try {
  await mkdir(artifact, { recursive: true })
  await vite.listen()
  browser = await chromium.launch({ headless: true })
  for (const width of [1280, 390]) {
    revoked = false
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      locale: 'zh-CN',
    })
    await context.route('**/*', (route) => {
      if ([origin, apiOrigin].includes(new URL(route.request().url()).origin))
        return route.continue()
      blocked.push('external_request')
      return route.abort()
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${origin}/operations-review`)
    const button = page.getByRole('button', { name: '查看／刷新运行状态' })
    await button.click()
    await expect(
      page.getByText('贡献清理积压 5；暂停档案 6；近 24 小时人工拒绝建议 7')
    ).toBeVisible()
    await expect(
      page.getByText('最早积压时长 12 秒；请求至完成 P95 暂无数据')
    ).toHaveCount(4)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    )
    if (overflow) throw new Error('Horizontal overflow')
    await page.screenshot({ path: `${artifact}/${width}.png`, fullPage: true })
    revoked = true
    await button.click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByText(/贡献清理积压 5/)).toHaveCount(0)
    cases.push({
      width,
      aggregates: true,
      overflow: false,
      failed_refresh_cleared: true,
    })
    await context.close()
  }
  if (invalidReads || errors.length || blocked.length)
    throw new Error('Fixture isolation or page failure')
  const result = {
    synthetic_only: true,
    cases,
    reads,
    invalid_reads: invalidReads,
    page_errors: errors.length,
    external_requests: blocked.length,
  }
  await writeFile(`${artifact}/result.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await vite.close()
  await new Promise((resolve) => api.close(resolve))
}
