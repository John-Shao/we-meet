// 「二级导航栏」共享栏头的走查(真实 Chromium,不需要后端)。
//
// 守两件事:
//   ① 栏头只有**一处定义**:消息 / 日历 / 审批 / 任务 / 会议六个模块都得用
//      components/SubNav 的 SubNavHeader + SubNavStrip,不许再手写一份
//      (手写的那几份原先标题分别落在 16 / 20 / 28px 三个位置,收起按钮的位置
//       也各不相同)。这条是源码级检查,避免「改了共享件但某个模块没跟上」。
//   ② 基准数字(以「通讯录」左栏为准)在真实浏览器里量得到:
//      标题 16px / bold、栏头内边距 16px / 12px、收起按钮 28×28、窄条 36px。
//
// 用法(cwd = src/frontend):
//   npm run dev
//   CAPTURE_TEST_ORIGIN=http://localhost:3187 node scripts/check-subnav-panels.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://localhost:3187'

/**
 * 六个模块的二级导航栏载体:源码级检查它们确实走共享件。
 * 一个模块可能拆两个文件 —— 面板组件 + 持有收起态的路由(通讯录那套写法)。
 */
const modules = [
  ['消息', ['src/features/im/routes/ImRoute.tsx']],
  [
    '日历',
    [
      'src/features/calendar/components/CalendarSidebar.tsx',
      'src/features/calendar/routes/CalendarRoute.tsx',
    ],
  ],
  ['审批', ['src/features/approval/routes/ApprovalRoute.tsx']],
  [
    '任务',
    [
      'src/features/tasks/components/TaskWorkspaceNavigation.tsx',
      'src/features/tasks/routes/TasksRoute.tsx',
    ],
  ],
  ['会议', ['src/features/meetings/components/MeetingNavPanel.tsx']],
  // 通讯录是这套基准的来源,2026-09-17 也折进共享件了(圆角一并归到 control)。
  [
    '通讯录',
    [
      'src/features/contacts/components/ContactsSidebar.tsx',
      'src/features/contacts/routes/ContactsRoute.tsx',
    ],
  ],
]

const failures = []
for (const [label, relatives] of modules) {
  const sources = relatives.map((relative) => [
    relative,
    readFileSync(
      fileURLToPath(new URL(`../${relative}`, import.meta.url)),
      'utf8'
    ),
  ])
  const joined = sources.map(([, source]) => source).join('\n')
  for (const [needle, why] of [
    ['SubNavHeader', '栏头应走共享件 SubNavHeader'],
    ['SubNavStrip', '收起态应走共享件 SubNavStrip'],
    ['useCollapsibleSubNav', '收起态应走共享 hook'],
  ]) {
    if (!joined.includes(needle))
      failures.push(`${label}:${relatives.join(' + ')} ${why}`)
  }
  // 手写栏头的特征:自己画收起图标(共享件里才应该出现 RiArrowLeftDoubleLine)。
  for (const [relative, source] of sources) {
    if (source.includes('RiArrowLeftDoubleLine'))
      failures.push(`${label}:${relative} 自己画了收起图标,应交给 SubNavHeader`)
  }
}
assert.deepEqual(failures, [], failures.join('\n'))

const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1180, height: 900 },
  })
  await context.route('**/subnav-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div></html>',
    })
  )
  await context.route('**/api/v1.0/**', (route) => route.fulfill({ json: {} }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/subnav-harness`)
  await page.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_preamble_installed__ = true
    await import('/src/styles/index.css')
    await import('/src/i18n/init.ts')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (
      await import('/node_modules/.vite/deps/react-dom_client.js')
    ).default
    const { SubNavHeader, SubNavStrip } =
      await import('/src/components/SubNav.tsx')
    const { useCollapsibleSubNav } =
      await import('/src/components/useCollapsibleSubNav.ts')
    const Harness = () => {
      const { collapsed, toggle } = useCollapsibleSubNav('we-meet:subnav-check')
      return React.createElement(
        'aside',
        {
          style: {
            width: '260px',
            height: '600px',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: 'var(--colors-subNavBg)',
            borderRight: '1px solid var(--colors-border-subtle)',
          },
        },
        collapsed
          ? React.createElement(SubNavStrip, {
              onExpand: toggle,
              testId: 'check-expand',
            })
          : React.createElement(
              SubNavHeader,
              {
                title: '模块标题',
                onCollapse: toggle,
                collapseTestId: 'check-collapse',
              },
              React.createElement(
                'button',
                { type: 'button', 'data-testid': 'check-action' },
                '模块动作'
              )
            )
      )
    }
    localStorage.removeItem('we-meet:subnav-check')
    createRoot(document.getElementById('root')).render(
      React.createElement(Harness)
    )
  })
  await page.getByTestId('check-collapse').waitFor()

  const metrics = await page.evaluate(() => {
    const title = document.querySelector('h2')
    const header = title.parentElement
    const aside = header.closest('aside')
    const collapse = document.querySelector('[data-testid="check-collapse"]')
    const action = document.querySelector('[data-testid="check-action"]')
    const titleBox = title.getBoundingClientRect()
    const asideBox = aside.getBoundingClientRect()
    const collapseBox = collapse.getBoundingClientRect()
    const actionBox = action.getBoundingClientRect()
    const headerStyle = getComputedStyle(header)
    const titleStyle = getComputedStyle(title)
    return {
      titleSize: titleStyle.fontSize,
      titleWeight: titleStyle.fontWeight,
      titleLeft: Math.round(titleBox.left - asideBox.left),
      paddingX: headerStyle.paddingLeft,
      paddingY: headerStyle.paddingTop,
      headerHeight: Math.round(header.getBoundingClientRect().height),
      collapseBox: [
        Math.round(collapseBox.width),
        Math.round(collapseBox.height),
      ],
      // 模块动作排在收起按钮左侧(与通讯录一致:收起永远在最右)。
      actionBeforeCollapse: actionBox.right <= collapseBox.left,
      collapseLabel: collapse.getAttribute('aria-label'),
      titleTag: title.tagName,
    }
  })
  assert.equal(metrics.titleSize, '16px', '栏头标题 16px(与通讯录同档)')
  assert.equal(metrics.titleWeight, '700', '栏头标题 bold(与通讯录同档)')
  assert.equal(metrics.titleTag, 'H2', '栏头标题是 h2(与通讯录同档)')
  assert.equal(metrics.titleLeft, 16, '标题左缘距栏边 16px')
  assert.equal(metrics.paddingX, '16px', '栏头左内边距 16px')
  assert.equal(metrics.paddingY, '8px', '栏头上内边距 8px')
  assert.equal(
    metrics.headerHeight,
    56,
    '栏头高度 56px:与内容区标题栏(TitleBar,57 = 56 + 1px 线)同高'
  )
  assert.deepEqual(metrics.collapseBox, [28, 28], '收起按钮 28×28')
  assert.equal(metrics.actionBeforeCollapse, true, '收起按钮在最右端')
  assert.equal(
    metrics.collapseLabel,
    '收起导航栏',
    '六个模块共用同一句无障碍名'
  )

  await page.getByTestId('check-collapse').click()
  const strip = await page.evaluate(() => {
    const expand = document.querySelector('[data-testid="check-expand"]')
    const box = expand.parentElement.getBoundingClientRect()
    return {
      width: Math.round(box.width),
      label: expand.getAttribute('aria-label'),
    }
  })
  assert.equal(strip.width, 36, '收起后窄条 36px(与通讯录同档)')
  assert.equal(strip.label, '展开导航栏', '展开按钮共用同一句无障碍名')
  assert.equal(
    await page.evaluate(() => localStorage.getItem('we-meet:subnav-check')),
    '1',
    '收起态写进 localStorage'
  )
  await page.screenshot({
    path: 'test-results/subnav-collapsed.png',
    fullPage: true,
  })
  assert.deepEqual(errors, [], `页面不应有运行时错误:${errors.join(' / ')}`)
  console.log(
    'Sub nav passed: 六个模块共用 components/SubNav 的栏头;基准 16px/bold + 16/8 内边距 + 56px 栏高 + 28×28 收起按钮 + 36px 窄条 + 同一句无障碍名。截图:test-results/subnav-collapsed.png'
  )
} finally {
  await browser.close()
}
