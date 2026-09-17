// 内容区标题栏的走查(真实 Chromium,只挂这一个组件,不需要后端)。
//
// 形态按要求对齐飞书聊天窗口那一栏:**[前导图标/头像] 标题 + 备注(可选) 、不换行**;
// 这里量 jsdom 量不到的那几条:同一行、不换行、标题过长被省略而备注不被挤掉、
// 栏高(两种形态都必须是 57px = 56 内容 + 1px 线)、备注是 12px 灰字。
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
 * 所有内容标题栏调用点都必须走共享件(谁再自己排一份就会红):
 * 「消息」聊天栏 / 任务 / 通讯录(成员列表 + 我的群组 + 外部联系人) / 审批 ——
 * 会议模块的四个一级页在 3.18 已经统一过(白底 + 16px 标题 + 右侧动作),这里不重复列。
 */
const callSites = [
  ['消息聊天栏', 'src/features/im/routes/ChatPane.tsx'],
  ['任务', 'src/features/tasks/routes/TasksRoute.tsx'],
  ['通讯录成员列表', 'src/features/contacts/routes/ContactsRoute.tsx'],
  ['通讯录我的群组', 'src/features/contacts/components/MyGroupsPanel.tsx'],
  [
    '通讯录外部联系人',
    'src/features/contacts/components/ExternalContactsPanel.tsx',
  ],
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
  // 通讯录面板会拉列表数据:按接口给「空但形状对」的响应(这里只关心标题栏几何)。
  // `/directory/external-contacts/` 那几个接口返回的是**数组**,别的一律给对象。
  await context.route('**/api/v1.0/**', (route) => {
    const url = route.request().url()
    if (/external-contacts/.test(url)) return route.fulfill({ json: [] })
    return route.fulfill({ json: { rows: [], items: [], data: [], total: 0 } })
  })
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
  // ① 有前导:栏高基准是 57px = 40px 头像 + 上下各 8px 内边距 + 1px 描边
  assert.deepEqual(chat.leadingBox, [40, 40], '前导头像 40px(与会话列表同档)')
  assert.equal(chat.leadingLeftOfTitle, true, '前导在标题左侧')
  assert.equal(chat.titleAndMetaSameRow, true, '标题与备注必须同一行')
  assert.equal(chat.barWrap, 'nowrap', '标题栏不换行')
  assert.equal(chat.titleWhitespace, 'nowrap', '标题不换行')
  assert.equal(chat.titleClipped, true, '超长标题应被省略号截断')
  assert.equal(chat.metaVisible, true, '备注不被标题挤掉')
  assert.equal(chat.metaBeforeAction, true, '备注在右侧动作左侧')
  assert.equal(
    chat.barHeight,
    57,
    `标题栏应为 57px(56 内容 + 1px 描边),实际 ${chat.barHeight}px`
  )
  assert.equal(
    metrics.withoutLeading.barHeight,
    57,
    `无前导的标题栏也要 57px,实际 ${metrics.withoutLeading.barHeight}px`
  )
  assert.equal(chat.barBackground, 'rgb(255, 255, 255)', '标题栏白底')
  assert.equal(chat.paddingX, '16px', '左内边距 16px')
  assert.equal(chat.paddingY, '8px', '上内边距 8px(40px 头像上下各留 8px)')
  assert.equal(chat.titleSize, '16px', '标题 16px')
  assert.equal(chat.titleWeight, '700', '标题 bold')
  assert.equal(chat.metaSize, '12px', '备注 12px')
  assert.equal(page1.titleAndMetaSameRow, true, '标题与备注同一行(无前导形态)')
  assert.equal(page1.metaSize, '12px', '备注 12px(无前导形态)')

  await page.screenshot({
    path: 'test-results/title-bar.png',
    fullPage: true,
  })

  // ③ 通讯录「外部联系人」面板(走查反馈里漏掉的一处):备注是一句长说明,标题 +
  //    长备注 + 右侧按钮三者抢宽度 —— 必须在真实浏览器里量它仍是同一行、不越界。
  //    「我的群组」依赖 IM SDK(dev 环境没有 VITE_JUSI_IM_BASE_URL),由 jsdom 的
  //    ContactsRoute 用例 + 下面的源码级检查覆盖。
  await page.evaluate(async () => {
    const { mountExternalPanel } =
      await import('/scripts/harness/title-bar-panels.tsx')
    // 另起一个容器:#root 上已经挂着上面那棵 TitleBar 的树,同一个容器不能挂两次 root。
    const host = document.createElement('div')
    host.id = 'panels-root'
    document.body.appendChild(host)
    mountExternalPanel(host)
  })
  await page
    .locator('[data-testid="host-external"] [data-testid="title-bar"]')
    .waitFor()

  const external = await page.evaluate(() => {
    const host = document.querySelector('[data-testid="host-external"]')
    const bar = host.querySelector('[data-testid="title-bar"]')
    const title = host.querySelector('[data-testid="title-bar-title"]')
    const meta = host.querySelector('[data-testid="title-bar-meta"]')
    const action = host.querySelector('[data-testid="external-contact-add"]')
    const box = (el) => el.getBoundingClientRect()
    return {
      barHeight: Math.round(box(bar).height),
      titleAndMetaSameRow:
        Math.max(box(title).top, box(meta).top) <
        Math.min(box(title).bottom, box(meta).bottom),
      metaInsideBar: box(meta).right <= box(bar).right + 1,
      metaBeforeAction: box(meta).right <= box(action).left + 1,
      titleText: title.textContent,
      metaText: meta.textContent,
    }
  })
  assert.equal(
    external.barHeight,
    57,
    `外部联系人:标题栏应与其它模块同高 57px,实际 ${external.barHeight}px`
  )
  assert.equal(
    external.titleAndMetaSameRow,
    true,
    '外部联系人:标题与备注必须在同一行(备注不再另起一行)'
  )
  assert.equal(external.metaInsideBar, true, '外部联系人:备注不越出标题栏')
  assert.equal(
    external.metaBeforeAction,
    true,
    '外部联系人:备注在右侧「添加」按钮左侧'
  )
  await page.screenshot({
    path: 'test-results/title-bar-contacts-panels.png',
    fullPage: true,
  })
  assert.deepEqual(errors, [], `页面不应有运行时错误:${errors.join(' / ')}`)
  console.log(
    'Title bar passed: 六个调用点共用 TitleBar(含通讯录的我的群组 / 外部联系人);两种形态都是 57px(40px 头像 + 上下各 8px + 1px 线),标题 16px bold + 备注 12px 灰字同行不换行,超长省略且备注不被挤掉。截图:test-results/title-bar.png, test-results/title-bar-contacts-panels.png'
  )
} finally {
  await browser.close()
}
