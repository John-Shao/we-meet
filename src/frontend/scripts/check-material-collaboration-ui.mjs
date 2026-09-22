// Fixture-only visual acceptance. No live invitations or chat messages are sent.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const browser = await chromium.launch({ headless: true })
try {
  await mkdir('test-results', { recursive: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 850 } })
  const owner = { id: '11111111-1111-4111-8111-111111111111', name: '林晓', role: 'owner', active: true }
  const peer = { id: '22222222-2222-4222-8222-222222222222', name: '陈晨', role: 'reader', active: true }
  let denied = false
  const writes = []
  await context.route('**/collaboration-ui-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>分享与协作验收</title><div id="root"></div></html>' }))
  await context.route('**/api/v1.0/**', route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === 'POST') {
      writes.push(route.request().postDataJSON())
      return route.fulfill({ json: { revision: 1 } })
    }
    if (path.endsWith('/config/')) return route.fulfill({ json: {} })
    if (path.endsWith('/users/me/')) return route.fulfill({ json: { id: owner.id, full_name: owner.name } })
    if (denied) return route.fulfill({ status: 404, json: {} })
    const scope = path.includes('/minutes/') ? 'minutes' : 'record'
    if (path.endsWith('/candidates/')) return route.fulfill({ json: { results: [peer], next_cursor: null } })
    if (path.endsWith('/preview/')) return route.fulfill({ json: { role: 'editor', excerpt: '本次讨论比较了结果导向与过程监督两种管理方式，明确了下一步协作安排。\n\n总结\n关注团队目标，为执行保留合理的自主空间。', media_type: 'audio', media_url: null, duration_ms: 47000 } })
    return route.fulfill({ json: { scope, record_id: 'record', revision: 0, can_manage: true, is_owner: true, link_scope: 'private', can_link_organization: true, results: [owner], count: 1, can_notify: true, pending_notifications: 0 } })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:3187/collaboration-ui-harness')
  await page.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined
    window.$RefreshSig$ = () => type => type
    window.__vite_plugin_react_preamble_installed__ = true
    await import('/src/styles/index.css')
    await import('/src/i18n/init.ts')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const dom = await import('/node_modules/.vite/deps/react-dom_client.js')
    const createRoot = dom.createRoot ?? dom.default.createRoot
    const { QueryClient, QueryClientProvider } = await import('/node_modules/.vite/deps/@tanstack_react-query.js')
    const { setTokens } = await import('/src/features/auth/utils/tokenStorage.ts')
    setTokens({ accessToken: 'fixture-only' })
    const { MaterialActions } = await import('/src/features/meetings/components/MaterialActions.tsx')
    const { MeetingRecordCardMessage } = await import('/src/features/im/components/MeetingRecordCardMessage.tsx')
    window.materialClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    window.materialClient.setQueryData(['user'], { id: '11111111-1111-4111-8111-111111111111', full_name: '林晓' })
    window.materialClient.setQueryData(['config'], {})
    createRoot(document.getElementById('root')).render(React.createElement(React.Suspense, { fallback: 'Loading' }, React.createElement(QueryClientProvider, { client: window.materialClient },
      React.createElement('main', { style: { padding: 20, maxWidth: 820, margin: 'auto' } },
        React.createElement('h1', {}, '中国老板'),
        React.createElement(MaterialActions, { recordId: 'record', viewerId: 'viewer', scope: 'record', title: '中国老板' }),
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, marginTop: 24 } }, ...['minutes', 'record'].map(scope => React.createElement(MeetingRecordCardMessage, { key: scope, body: JSON.stringify({ v: 1, record_id: 'record', title: '中国老板', scope }), senderName: '林晓', onOpen: card => { window.lastOpened = card } })))))))
  })
  await page.getByText('你可编辑', { exact: true }).first().waitFor()
  await page.screenshot({ path: 'test-results/material-cards-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '分享', exact: true }).click()
  await page.getByRole('button', { name: '发送至会话', exact: true }).waitFor()
  assert.equal(await page.getByText('邀请协作者', { exact: true }).count(), 0)
  await page.screenshot({ path: 'test-results/material-share-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '协作者管理', exact: true }).click()
  // 邀请是「一个弹窗、两个视图」:成员名单 → 选人(复用通讯录多选面板),
  // 整批共用一个角色,不再经过逐人配置的「下一步」确认页。
  await page.getByRole('button', { name: '邀请协作者', exact: true }).click()
  // candidates 用的是游标分页契约;面板先加载再渲染,所以等行出现再点。
  const inviteRow = page.getByTestId(`material-invite-item-${peer.id}`)
  await inviteRow.waitFor()
  assert.equal(await inviteRow.getByText(peer.name).count(), 1)
  await inviteRow.click()
  assert.equal(await inviteRow.getAttribute('aria-pressed'), 'true')
  // 手机宽度也要能走完邀请:先切窄,再选角色 —— 基元 Select 的弹层按触发器宽度
  // 定宽(min-w --trigger-width),桌面宽度下开出来的那层在窄视口里会横向溢出。
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '角色' }).click()
  await page.getByRole('option', { name: '可编辑' }).click()
  // 弹层按触发器宽度定宽,窄视口下要先关掉再量横向溢出/截图。
  await page.getByRole('heading', { name: '邀请协作者' }).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'test-results/material-invite-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '邀请协作者', exact: true }).click()
  await page.getByText('已保存', { exact: true }).waitFor()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].members[0].role, 'editor')
  assert.equal(writes[0].members[0].id, peer.id)
  await page.getByRole('button', { name: '关闭', exact: true }).last().click()
  await page.getByTestId('im-msg-meeting-record-card').last().click()
  assert.equal(await page.evaluate(() => window.lastOpened.scope), 'record')
  denied = true
  await page.evaluate(() => window.materialClient.invalidateQueries({ queryKey: ['meeting-material-preview'] }))
  await page.getByText('暂无访问权限或内容不可用', { exact: true }).first().waitFor()
  assert.equal(await page.getByText('你可编辑', { exact: true }).count(), 0)
  assert.deepEqual(errors, [])
  console.log('PASS: two share actions, separate collaborators, mobile invitation, scoped cards and revocation')
} finally { await browser.close() }
