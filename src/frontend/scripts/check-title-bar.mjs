// 内容区标题栏的走查(真实 Chromium,只挂这一个组件,不需要后端)。
//
// 形态按要求对齐飞书聊天窗口那一栏:**[前导图标/头像] 标题 + 备注(可选) 、不换行**;
// 这里量 jsdom 量不到的那几条:同一行、不换行、标题过长被省略而备注不被挤掉、
// 栏高(两种形态都必须是 48px)、备注是 12px 灰字。
//
// 用法(cwd = src/frontend):
//   npm run dev
//   CAPTURE_TEST_ORIGIN=http://localhost:3187 node scripts/check-title-bar.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://localhost:3187'
const longTitle =
  '这是一个特别特别长的标题用来验证标题栏不会换行也不会把备注挤掉'

/**
 * 六个调用点都必须走共享件(谁再自己排一份标题栏就会红):
 * 「消息」的聊天标题栏 / 任务 / 通讯录 / 审批 —— 会议模块的四个一级页在
 * 3.18 已经统一过(白底 + 16px 标题 + 右侧动作),这里不再重复列。
 */
const callSites = [
  ['消息聊天栏', 'src/features/im/routes/ChatPane.tsx'],
  ['任务', 'src/features/tasks/routes/TasksRoute.tsx'],
  ['通讯录', 'src/features/contacts/routes/ContactsRoute.tsx'],
  ['审批', 'src/features/approval/routes/ApprovalRoute.tsx'],
]
const failures = []
for (const [label, relative] of callSites) {
  const source = readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    'utf8'
  )
  if (!source.includes('TitleBar'))
    failures.push(`${label}(${relative})没有用共享的 TitleBar`)
}
assert.deepEqual(failures, [], failures.join('\n'))

const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 760, height: 200 },
  })
  await context.route('**/title-bar-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div></html>',
    })
  )
  await context.route('**/api/v1.0/**', (route) => route.fulfill({ json: {} }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/title-bar-harness`)
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
    const { TitleBar } = await import('/src/components/TitleBar.tsx')
    const { Avatar, IM_AVATAR_SIZE } =
      await import('/src/features/im/components/Avatar.tsx')
    createRoot(document.getElementById('root')).render(
      React.createElement(
        'div',
        {
          style: {
            width: '360px',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#fff',
          },
        },
        // ① 有前导(会话头像)的形态:聊天标题栏
        React.createElement(
          'div',
          { 'data-testid': 'with-leading' },
          React.createElement(
            TitleBar,
            {
              title: longTitle,
              leading: React.createElement(Avatar, {
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
        ),
        // ② 无前导的形态:任务 / 通讯录 / 审批的内容标题栏
        React.createElement(
          'div',
          { 'data-testid': 'without-leading' },
          React.createElement(TitleBar, {
            title: '我负责的',
            meta: '5 个任务',
          })
        )
      )
    )
  }, longTitle)
  await page.getByTestId('title-bar-meta').first().waitFor()

  const metrics = await page.evaluate(() => {
    const [withLeading, withoutLeading] = [
      document.querySelector('[data-testid="with-leading"]'),
      document.querySelector('[data-testid="without-leading"]'),
    ]
    const read = (host) => {
      const bar = host.querySelector('[data-testid="title-bar"]')
      const leading = host.querySelector('[data-testid="title-bar-leading"]')
      const title = host.querySelector('[data-testid="title-bar-title"]')
      const meta = host.querySelector('[data-testid="title-bar-meta"]')
      const action = host.querySelector('[data-testid="header-action"]')
      const box = (el) => el.getBoundingClientRect()
      const metaStyle = getComputedStyle(meta)
      return {
        barHeight: Math.round(box(bar).height),
        barBackground: getComputedStyle(bar).backgroundColor,
        paddingX: getComputedStyle(bar).paddingLeft,
        paddingY: getComputedStyle(bar).paddingTop,
        barWrap: getComputedStyle(bar).flexWrap,
        titleWhitespace: getComputedStyle(title).whiteSpace,
        titleSize: getComputedStyle(title).fontSize,
        titleWeight: getComputedStyle(title).fontWeight,
        metaSize: metaStyle.fontSize,
        metaColor: metaStyle.color,
        titleAndMetaSameRow:
          Math.max(box(title).top, box(meta).top) <
          Math.min(box(title).bottom, box(meta).bottom),
        titleClipped: title.scrollWidth > title.clientWidth,
        metaVisible: box(meta).right <= box(bar).right + 1,
        metaBeforeAction: action
          ? box(meta).right <= box(action).left + 1
          : true,
        leadingBox: leading
          ? [Math.round(box(leading).width), Math.round(box(leading).height)]
          : null,
        leadingLeftOfTitle: leading
          ? box(leading).right <= box(title).left + 1
          : true,
      }
    }
    return {
      withLeading: read(withLeading),
      withoutLeading: read(withoutLeading),
    }
  })

  const chat = metrics.withLeading
  const page1 = metrics.withoutLeading
  // ① 有前导:48px 是标题栏的高度基准,40px 头像靠 4px 内边距装进去(含 1px 描边 49)
  assert.deepEqual(chat.leadingBox, [40, 40], '前导头像 40px(与会话列表同档)')
  assert.equal(chat.leadingLeftOfTitle, true, '前导在标题左侧')
  assert.equal(chat.titleAndMetaSameRow, true, '标题与备注必须同一行')
  assert.equal(chat.barWrap, 'nowrap', '标题栏不换行')
  assert.equal(chat.titleWhitespace, 'nowrap', '标题不换行')
  assert.equal(chat.titleClipped, true, '超长标题应被省略号截断')
  assert.equal(chat.metaVisible, true, '备注不被标题挤掉')
  assert.equal(chat.metaBeforeAction, true, '备注在右侧动作左侧')
  // 高度基准是 48px:有 40px 前导时内容正好顶到 48,再加 1px 描边是 49 —— 那一像素
  // 来自描边、不是两种形态不同高,所以按「差 <= 1px」断言(肉眼不可辨)。
  assert.ok(
    Math.abs(chat.barHeight - metrics.withoutLeading.barHeight) <= 1,
    `有前导与无前导的标题栏必须同高(差 <=1px),实际 ${chat.barHeight}px / ${metrics.withoutLeading.barHeight}px`
  )
  assert.ok(
    chat.barHeight <= 50,
    `标题栏应在一档控件高(48px + 1px 描边)以内,实际 ${chat.barHeight}px`
  )
  assert.equal(chat.barBackground, 'rgb(255, 255, 255)', '标题栏白底')
  assert.equal(chat.paddingX, '16px', '左内边距 16px')
  assert.equal(
    chat.paddingY,
    '4px',
    '有前导时上内边距 4px(把 40px 头像装进 48px)'
  )
  assert.equal(chat.titleSize, '16px', '标题 16px')
  assert.equal(chat.titleWeight, '700', '标题 bold')
  assert.equal(chat.metaSize, '12px', '备注 12px')
  assert.equal(page1.titleAndMetaSameRow, true, '标题与备注同一行(无前导形态)')
  assert.equal(page1.metaSize, '12px', '备注 12px(无前导形态)')

  await page.screenshot({
    path: 'test-results/title-bar.png',
    fullPage: true,
  })
  assert.deepEqual(errors, [], `页面不应有运行时错误:${errors.join(' / ')}`)
  console.log(
    'Title bar passed: 四个调用点共用 TitleBar;两种形态都是 48px(有 40px 前导头像时靠 4px 内边距装进去),标题 16px bold + 备注 12px 灰字同行不换行,超长省略且备注不被挤掉。截图:test-results/title-bar.png'
  )
} finally {
  await browser.close()
}
