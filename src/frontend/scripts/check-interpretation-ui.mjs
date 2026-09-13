// Native Chromium checks with context fixtures; no meeting, provider or API calls.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 900 } })
  await context.route('**/interpretation-ui-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Interpretation check</title><main style="max-width:440px;margin:auto"><h1 style="padding:16px">会议同声传译</h1><div id="root"></div></main></html>' }))
  await context.route('**/api/**', route => route.abort('blockedbyclient'))
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/interpretation-ui-harness`)
  await page.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined
    window.$RefreshSig$ = () => type => type
    window.__vite_plugin_react_preamble_installed__ = true
    await import('/src/styles/index.css')
    await import('/src/i18n/init.ts')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const { InterpretationContext } = await import('/src/features/meetings/interpretationContext.ts')
    const { InterpretationPanel } = await import('/src/features/meetings/components/InterpretationPanel.tsx')
    window.interpretationActions = []
    function Harness() {
      const [listening, setListening] = React.useState()
      const [muted, setMuted] = React.useState(false)
      const [uncertain, setUncertain] = React.useState(false)
      window.setInterpretationUncertain = setUncertain
      const channels = [
        { id: 'en-channel', target: 'en', generation: 1, state: 'translating', error_code: '' },
        { id: 'zh-channel', target: 'zh', generation: 1, state: 'prepared', error_code: '' },
      ]
      const state = {
        visible: true, available: true, canControl: true, canJoin: true, channels,
        listening, muted, ready: !!listening, pending: false, uncertain, error: uncertain,
        rows: listening ? [
          { id: 'one', sourceSid: 'PA_one', text: 'We will complete the interface review this week and confirm the next release scope.', stash: '', final: true },
          { id: 'two', sourceSid: 'PA_two', text: 'Please keep the recording and meeting minutes connected.', stash: '', final: true },
        ] : [],
        speakerName: sid => sid === 'PA_one' ? '产品负责人' : '设计负责人',
        choose: async channel => { window.interpretationActions.push(['choose', channel?.id]); setListening(channel?.id) },
        control: async (target, operation) => window.interpretationActions.push(['control', target, operation]),
        toggleSound: () => setMuted(!muted), canPlay: () => false,
        resubmit: async () => { window.interpretationActions.push(['resubmit']); setUncertain(false) },
      }
      return React.createElement(InterpretationContext.Provider, { value: state }, React.createElement(InterpretationPanel))
    }
    createRoot(document.getElementById('root')).render(React.createElement(React.Suspense, { fallback: 'Loading…' }, React.createElement(Harness)))
  })
  await page.getByRole('button', { name: '收听英语', exact: true }).click()
  await page.getByText('已连接译音', { exact: true }).waitFor()
  await page.screenshot({ path: 'test-results/interpretation-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'test-results/interpretation-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '停止收听英语', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.interpretationActions), [['choose', 'en-channel'], ['choose', undefined]])
  await page.getByRole('button', { name: '结束英语频道（所有收听者）', exact: true }).click()
  await page.evaluate(() => window.setInterpretationUncertain(true))
  await page.getByRole('status').waitFor()
  assert.equal(await page.getByRole('button', { name: '收听英语', exact: true }).isDisabled(), true)
  await page.screenshot({ path: 'test-results/interpretation-uncertain-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '确认上次操作结果', exact: true }).click()
  assert.deepEqual(errors, [])
  console.log('Interpretation UI passed: desktop/mobile, personal listening versus shared channel stop, explicit recovery, no overflow. No real audio or API calls.')
} finally { await browser.close() }
