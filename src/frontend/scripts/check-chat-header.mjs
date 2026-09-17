// 聊天窗口标题栏的走查(真实 Chromium,只挂这一个组件,不需要后端/SDK)。
//
// 形态按要求对齐飞书:**头像 + 标题 + 备注(可选,如「5 人」)、不换行**。
// 这里量的是 jsdom 量不到的那几条:同一行、不换行、标题过长被省略而备注不被挤掉。
//
// 用法(cwd = src/frontend):
//   npm run dev
//   CAPTURE_TEST_ORIGIN=http://localhost:3187 node scripts/check-chat-header.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://localhost:3187'
const longTitle =
  '这是一个特别特别长的群聊名字用来验证标题栏不会换行也不会把人数挤掉'

// 会话列表与标题栏必须共用同一个头像尺寸常量(飞书里这两处一样大)。
const avatarSources = [
  ['会话列表', 'src/features/im/components/ConversationList.tsx'],
  ['聊天标题栏', 'src/features/im/routes/ChatPane.tsx'],
]
for (const [label, relative] of avatarSources) {
  const source = readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    'utf8'
  )
  assert.ok(
    source.includes('IM_AVATAR_SIZE'),
    `${label}(${relative})没有用共享的 IM_AVATAR_SIZE —— 两处各写各的尺寸就会对不上`
  )
}

const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 760, height: 120 },
  })
  await context.route('**/chat-header-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div></html>',
    })
  )
  await context.route('**/api/v1.0/**', (route) => route.fulfill({ json: {} }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/chat-header-harness`)
  await page.evaluate(async (longTitle) => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    await import('/src/styles/index.css')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (
      await import('/node_modules/.vite/deps/react-dom_client.js')
    ).default
    const { ChatHeader } =
      await import('/src/features/im/components/ChatHeader.tsx')
    const { Avatar, IM_AVATAR_SIZE } =
      await import('/src/features/im/components/Avatar.tsx')
    createRoot(document.getElementById('root')).render(
      React.createElement(
        'div',
        { style: { width: '360px', display: 'flex', flexDirection: 'column' } },
        React.createElement(
          ChatHeader,
          {
            title: longTitle,
            avatar: React.createElement(Avatar, {
              name: '前',
              size: IM_AVATAR_SIZE,
            }),
            meta: '5 人',
          },
          React.createElement(
            'button',
            { type: 'button', 'data-testid': 'header-action' },
            '发起群聊'
          )
        )
      )
    )
  }, longTitle)
  await page.getByTestId('chat-header-meta').waitFor()

  const metrics = await page.evaluate(() => {
    const header = document.querySelector(
      '[data-testid="chat-header-avatar"]'
    ).parentElement
    const avatar = document.querySelector('[data-testid="chat-header-avatar"]')
    const title = document.querySelector('[data-testid="chat-direct-title"]')
    const meta = document.querySelector('[data-testid="chat-header-meta"]')
    const action = document.querySelector('[data-testid="header-action"]')
    const box = (el) => el.getBoundingClientRect()
    const overlap = (a, b) =>
      Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom)
    return {
      headerHeight: Math.round(box(header).height),
      avatarBox: [
        Math.round(box(avatar).width),
        Math.round(box(avatar).height),
      ],
      avatarLeftOfTitle: box(avatar).right <= box(title).left + 1,
      titleAndMetaSameRow: overlap(box(title), box(meta)),
      titleClipped: title.scrollWidth > title.clientWidth,
      metaVisible: box(meta).right <= box(action).left + 1,
      metaInside: box(meta).right <= box(header).right + 1,
      headerWrap: getComputedStyle(header).flexWrap,
      titleRowWrap: getComputedStyle(title.parentElement).flexWrap,
      titleWhitespace: getComputedStyle(title).whiteSpace,
    }
  })

  assert.deepEqual(
    metrics.avatarBox,
    [40, 40],
    '头像 40px:与会话列表里的头像同一档(IM_AVATAR_SIZE)'
  )
  assert.equal(metrics.avatarLeftOfTitle, true, '头像在标题左侧')
  assert.equal(metrics.titleAndMetaSameRow, true, '标题与备注必须同一行')
  assert.equal(metrics.titleWhitespace, 'nowrap', '标题不换行')
  assert.equal(metrics.titleRowWrap, 'nowrap', '标题行不换行')
  assert.equal(metrics.headerWrap, 'nowrap', '标题栏不换行')
  assert.equal(
    metrics.titleClipped,
    true,
    '超长标题应被省略号截断(而不是把整栏撑高/撑宽)'
  )
  assert.equal(metrics.metaVisible, true, '备注不被标题挤掉(人数必须看得见)')
  assert.equal(metrics.metaInside, true, '备注不越出标题栏')
  assert.ok(
    metrics.headerHeight <= 72,
    `标题栏应是一行的高度(40px 头像 + 上下各 10px 内边距 = 60px 上下),实际 ${metrics.headerHeight}px`
  )
  await page.screenshot({
    path: 'test-results/chat-header.png',
    fullPage: true,
  })
  assert.deepEqual(errors, [], `页面不应有运行时错误:${errors.join(' / ')}`)
  console.log(
    'Chat header passed: 头像 40px(与会话列表同档)+ 标题(超长省略)+ 备注「5 人」同一行、不换行,备注不被挤掉;栏高 %dpx。截图:test-results/chat-header.png',
    metrics.headerHeight
  )
} finally {
  await browser.close()
}
