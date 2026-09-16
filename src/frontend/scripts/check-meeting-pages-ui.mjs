// 「会议」模块页面(视频会议 / AI 录音 / 会议实录 / 智能纪要)的真实 Chromium 走查。
//
// 目的不是替代 vitest(那批管的是行为契约),而是补上 jsdom 看不见的三件事:
//   ① 语义 token 在**两套主题**下的实际合成结果(浅色零回归、深色不再翻车);
//   ② 焦点环真的画出来了(手写行 vs 基元);
//   ③ 390px 下不出现横向滚动。
//
// 用法(cwd = src/frontend):
//   VITE_PORT=3187 npm run dev      # 另开一个终端
//   node scripts/check-meeting-pages-ui.mjs
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const record = {
  id: 'cloud-record',
  title: '产品设计评审',
  source_type: 'audio_recording',
  origin_at: '2026-09-13T00:00:00Z',
  has_summary: true,
  is_ongoing: false,
  capabilities: { read_summary: true, read_transcript: true },
}
const ongoing = {
  ...record,
  id: 'live',
  title: '进行中的访谈',
  is_ongoing: true,
  has_summary: false,
}
const video = {
  ...record,
  id: 'video-record',
  title: '周会录像',
  source_type: 'meeting',
  has_summary: false,
}
const user = {
  id: 'ui-owner',
  email: 'owner@example.com',
  full_name: 'UI Owner',
}
const upcoming = {
  id: 'room-upcoming',
  name: '季度规划会',
  slug: '86001234',
  is_owner: true,
  scheduled_at: '2026-09-20T02:00:00Z',
  created_at: '2026-09-15T02:00:00Z',
  event_id: null,
  meeting_session_id: null,
  started_at: null,
  ended_at: null,
  status: 'pending',
}
const past = {
  ...upcoming,
  id: 'room-past',
  name: '周例会',
  slug: '86005678',
  is_owner: false,
  scheduled_at: null,
  started_at: '2026-09-14T02:00:00Z',
  ended_at: '2026-09-14T02:30:00Z',
  meeting_session_id: 'session-past',
  status: 'ended',
}
const config = {
  meeting_records: {
    enabled: true,
    summary_requests_enabled: true,
    capture_audio_enabled: true,
  },
  search_ai: { enabled: true },
  feedback: { url: '' },
  background_image: {},
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

/** 在真实 vite 模块图里挂载一个页面组件(不经过路由壳,避开登录跳转)。 */
const mount = (target, props) =>
  page.evaluate(
    async ({ target, props }) => {
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
      const modules = {
        library: '/src/features/meetings/routes/MeetingLibrary.tsx',
        recording: '/src/features/meetings/routes/RecordingOverview.tsx',
        home: '/src/features/home/routes/Home.tsx',
      }
      const mod = await import(modules[target])
      const Component =
        target === 'library'
          ? mod.Library
          : target === 'recording'
            ? mod.RecordingOverview
            : mod.Home
      window.meetingClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      const root = document.getElementById('root')
      const element = React.createElement(
        QueryClientProvider,
        { client: window.meetingClient },
        React.createElement(Component, props)
      )
      // 同一个 #root 复用同一个 React root:重复 createRoot 会触发 React 警告,
      // 那属于走查脚本自己的噪声,不该混进「页面报错」里。
      if (window.meetingRoot) window.meetingRoot.render(element)
      else window.meetingRoot = createRoot(root)
      window.meetingRoot.render(element)
    },
    { target, props }
  )

const noHorizontalOverflow = async (label) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  )
  assert.ok(
    overflow <= 0,
    `${label}: 出现横向滚动(${overflow}px),普通内容在等效 320 CSS px 下不得依赖双向滚动`
  )
}

const themeSurface = (selector) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el)
      return { backgroundColor: style.backgroundColor, color: style.color }
    })

try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1180, height: 900 },
  })
  await context.route('**/meeting-pages-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Meeting pages check</title><div id="root"></div></html>',
    })
  )
  await context.route('**/api/v1.0/**', async (route) => {
    const url = new URL(route.request().url())
    const reply = (json) => route.fulfill({ json })
    if (url.pathname.endsWith('/config/')) return reply(config)
    if (url.pathname.endsWith('/users/me')) return reply(user)
    if (url.pathname.endsWith('/recording-uploads/'))
      return reply({ available: false, max_bytes: 0, extensions: [] })
    if (url.pathname.endsWith('/rooms/video-meetings/'))
      return reply({ scheduled: [upcoming], recent: [past] })
    if (url.pathname.includes('/video-session/'))
      return reply({
        status: 'ended',
        started_at: past.started_at,
        ended_at: past.ended_at,
      })
    if (url.pathname.endsWith('/meeting-records/')) {
      if (url.searchParams.get('is_ongoing') === 'true')
        return reply({ results: [ongoing], next_cursor: null })
      return reply({ results: [record, video], next_cursor: null })
    }
    return reply(record)
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

  // ── 会议实录(桌面) ───────────────────────────────────────────────────────
  await page.goto(`${origin}/meeting-pages-harness`)
  await page.evaluate(() => history.replaceState({}, '', '/meeting/notes'))
  await mount('library', { viewerId: 'ui-owner' })
  await page.getByRole('link', { name: record.title }).waitFor()
  assert.equal(
    await page.getByRole('link', { name: ongoing.title }).count(),
    1,
    '进行中的记录必须单独成组出现'
  )
  assert.equal(
    (await page.getByRole('heading', { name: '进行中', exact: true }).count()) +
      (await page
        .getByRole('heading', { name: '历史记录', exact: true })
        .count()),
    2,
    '实录页仍然是「进行中 + 历史记录」两组'
  )

  // 范围筛选收口到共享分段控件:键盘可操作,选中态走 aria-selected。
  const scopeTabs = page.getByRole('tab')
  assert.equal(await scopeTabs.count(), 3, '实录页三个范围档')
  await page.getByRole('tab', { name: '最近' }).focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-selected') === 'true' &&
      document.activeElement.textContent.includes('我的内容')
  )

  // 图标开关是基元:aria-pressed 与面板显隐同步。
  const gridToggle = page.getByRole('button', { name: '切换为网格视图' })
  assert.equal(await gridToggle.getAttribute('aria-pressed'), 'false')
  await gridToggle.click()
  await page.getByRole('button', { name: '切换为列表视图' }).waitFor()
  assert.equal(await page.locator('ul[data-grid="true"]').count(), 2)
  await page.getByRole('button', { name: '切换为列表视图' }).click()
  assert.equal(await page.locator('ul[data-grid="false"]').count(), 2)

  const filterToggle = page.getByRole('button', { name: '筛选' })
  await filterToggle.click()
  // 原生下拉仍是 <select>,标签关联与 32px 钉高走共享 chrome。
  const scopeSelect = page.getByLabel('范围', { exact: false }).last()
  assert.equal(await scopeSelect.evaluate((el) => el.tagName), 'SELECT')
  const selectBox = await scopeSelect.boundingBox()
  assert.equal(
    Math.round(selectBox.height),
    32,
    '筛选下拉应钉在 controlHeight.compact'
  )
  await filterToggle.click()

  // 焦点环:纯键盘 Tab 走到第一个可交互元素时必须有可见描边。
  await page.locator('body').click({ position: { x: 2, y: 2 } })
  let ringFound = false
  for (let i = 0; i < 12 && !ringFound; i += 1) {
    await page.keyboard.press('Tab')
    ringFound = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return false
      const style = getComputedStyle(el)
      return (
        style.outlineStyle === 'solid' &&
        Number.parseFloat(style.outlineWidth) > 0
      )
    })
  }
  assert.equal(ringFound, true, 'Tab 焦点必须落在带可见焦点环的控件上')

  await shot('meeting-notes-desktop')

  // ── 深色主题:品牌浅底面必须随主题翻转(旧 primary.* 固定色阶是这里翻车的) ──
  const tileLight = await themeSurface(
    '[aria-label="产品设计评审"] span[aria-hidden]'
  )
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.waitForTimeout(120)
  const tileDark = await themeSurface(
    '[aria-label="产品设计评审"] span[aria-hidden]'
  )
  assert.notEqual(
    tileLight.backgroundColor,
    tileDark.backgroundColor,
    '卡片图标块底色必须随主题翻转,不能是固定 primary 色阶'
  )
  assert.equal(
    /^rgb\(214, 228, 255\)$/.test(tileDark.backgroundColor),
    false,
    '深色下不得残留浅蓝亮带(#D6E4FF)'
  )
  await shot('meeting-notes-dark')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })

  // ── 移动端(390px) ────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(120)
  await noHorizontalOverflow('会议实录 390px')
  // 窄屏下左列导航让位给顶部胶囊行,当前项必须是 aria-current。
  const mobileNav = page.getByRole('navigation', { name: '会议资料导航' })
  assert.equal(await mobileNav.count(), 1, '窄屏应有栏目胶囊行')
  const currentInNav = await mobileNav
    .getByRole('link')
    .evaluateAll(
      (links) =>
        links.filter((link) => link.getAttribute('aria-current') === 'page')
          .length
    )
  assert.equal(currentInNav, 1, '窄屏栏目行只能有一个当前项')
  await shot('meeting-notes-mobile')
  await page.setViewportSize({ width: 1180, height: 900 })

  // ── 智能纪要(同一份 Library,minutes 档换 underline 与阅读器底色) ────────
  await page.evaluate(() => history.replaceState({}, '', '/meeting/minutes'))
  await mount('library', { viewerId: 'ui-owner', minutes: true })
  await page.getByRole('link', { name: record.title }).waitFor()
  const minutesMain = await page
    .locator('main')
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  assert.equal(
    minutesMain,
    'rgb(255, 255, 255)',
    '纪要页用阅读器底色 surface.default'
  )
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.waitForTimeout(120)
  const minutesMainDark = await page
    .locator('main')
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  assert.notEqual(minutesMainDark, minutesMain, '纪要页底色也要跟随主题')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await page.waitForTimeout(200)
  // 切回浅色后再确认一次卡片底色:主题切换是纯属性驱动的,截图里不该混着两套。
  const cardBackLight = await page
    .locator('[aria-label="产品设计评审"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  assert.equal(
    cardBackLight,
    'rgb(255, 255, 255)',
    `切回浅色后卡片必须回到 surface.default,实际 ${cardBackLight}`
  )
  await shot('meeting-minutes-desktop')

  // ── AI 录音 ──────────────────────────────────────────────────────────────
  await page.evaluate(() => history.replaceState({}, '', '/meeting/recording'))
  await mount('recording', {})
  await page.getByRole('link', { name: '录音', exact: true }).waitFor()
  const tile = page.getByRole('link', { name: '录音', exact: true })
  const entryTile = await tile.evaluate(
    (el) => getComputedStyle(el).backgroundColor
  )
  assert.equal(
    entryTile,
    'rgb(214, 228, 255)',
    '浅色下入口块仍是原浅蓝底(零回归)'
  )
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.waitForTimeout(120)
  const entryTileDark = await tile.evaluate(
    (el) => getComputedStyle(el).backgroundColor
  )
  assert.notEqual(entryTileDark, entryTile, '入口块底色必须随主题翻转')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  assert.equal(
    await page.getByRole('listitem').count(),
    2,
    '历史录音两行(进行中那条不属于 history 查询)'
  )
  await shot('meeting-recording-desktop')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(120)
  await noHorizontalOverflow('AI 录音 390px')
  await shot('meeting-recording-mobile')
  await page.setViewportSize({ width: 1180, height: 900 })

  // ── 视频会议主区(/meeting) ──────────────────────────────────────────────
  // 登录态走 /users/me fixture;这一页是三入口 + 预约/历史两节。
  await page.evaluate(() => history.replaceState({}, '', '/meeting'))
  await mount('home', {})
  await page.getByRole('button', { name: '快速会议' }).waitFor()
  await page.getByText(upcoming.name).waitFor()
  assert.equal(
    await page.getByRole('button', { name: '快速会议' }).count(),
    1,
    '主区保留快速会议入口'
  )
  assert.ok(
    (await page.getByRole('button', { name: '预约会议' }).count()) >= 1,
    '「预约会议」入口仍可用'
  )
  // 同一屏里只允许一颗「预约会议」:节标题右侧那颗已删除,留下的必须在顶部动作行
  // (即位置在「预约会议」小节标题之上)。
  const scheduleButton = page.getByRole('button', { name: '预约会议' })
  assert.equal(
    await scheduleButton.count(),
    1,
    '「预约会议」只保留顶部动作行那一颗'
  )
  const [scheduleBox, scheduleHeadingBox] = await Promise.all([
    scheduleButton.boundingBox(),
    page.getByRole('heading', { name: '预约会议', exact: true }).boundingBox(),
  ])
  assert.ok(
    scheduleBox.y < scheduleHeadingBox.y,
    '留下的那颗必须是动作行里的,不在「待开始的会议」节标题行'
  )
  const quickBox = await page
    .getByRole('button', { name: '快速会议' })
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  assert.equal(quickBox, 'rgb(40, 96, 217)', '主操作走 action.primary.bg')
  await shot('meeting-home-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(120)
  await noHorizontalOverflow('视频会议 390px')
  // 定宽左列必须在窄屏让位,否则正文会被挤成一字一行(这是走查抓到的真实缺陷)。
  assert.equal(
    await page.locator('aside').first().isVisible(),
    false,
    '390px 下左列导航必须隐藏'
  )
  assert.equal(
    await page.getByRole('navigation', { name: '会议资料导航' }).isVisible(),
    true,
    '390px 下必须换成顶部栏目行,否则整页失去栏目导航'
  )
  await shot('meeting-home-mobile')
  await page.setViewportSize({ width: 1180, height: 900 })

  assert.deepEqual(errors, [], `页面报错:${errors.join(' / ')}`)
  console.log(
    `Meeting pages UI passed: 视频会议 / 实录 / 纪要 / AI 录音 — 桌面 + 390px 无横向滚动、分段控件键盘可用、图标开关 aria-pressed 同步、Tab 可见焦点环、浅深两套主题语义 token 翻转。截图:${screenshots.join(', ')}`
  )
} finally {
  await browser.close()
}
