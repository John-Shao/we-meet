// 「日历」模块内容标题栏的真实 Chromium 走查。
//
// 走查反馈:日历的内容标题栏与「会议」模块不是一条 —— 那边是白底 + 56px(+1px 线)、
// 右侧动作走 `action` 档按钮,这边是自己排的一行(无白底、无分割线,高度由分段控件的
// 纵向内边距决定,主操作只有文字前缀「＋」没有图标,齿轮是手写的 32px `<button>`)。
//
// jsdom 量不到这些,所以这里在真实浏览器里挂起整页 `CalendarRoute` 并量:
//   ① 标题栏几何 —— 固定区顶边 → 标题行底边必须 56px(白条 56 + 1px 线 = 57,
//      与「会议」四个一级页 / `TitleBar` / 二级导航栏栏头同一档);
//   ② 标题栏颜色 —— 白底 `surface.default` + 1px `border.subtle` 底分割线;
//   ③ 按钮风格 —— 主操作 40px(action)+ 品牌蓝 + 18px 图标;纯图标齿轮 32px(icon32);
//   ④ 左栏栏头(二级导航栏 56px)与右栏标题栏**同一中线**;
//   ⑤ 窄屏(390px)下标题行不横向溢出。
//
// 用法(cwd = src/frontend):
//   VITE_PORT=3187 npm run dev      # 另开一个终端
//   node scripts/check-calendar-title-bar.mjs
//
// 默认走 `localhost:3187`(与 `check-title-bar.mjs` 一致):vite 的 dev server 按
// `server.host = 'localhost'` 绑的是 `::1`,写 `127.0.0.1` 连不上。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

import {
  extractElementInner,
  findTitleBarButtonViolations,
} from './title-bar-rules.mjs'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://localhost:3187'
const routeSource = 'src/features/calendar/routes/CalendarRoute.tsx'

/**
 * 源码级检查:这一页的标题栏必须是**共享定义**而不是自己排的一行。
 *
 * 只量浏览器里的数字不够 —— 谁把 `pageHeaderRow` 换回手写的
 * `justifyContent: 'space-between'` 一行,高度恰好在当天还是对的,下一个人改共享件
 * 时它就悄悄掉队了。所以这里先钉住「用了哪三个共享类」与「标题栏里不出现 dense」。
 */
const source = readFileSync(
  fileURLToPath(new URL(`../${routeSource}`, import.meta.url)),
  'utf8'
)
const missing = ['pageFixedTop', 'pageHeaderRow', 'headerActions'].filter(
  (name) => !source.includes(name)
)
assert.deepEqual(
  missing,
  [],
  `${routeSource} 的标题栏必须走「会议」模块的共享定义(libraryStyles),缺:${missing.join(' / ')}`
)
{
  const anchor = source.indexOf('<header className={pageHeaderRow}>')
  assert.ok(anchor >= 0, `${routeSource} 的标题行没有用 pageHeaderRow`)
  // 区块按标签边界切(同 `check-title-bar.mjs`;旧写法取到第一个自闭合子元素就收尾)。
  const block = extractElementInner(source, 'header', anchor) ?? ''
  assert.ok(
    !block.includes('size="dense"'),
    '标题栏里不出现 dense 档按钮(比同排小一号,见 3.27):应改用 action'
  )
  assert.ok(
    /icon=\{<RiAddLine size=\{18\}/.test(block),
    '标题栏的主操作必须带 18px 图标(与「快速会议 / 新建任务」同一档)'
  )
  // 纯图标齿轮:必须是基元 `IconButton`,且不得借用品牌蓝(见 title-bar-rules.mjs)。
  const violations = findTitleBarButtonViolations(block, '日历标题栏')
  assert.deepEqual(violations, [], violations.join('\n'))
}

const config = {
  is_silent_login_enabled: false,
  // 统一日历关掉:这一页只量标题栏,不开会让侧栏多两次列表请求。
  calendar: { enabled: false },
  meeting_records: { enabled: true, capture_audio_enabled: true },
  search_ai: { enabled: true },
  feedback: { url: '' },
  background_image: {},
}
const user = {
  id: 'ui-owner',
  email: 'owner@example.com',
  full_name: 'UI Owner',
}
const preference = {
  timezone_mode: 'auto',
  timezone: null,
  week_start: 'mon',
  default_duration_minutes: 60,
  default_reminder_minutes: 10,
  dim_past: false,
  show_weekend: true,
  working_start_minutes: 540,
  working_end_minutes: 1080,
  calendar_time_range: 'work',
  meeting_rooms_time_range: 'work',
  initialized: true,
  revision: 1,
}

const browser = await chromium.launch({ headless: true })
const errors = []
const screenshots = []
let page

const shot = async (name) => {
  const path = `test-results/${name}.png`
  await page.screenshot({ path, fullPage: true })
  screenshots.push(path)
}

try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1180, height: 900 },
  })
  await context.route('**/calendar-title-bar-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Calendar title bar check</title><div id="root"></div></html>',
    })
  )
  await context.route('**/api/v1.0/**', async (route) => {
    const url = new URL(route.request().url())
    const reply = (json) => route.fulfill({ json })
    if (url.pathname.endsWith('/config/')) return reply(config)
    if (url.pathname.endsWith('/users/me')) return reply(user)
    if (url.pathname.endsWith('/calendar-preferences/me/'))
      return reply(preference)
    // 事件窗口为空:这一页只量标题栏,空态反而更干净(网格不留日程块)。
    if (url.pathname.endsWith('/calendar-events/'))
      return reply({ results: [], next: null })
    return reply([])
  })

  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    // 无头 Chromium 会拦掉 vite 的 HMR websocket(Local Network Access 检查),
    // 那是走查环境的噪声,不是页面问题。
    if (text.includes('WebSocket') || text.includes('[vite]')) return
    errors.push(text)
  })

  await page.goto(`${origin}/calendar-title-bar-harness`)
  await page.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    await import('/src/styles/index.css')
    await import('/src/i18n/init.ts')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (
      await import('/node_modules/.vite/deps/react-dom_client.js')
    ).default
    const { QueryClient, QueryClientProvider } =
      await import('/node_modules/.vite/deps/@tanstack_react-query.js')
    // 直接从 CalendarRoute.tsx 取组件会踩到 ESM 循环:`src/routes.ts` 静态 import
    // 了 `@/features/calendar`,而后者又再导出 `CalendarRoute` —— 先加载路由表,
    // 循环就从「已经初始化」的那一侧进入(与 `App.tsx` 的加载顺序一致)。
    const { routes } = await import('/src/routes.ts')
    const CalendarRoute = routes.calendar.Component
    // 页面自己用的上下文:确认弹窗(日程的删除/改期确认)。真实应用里由 App 提供,
    // 这里挂最小的一份 —— 缺了它 `useConfirm` 直接抛错,整棵树会被卸载。
    const { ConfirmProvider } =
      await import('/src/components/ConfirmProvider.tsx')
    window.calendarClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    createRoot(document.getElementById('root')).render(
      React.createElement(
        React.Suspense,
        { fallback: 'Loading…' },
        React.createElement(
          QueryClientProvider,
          { client: window.calendarClient },
          React.createElement(
            ConfirmProvider,
            null,
            React.createElement(CalendarRoute)
          )
        )
      )
    )
  })
  await page.getByTestId('calendar-create').waitFor()

  const chrome = await page.evaluate(() => {
    const fixedTop = document.querySelector(
      '[data-testid="calendar-page-header"]'
    )
    const header = fixedTop.querySelector('header')
    const box = (el) => el.getBoundingClientRect()
    const style = (el) => getComputedStyle(el)
    const fixedTopBox = box(fixedTop)
    const headerBox = box(header)
    const create = document.querySelector('[data-testid="calendar-create"]')
    const createIcon = create.querySelector('svg')
    const settings = document.querySelector('[data-testid="calendar-settings"]')
    const tabs = document.querySelector('[role="tablist"]')
    const tab = document.querySelector('[role="tab"]')
    // 左栏(二级导航栏)的栏头标题:收起按钮 → 动作组 → 栏头 → h2。
    const navTitle = document
      .querySelector('[data-testid="calendar-nav-collapse"]')
      ?.closest('div')
      ?.parentElement?.querySelector('h2')
    const center = (el) => (box(el).top + box(el).bottom) / 2
    return {
      titleBandHeight: Math.round(headerBox.bottom - fixedTopBox.top),
      fixedTopHeight: Math.round(fixedTopBox.height),
      fixedTopBackground: style(fixedTop).backgroundColor,
      fixedTopPaddingTop: style(fixedTop).paddingTop,
      fixedTopPaddingLeft: style(fixedTop).paddingLeft,
      borderBottomWidth: style(fixedTop).borderBottomWidth,
      headerMinHeight: style(header).minHeight,
      headerOverflowX: header.scrollWidth - header.clientWidth,
      titleCenterOffset:
        Math.round(
          (center(tabs) - (headerBox.top + headerBox.bottom) / 2) * 10
        ) / 10,
      actionsCenterOffset:
        Math.round(
          (center(create) - (headerBox.top + headerBox.bottom) / 2) * 10
        ) / 10,
      navTitleGap: navTitle
        ? Math.round((center(navTitle) - center(create)) * 10) / 10
        : null,
      createHeight: Math.round(box(create).height),
      createBackground: style(create).backgroundColor,
      createIcon: createIcon
        ? [
            Math.round(box(createIcon).width),
            Math.round(box(createIcon).height),
          ]
        : null,
      createText: create.textContent.trim(),
      createLeftOfSettings: box(create).right <= box(settings).left + 1,
      settingsBox: [
        Math.round(box(settings).width),
        Math.round(box(settings).height),
      ],
      settingsLabel: settings.getAttribute('aria-label'),
      tabCount: document.querySelectorAll('[role="tab"]').length,
      tabLabels: [...document.querySelectorAll('[role="tab"]')].map((el) =>
        el.textContent.trim()
      ),
      // 页面级 Tab 是「日历 / 会议室」,不是 rbc 的「日/周/月/列表」——后者在网格
      // 自己的工具栏里,不该被搬进标题栏。
      tabAppearance: tabs.dataset.appearance,
      tabBorderBottomColor: style(tab).borderBottomColor,
    }
  })

  // ① 标题栏几何:56 内容 + 1px 线。「会议」四个一级页、`TitleBar`(消息 / 任务 /
  //    通讯录 / 审批)与二级导航栏栏头都是这一档 —— 六个模块并排切栏目时两条栏同高。
  assert.equal(
    chrome.titleBandHeight,
    56,
    `标题栏高度应与会议模块同档 56px(+1px 线 = 57),实际 ${chrome.titleBandHeight}px`
  )
  assert.equal(
    chrome.fixedTopHeight,
    57,
    `标题栏白条应为 56px + 1px 线 = 57px,实际 ${chrome.fixedTopHeight}px`
  )
  assert.equal(
    chrome.headerMinHeight,
    '56px',
    `标题行最小高度应为 TITLE_BAR_MIN_HEIGHT(56px),实际 ${chrome.headerMinHeight}`
  )
  assert.equal(
    chrome.fixedTopPaddingTop,
    '0px',
    `固定区不该自带顶部内边距(那会让白条高于 57px),实际 ${chrome.fixedTopPaddingTop}`
  )
  // ② 颜色:白底 + 1px 底分割线(与会议页的固定区同一套语义 token)。
  assert.equal(
    chrome.fixedTopBackground,
    'rgb(255, 255, 255)',
    `标题栏应为白底 surface.default,实际 ${chrome.fixedTopBackground}`
  )
  assert.equal(
    chrome.borderBottomWidth,
    '1px',
    `标题栏应有 1px 底分割线,实际 ${chrome.borderBottomWidth}`
  )
  assert.equal(
    chrome.fixedTopPaddingLeft,
    '16px',
    `左内边距应为 16px(与会议模块 / 网格区对齐),实际 ${chrome.fixedTopPaddingLeft}`
  )
  // 标题行里左右两组都必须垂直居中(±1px)——「文字和按钮没居中」正是之前那条反馈。
  assert.ok(
    Math.abs(chrome.titleCenterOffset) <= 1,
    `左侧 Tab 必须垂直居中于标题栏,实测偏 ${chrome.titleCenterOffset}px`
  )
  assert.ok(
    Math.abs(chrome.actionsCenterOffset) <= 1,
    `右侧动作必须垂直居中于标题栏,实测偏 ${chrome.actionsCenterOffset}px`
  )
  assert.ok(
    chrome.navTitleGap != null && Math.abs(chrome.navTitleGap) <= 1,
    `左栏栏头标题与右栏标题栏必须同一中线,实测差 ${chrome.navTitleGap}px`
  )
  // ③ 按钮风格 = 「会议」标题栏那一套。
  assert.equal(
    chrome.createHeight,
    40,
    `主操作应为 action 档 40px(与「快速会议」同高),实际 ${chrome.createHeight}px`
  )
  assert.equal(
    chrome.createBackground,
    'rgb(40, 96, 217)',
    `主操作应走 action.primary.bg(品牌蓝),实际 ${chrome.createBackground}`
  )
  assert.deepEqual(
    chrome.createIcon,
    [18, 18],
    `主操作应带 18px 图标(与会议模块一致),实际 ${JSON.stringify(chrome.createIcon)}`
  )
  assert.equal(
    chrome.createText,
    '新建日程',
    `主操作文案应是「新建日程」(图标走 icon prop,不再用「＋」文字前缀)`
  )
  assert.equal(chrome.createLeftOfSettings, true, '齿轮应排在主操作右侧')
  assert.deepEqual(
    chrome.settingsBox,
    [32, 32],
    `齿轮应是 icon32 档 32×32(面板头 / 工具行那一档),实际 ${JSON.stringify(chrome.settingsBox)}`
  )
  assert.equal(
    chrome.settingsLabel,
    '日历设置',
    `齿轮必须有无障碍名(基元的 label),实际 ${chrome.settingsLabel}`
  )
  // ④ 标题栏左槽仍是页面级 Tab(日历 / 会议室),没被 rbc 的视图切换器顶掉。
  assert.deepEqual(
    [chrome.tabCount, chrome.tabAppearance],
    [2, 'underline'],
    '标题栏左槽应是「日历 / 会议室」两个下划线 Tab'
  )
  assert.deepEqual(
    chrome.tabLabels,
    ['日历', '会议室'],
    `标题栏左槽的 Tab 文案不对:${JSON.stringify(chrome.tabLabels)}`
  )
  assert.notEqual(
    chrome.tabBorderBottomColor,
    'rgba(0, 0, 0, 0)',
    '选中的 Tab 应有下划线(border.focus)'
  )
  await shot('calendar-title-bar-desktop')

  // ⑤ 窄屏:标题行靠 flex-wrap 换行,而不是把整栏撑破。
  //
  //    先收起左栏再量:390px 下左栏(最小 220px)会把内容列压到 130px 左右,那时
  //    标题行里**两个 Tab 的宽度**就超过整栏了 —— 那是这一页在窄屏的既有版面问题
  //    (左栏不自动让位),与标题栏自身无关;收起后内容列恢复正常宽度,量的才是
  //    标题栏的伸缩行为。
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('calendar-nav-collapse').click()
  await page.waitForTimeout(200)
  const narrow = await page.evaluate(() => {
    const fixedTop = document.querySelector(
      '[data-testid="calendar-page-header"]'
    )
    const header = fixedTop.querySelector('header')
    const create = document.querySelector('[data-testid="calendar-create"]')
    const headerBox = header.getBoundingClientRect()
    const createBox = create.getBoundingClientRect()
    return {
      overflowX: header.scrollWidth - header.clientWidth,
      flexWrap: getComputedStyle(header).flexWrap,
      createRight: Math.round(createBox.right - headerBox.left),
      createBottom: Math.round(createBox.bottom - headerBox.top),
      headerWidth: Math.round(headerBox.width),
      headerHeight: Math.round(headerBox.height),
      // 换行后主操作必须仍落在标题栏里(栏自己长高,而不是内容溢出去)。
      createInside:
        createBox.right <= headerBox.right + 1 &&
        createBox.bottom <= headerBox.bottom + 1,
    }
  })
  assert.equal(
    narrow.flexWrap,
    'wrap',
    `标题行应靠 flex-wrap 换行(与会议模块同一套 pageHeaderRow),实际 ${narrow.flexWrap}`
  )
  assert.ok(
    narrow.overflowX <= 0,
    `390px 下标题行出现横向溢出(${narrow.overflowX}px)`
  )
  assert.ok(
    narrow.createInside,
    `390px 下主操作越出标题栏(右 ${narrow.createRight} / 下 ${narrow.createBottom},` +
      `栏 ${narrow.headerWidth}×${narrow.headerHeight})`
  )
  await shot('calendar-title-bar-mobile')
  await page.setViewportSize({ width: 1180, height: 900 })

  assert.deepEqual(errors, [], `页面不应有运行时错误:${errors.join(' / ')}`)
  console.log(
    `Calendar title bar passed: 与会议模块同一条 —— 栏高 56px(+1px 线 = 57)、白底 + 1px 分割线、` +
      `左侧「日历 / 会议室」Tab 与右侧动作都居中;主操作 action 40px + 品牌蓝 + 18px 图标,` +
      `齿轮 icon32 32×32;390px 无横向溢出。截图:${screenshots.join(', ')}`
  )
} finally {
  await browser.close()
}
