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
  /** 表格视图的三列:所有者 / 修改时间 / 创建时间(与飞书对齐的那三列)。 */
  owner: 'UI Owner',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-13T08:00:00Z',
  capabilities: { read_summary: true, read_transcript: true },
}
const ongoing = {
  ...record,
  id: 'live',
  title: '进行中的访谈',
  is_ongoing: true,
  has_summary: false,
  created_at: '2026-09-16T00:00:00Z',
  updated_at: '2026-09-16T00:00:00Z',
}
const video = {
  ...record,
  id: 'video-record',
  title: '周会录像',
  source_type: 'meeting',
  has_summary: false,
}
/**
 * 归档列表要**足够长**,「只滚列表」这条才验得到:记录只有两条时列表根本滚不动,
 * 断言会退化成恒真。创建时间逐条递增,「按创建时间排序」也才验得出来(默认降序时
 * 最新的一条排在最前,切升序后它落到最后)。
 */
const archive = [
  record,
  video,
  ...Array.from({ length: 24 }, (_, index) => ({
    ...record,
    id: `archive-${index}`,
    title: `评审记录 ${index + 1}`,
    has_summary: false,
    created_at: new Date(
      Date.parse(record.created_at) + (index + 1) * 3600_000
    ).toISOString(),
  })),
]
/** 录音页的历史列表同样要够长,「入口块钉住」那条才验得到。 */
const recordings = [
  record,
  ...Array.from({ length: 23 }, (_, index) => ({
    ...record,
    id: `recording-${index}`,
    title: `录制记录 ${index + 1}`,
  })),
]
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
/** 视频会议页的两段列表也要够长,「页头钉住」那条才验得到。 */
const scheduledMeetings = [
  upcoming,
  /** 后端只返回带 scheduled_at 的房间(通话房已被排除),但值本身仍可能解析不了。 */
  { ...upcoming, id: 'room-dirty', name: '无日期会议', scheduled_at: '—' },
  ...Array.from({ length: 12 }, (_, index) => ({
    ...upcoming,
    id: `room-upcoming-${index}`,
    slug: `8600${1000 + index}`,
    name: `规划会 ${index + 1}`,
  })),
]
const recentMeetings = [
  past,
  ...Array.from({ length: 12 }, (_, index) => ({
    ...past,
    id: `room-past-${index}`,
    slug: `8601${1000 + index}`,
    name: `例会 ${index + 1}`,
    meeting_session_id: `session-past-${index}`,
  })),
]
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

/**
 * 现取一枚 remixicon 线稿图标的 `path d`,用来断言按钮上换的是**哪个**图标 ——
 * 比"有没有 svg"强一档:方向搞反(上箭头写成下箭头)这类回归只有比路径才守得住。
 */
const iconPath = (name) =>
  page.evaluate(async (name) => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (
      await import('/node_modules/.vite/deps/react-dom_client.js')
    ).default
    const icons = await import('/@id/@remixicon/react')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    root.render(React.createElement(icons[name], { size: 18 }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    const path = host.querySelector('path')?.getAttribute('d') ?? null
    root.unmount()
    host.remove()
    return path
  }, name)

/**
 * 清掉键盘走查留下的 Tooltip。
 *
 * react-aria 的 tooltip 是挂到 body 上 `data-overlay-container` 里的 portal:Tab 走到
 * 「会议设置」齿轮时它弹出来,之后把视口缩到 390px,它仍在原来的坐标上淡出/停留 ——
 * 2026-09-17 我就是把它当成了「胶囊行多了一项、折到了第二行」,白排查一轮。所以截图
 * 前先关掉,再等到它彻底不可见(退场有淡出动画,等一拍是等不干净的)。
 */
const invisibleTooltipCount = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('[data-overlay-container] *')].filter(
        (node) => {
          if ((node.textContent || '').trim() !== '会议设置') return false
          if (!node.getClientRects().length) return false
          const style = getComputedStyle(node)
          return (
            style.visibility !== 'hidden' &&
            Number.parseFloat(style.opacity) > 0.05
          )
        }
      ).length
  )

const dismissTooltips = async () => {
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur()
  })
  for (let i = 0; i < 20 && (await invisibleTooltipCount()) > 0; i += 1)
    await page.waitForTimeout(50)
  assert.equal(
    await invisibleTooltipCount(),
    0,
    '截图前不得残留 Tooltip(它是 portal,viewport 变了也不会自己消失)'
  )
}

/**
 * 四个一级页面必须长得一样的那几条(以「智能纪要」为基准):
 * 页壳浅灰(canvas)+ 滚动内容白(surface.default)+ **页头那一栏白底**(对齐聊天窗口
 * 标题栏)+ 标题一档 16px + 页头不再带副标题 + 首行不着卡(透明底、无边框)。
 */
const assertUnifiedPageChrome = async (label) => {
  const chrome = await page.evaluate(() => {
    const main = document.querySelector('main')
    const list = main.querySelector('[data-testid="meeting-list-region"]')
    // 页头那一栏 = main 的第一个 div(pageFixedTop)。
    const fixedTop = list?.previousElementSibling
    // 列表视图是表格(主单元格在 td 里),卡片视图与录音页是 <ul>(行是 li 的孩子)。
    const firstRow =
      list?.querySelector('tr[data-record-row] > td') ??
      list?.querySelector('li:first-child > *')
    // 页面标题要取 main 里的那个:外壳/导航里还有别的 h1。
    const title = main.querySelector('h1')
    // 副标题已删(2026-09-17):页头里不该再有说明性段落。
    const leadCount = main.querySelectorAll('header p').length
    const rowStyle = firstRow ? getComputedStyle(firstRow) : null
    return {
      shell: getComputedStyle(main).backgroundColor,
      list: list ? getComputedStyle(list).backgroundColor : null,
      fixedTop: fixedTop ? getComputedStyle(fixedTop).backgroundColor : null,
      titleSize: title ? getComputedStyle(title).fontSize : null,
      titleWeight: title ? getComputedStyle(title).fontWeight : null,
      leadCount,
      rowBackground: rowStyle?.backgroundColor ?? null,
      rowBorder: rowStyle?.borderTopWidth ?? null,
    }
  })
  assert.equal(
    chrome.shell,
    'rgb(246, 246, 246)',
    `${label}:页壳应为浅灰 surface.canvas,实际 ${chrome.shell}`
  )
  assert.equal(
    chrome.list,
    'rgb(255, 255, 255)',
    `${label}:列表滚动区应为白 surface.default,实际 ${chrome.list}`
  )
  assert.equal(
    chrome.fixedTop,
    'rgb(255, 255, 255)',
    `${label}:页头那一栏应为白(对齐聊天窗口标题栏),实际 ${chrome.fixedTop}`
  )
  assert.equal(
    chrome.titleSize,
    '16px',
    `${label}:页面标题应与聊天窗口标题栏同档(pageTitle 16px),实际 ${chrome.titleSize}`
  )
  assert.equal(
    chrome.titleWeight,
    '600',
    `${label}:标题字重应是 semibold(600),实际 ${chrome.titleWeight}`
  )
  assert.equal(
    chrome.leadCount,
    0,
    `${label}:页头只留标题,不该再有副标题段落(2026-09-17 起四个一级页统一去掉)`
  )
  assert.equal(
    chrome.rowBorder,
    '0px',
    `${label}:样板行不着卡,不应有边框,实际 ${chrome.rowBorder}`
  )
  assert.equal(
    chrome.rowBackground,
    'rgba(0, 0, 0, 0)',
    `${label}:样板行底色应透明(悬停才给浅底),实际 ${chrome.rowBackground}`
  )
}

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
    // 「导入」按钮只在能力可用时渲染(见 RecordingUpload 的早退),这里给可用的
    // 一份,页头的两个动作才都画出来(顺序 / 图标那条断言才有对象)。
    if (url.pathname.endsWith('/recording-uploads/'))
      return reply({
        available: true,
        max_bytes: 500_000_000,
        extensions: ['mp3', 'wav', 'm4a', 'mp4', 'mov', 'webm'],
      })
    if (url.pathname.endsWith('/rooms/video-meetings/'))
      return reply({ scheduled: scheduledMeetings, recent: recentMeetings })
    if (url.pathname.includes('/video-session/'))
      return reply({
        status: 'ended',
        started_at: past.started_at,
        ended_at: past.ended_at,
      })
    if (url.pathname.endsWith('/meeting-records/')) {
      if (url.searchParams.get('is_ongoing') === 'true')
        return reply({ results: [ongoing], next_cursor: null })
      if (url.searchParams.get('source_type') === 'recordings')
        return reply({ results: recordings, next_cursor: null })
      return reply({ results: archive, next_cursor: null })
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
    (await page
      .getByRole('rowheader', { name: '进行中', exact: true })
      .count()) +
      (await page
        .getByRole('rowheader', { name: '历史记录', exact: true })
        .count()),
    2,
    '实录页仍然是「进行中 + 历史记录」两组(表格里是小节标题单元格)'
  )
  // 列表视图 = 表格:四列表头只出现一次,分组名是表内的行组标题。
  const recordsTable = page.getByTestId('meeting-records-table')
  assert.equal(await recordsTable.count(), 1, '列表视图应是一张表格')
  assert.deepEqual(
    await recordsTable.locator('thead th').allInnerTexts(),
    ['标题', '所有者', '修改时间', '创建时间'],
    '表头四列应与飞书对齐,且只出现一次'
  )
  // 后三列在宽屏真的画出来了(不是 display:none 占位)。
  assert.equal(
    await recordsTable
      .locator('thead th:nth-child(2)')
      .evaluate((el) => getComputedStyle(el).display),
    'table-cell'
  )
  // 「所有者」列取的是服务端的显示名。
  assert.equal(
    await recordsTable
      .locator('tbody tr[data-record-row] td:nth-child(2)')
      .first()
      .innerText(),
    'UI Owner',
    '所有者列应显示记录所有者'
  )
  // 桌面端所有者只出现在自己那一列,副行里不重复(窄屏收列时才并进副行)。
  assert.ok(
    !(
      await recordsTable
        .locator('tbody tr[data-record-row] td:first-child')
        .first()
        .innerText()
    ).includes('UI Owner'),
    '桌面端副行不应重复所有者'
  )
  // 这一页只查/看:「上传(导入)」和「录音」两个动作都不在这儿(都归 AI 录音页)。
  assert.equal(
    await page.getByRole('button', { name: '导入', exact: true }).count(),
    0,
    '会议实录页不应再有「导入」按钮'
  )
  assert.equal(
    await page.getByRole('button', { name: '录音', exact: true }).count(),
    0,
    '会议实录页不应再有「录音」按钮'
  )

  // 搜索:输入框搬进页头动作行、**没有提交按钮**,靠回车提交;位置在
  // 「搜索会议 AI」左侧、同一行。
  assert.equal(
    await page.getByRole('button', { name: '搜索', exact: true }).count(),
    0,
    '搜索框不该再带一颗「搜索」按钮'
  )
  const searchBox = page.getByLabel('搜索标题')
  const aiButton = page.getByRole('button', { name: '搜索会议 AI' })
  const [searchBoxBox, aiBox] = await Promise.all([
    searchBox.boundingBox(),
    aiButton.boundingBox(),
  ])
  assert.ok(
    searchBoxBox.x + searchBoxBox.width <= aiBox.x,
    `搜索框必须在「搜索会议 AI」左侧,实际 搜索框右缘 ${Math.round(
      searchBoxBox.x + searchBoxBox.width
    )} / 按钮左缘 ${Math.round(aiBox.x)}`
  )
  assert.ok(
    searchBoxBox.y < aiBox.y + aiBox.height &&
      aiBox.y < searchBoxBox.y + searchBoxBox.height,
    '搜索框与「搜索会议 AI」必须在同一行'
  )
  // 回车即搜:一次带 q 的查询请求。
  await searchBox.fill('评审')
  const searched = page.waitForRequest(
    (request) => new URL(request.url()).searchParams.get('q') === '评审'
  )
  await searchBox.press('Enter')
  assert.equal((await searched).method(), 'GET', '回车应触发一次带 q 的查询')
  await searchBox.fill('')
  await page.waitForTimeout(150)

  // 创建时间排序:默认降序(最新的一条在组内最前),点表头切成升序后落到最后。
  const createdHeader = page.getByRole('columnheader', { name: '创建时间' })
  assert.equal(
    await createdHeader.getAttribute('aria-sort'),
    'descending',
    '创建时间默认降序'
  )
  const rowTitles = () =>
    page
      .locator('tr[data-record-row] td:first-child a')
      .evaluateAll((links) =>
        links.map((link) => link.getAttribute('aria-label'))
      )
  const descending = await rowTitles()
  assert.equal(
    descending[1],
    '评审记录 24',
    '降序时归档组的第一行应是创建最新的那条'
  )
  await page.getByRole('button', { name: '创建时间' }).click()
  assert.equal(await createdHeader.getAttribute('aria-sort'), 'ascending')
  const ascending = await rowTitles()
  assert.equal(
    ascending.at(-1),
    '评审记录 24',
    '升序时创建最新的那条应落到最后'
  )
  assert.equal(
    ascending[1],
    '产品设计评审',
    '升序时归档组的第一行应是最旧的那条'
  )
  await page.getByRole('button', { name: '创建时间' }).click()

  // ① 左右不留白:页壳铺满内容列(不再有 1120px 居中版心),行左右各只留一档
  //    16px 页边距。列表视图量的是整行(表格行铺满表宽),卡片视图量的是卡片。
  const shellBox = await page.locator('main').boundingBox()
  const columnBox = await page.locator('main').evaluate((el) => {
    const box = el.parentElement.getBoundingClientRect()
    return { x: box.x, width: box.width }
  })
  assert.equal(
    Math.round(shellBox.width),
    Math.round(columnBox.width),
    '页壳必须铺满内容列,不能是限宽居中的版心'
  )
  const rowBox = await page.locator('[data-record-row]').first().boundingBox()
  const leftGap = Math.round(rowBox.x - shellBox.x)
  const rightGap = Math.round(
    shellBox.x + shellBox.width - (rowBox.x + rowBox.width)
  )
  assert.ok(
    leftGap <= 20 && rightGap <= 20,
    `行左右留白应只有 16px 页边距,实际左 ${leftGap}px / 右 ${rightGap}px`
  )
  // 搜索框现在与「搜索会议 AI」同处页头动作行,宽屏钉 18rem(288px):不再独占
  // 一行,也不会被拉到近千像素。
  const searchWidth = Math.round(
    (await page.getByLabel('搜索标题').boundingBox()).width
  )
  assert.ok(
    searchWidth >= 240 && searchWidth <= 320,
    `搜索框宽屏应钉在 18rem(288px)附近,实际 ${searchWidth}px`
  )

  // ② 只滚列表:列表区滚到底时页头与工具行必须原地不动,外层内容列也不能被滚动。
  const listRegion = page.getByTestId('meeting-list-region')
  const headingBefore = await page
    .getByRole('heading', { name: '会议实录', exact: true })
    .boundingBox()
  const searchBefore = await page.getByLabel('搜索标题').boundingBox()
  const scrolled = await listRegion.evaluate((el) => {
    el.scrollTop = el.scrollHeight
    return el.scrollTop
  })
  assert.ok(scrolled > 0, `列表区应可滚动(实际 scrollTop=${scrolled})`)
  const headingAfter = await page
    .getByRole('heading', { name: '会议实录', exact: true })
    .boundingBox()
  const searchAfter = await page.getByLabel('搜索标题').boundingBox()
  assert.equal(
    Math.round(headingAfter.y),
    Math.round(headingBefore.y),
    '列表滚动时页头必须固定不动'
  )
  assert.equal(
    Math.round(searchAfter.y),
    Math.round(searchBefore.y),
    '列表滚动时搜索框必须固定不动'
  )
  assert.equal(
    await page.locator('main').evaluate((el) => el.parentElement.scrollTop),
    0,
    '外层内容列不应跟着滚(只能有一个滚动区)'
  )
  await listRegion.evaluate((el) => {
    el.scrollTop = 0
  })

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

  // 图标开关是基元:aria-pressed 与面板显隐同步。两个视图是同一份数据的两种形态
  // —— 列表视图是表格(有表头、有排序),卡片视图是没有表头的两栏网格。
  const gridToggle = page.getByRole('button', { name: '切换为网格视图' })
  assert.equal(await gridToggle.getAttribute('aria-pressed'), 'false')
  assert.equal(await page.getByTestId('meeting-records-table').count(), 1)
  await gridToggle.click()
  await page.getByRole('button', { name: '切换为列表视图' }).waitFor()
  assert.equal(await page.locator('ul[data-grid="true"]').count(), 2)
  assert.equal(
    await page.getByTestId('meeting-records-table').count(),
    0,
    '卡片视图不该再有表格(表头随视图一起消失)'
  )
  assert.equal(await page.locator('thead').count(), 0, '卡片视图里不应残留列名')
  await page.getByRole('button', { name: '切换为列表视图' }).click()
  assert.equal(
    await page.getByTestId('meeting-records-table').count(),
    1,
    '切回列表视图应恢复表格'
  )

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

  await dismissTooltips()
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
  // 窄屏收起后三列:列表退回「标题 + 一行辅助信息」,所有者并进那一行(桌面端它是
  // 独立的一列,不在副行里)。
  assert.equal(
    await page
      .getByTestId('meeting-records-table')
      .locator('thead')
      .evaluate((el) => getComputedStyle(el).display),
    'none',
    '窄屏应收起表头'
  )
  const narrowMeta = await page
    .locator('tr[data-record-row] td:first-child')
    .first()
    .innerText()
  assert.ok(
    narrowMeta.includes('UI Owner'),
    `窄屏应把所有者并进辅助信息一行,实际「${narrowMeta}」`
  )
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
  // 栏目胶囊行是**横向可滑**的:窄屏一律不折行(折了第二行会贴住页面标题),
  // 四个胶囊必须落在同一条水平线上,内容超出时整行横向滚。
  const navRow = await mobileNav.evaluate((el) => {
    const tops = [...el.children].map((child) =>
      Math.round(child.getBoundingClientRect().top)
    )
    return {
      itemCount: el.children.length,
      rowCount: new Set(tops).size,
      flexWrap: getComputedStyle(el).flexWrap,
      overflowX: getComputedStyle(el).overflowX,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }
  })
  assert.equal(
    navRow.itemCount,
    4,
    '窄屏栏目行是四个入口(设置齿轮不在这一行里)'
  )
  assert.equal(navRow.rowCount, 1, '窄屏栏目行不得折行,只能是一行')
  assert.equal(navRow.flexWrap, 'nowrap')
  assert.equal(navRow.overflowX, 'auto')
  assert.ok(
    navRow.scrollWidth <= navRow.clientWidth,
    `390px 下四个入口应完整显示(整行 ${navRow.scrollWidth}px / 可视 ${navRow.clientWidth}px,` +
      '最后一个胶囊被切掉会让人以为列表还有一项)'
  )
  await dismissTooltips()
  await shot('meeting-notes-mobile')
  await page.setViewportSize({ width: 1180, height: 900 })

  // ── 智能纪要(同一份 Library,与实录只差文案与内容) ──────────────────────
  await page.evaluate(() => history.replaceState({}, '', '/meeting/minutes'))
  await mount('library', { viewerId: 'ui-owner', minutes: true })
  await page.getByRole('link', { name: record.title }).waitFor()
  await assertUnifiedPageChrome('智能纪要(基准)')
  // 这一页与实录共用同一份页头:同样没有「搜索」按钮,输入框同样在 AI 按钮左侧。
  assert.equal(
    await page.getByRole('button', { name: '搜索', exact: true }).count(),
    0,
    '智能纪要页也不应有「搜索」按钮'
  )
  {
    const [box, ai] = await Promise.all([
      page.getByLabel('搜索标题').boundingBox(),
      page.getByRole('button', { name: '搜索会议 AI' }).boundingBox(),
    ])
    assert.ok(
      box.x + box.width <= ai.x,
      '智能纪要页的搜索框也必须在「搜索会议 AI」左侧'
    )
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.waitForTimeout(120)
  const minutesListDark = await page
    .getByTestId('meeting-list-region')
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  assert.notEqual(
    minutesListDark,
    'rgb(255, 255, 255)',
    '滚动区底色也要跟随主题,深色下不能还是白的'
  )
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await page.waitForTimeout(200)
  await shot('meeting-minutes-desktop')

  // ── AI 录音 ──────────────────────────────────────────────────────────────
  await page.evaluate(() => history.replaceState({}, '', '/meeting/recording'))
  await mount('recording', {})
  // 页头工具按钮:action 尺寸 + 图标。「录音 / 导入」现在只属于这一页
  // (会议实录页只保留「搜索会议 AI」),而且不再是页面里的大入口块。
  const recordButton = page.getByRole('button', { name: '录音', exact: true })
  await recordButton.waitFor()
  assert.equal(
    await recordButton.locator('svg[aria-hidden="true"]').count(),
    1,
    '「录音」工具按钮应带图标'
  )
  // 「录音」是这一页的主操作:实心 primary,与视频会议页的「快速会议」同一档色。
  assert.equal(
    await recordButton.evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(40, 96, 217)',
    '「录音」应走 action.primary.bg(与「快速会议」同款实心按钮)'
  )
  // 顺序:录音在导入左侧、同一行(与 App 端 RecordingHomeScreen 同序)。
  const importButton = page.getByRole('button', { name: '导入', exact: true })
  const [recordBox, importBox] = await Promise.all([
    recordButton.boundingBox(),
    importButton.boundingBox(),
  ])
  assert.ok(
    recordBox.x + recordBox.width <= importBox.x,
    `「录音」必须在「导入」左侧,实际 录音右缘 ${Math.round(
      recordBox.x + recordBox.width
    )} / 导入左缘 ${Math.round(importBox.x)}`
  )
  assert.ok(
    recordBox.y < importBox.y + importBox.height &&
      importBox.y < recordBox.y + recordBox.height,
    '「录音」与「导入」必须在同一行'
  )
  // 「导入」的图标是**向下**的箭头(RiDownload2Line),不再用向上的上传图标。
  const [downloadPath, uploadPath] = await Promise.all([
    iconPath('RiDownload2Line'),
    iconPath('RiUpload2Line'),
  ])
  const importIconPath = await importButton
    .locator('svg[aria-hidden="true"] path')
    .first()
    .getAttribute('d')
  assert.equal(importIconPath, downloadPath, '「导入」按钮应是向下的箭头图标')
  assert.notEqual(importIconPath, uploadPath, '「导入」不该再用向上的上传图标')
  await assertUnifiedPageChrome('AI 录音')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.waitForTimeout(120)
  const recordingListDark = await page
    .getByTestId('meeting-list-region')
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  assert.notEqual(
    recordingListDark,
    'rgb(255, 255, 255)',
    'AI 录音滚动区底色必须随主题翻转'
  )
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  // 历史录音 fixture 24 条 → 页面上限 20 条,顺带锁住 HISTORY_LIMIT。
  assert.equal(
    await page.getByRole('listitem').count(),
    20,
    '历史录音最多 20 行'
  )

  // 样板 ①:与实录/纪要一样铺满内容列。
  const recordingShell = await page.locator('main').boundingBox()
  const recordingColumn = await page.locator('main').evaluate((el) => {
    const box = el.parentElement.getBoundingClientRect()
    return { width: box.width }
  })
  assert.equal(
    Math.round(recordingShell.width),
    Math.round(recordingColumn.width),
    'AI 录音页也要铺满内容列'
  )

  // 样板 ②:入口块 + 页头钉住,只有历史列表滚(与实录/纪要同一规则)。
  const recordingList = page.getByTestId('meeting-list-region')
  assert.equal(
    await recordingList.count(),
    1,
    'AI 录音是列表页,必须有唯一的列表滚动区'
  )
  const recordButtonBefore = await recordButton.boundingBox()
  const recordingScrolled = await recordingList.evaluate((el) => {
    el.scrollTop = el.scrollHeight
    return el.scrollTop
  })
  assert.ok(recordingScrolled > 0, '历史列表应可滚动')
  const recordButtonAfter = await recordButton.boundingBox()
  assert.equal(
    Math.round(recordButtonAfter.y),
    Math.round(recordButtonBefore.y),
    '列表滚动时页头的工具按钮必须固定不动'
  )
  await recordingList.evaluate((el) => {
    el.scrollTop = 0
  })

  // 样板 ③:行风格与实录/纪要同一套 —— 行首 48px 图标块、标题同一字号。
  const anatomy = async (rowSelector) =>
    page
      .locator(rowSelector)
      .first()
      .evaluate((row) => {
        const tile = row.querySelector('span[aria-hidden]')
        const heading =
          row.querySelector('span[aria-hidden]')?.nextElementSibling
            ?.firstElementChild
        return {
          tileW: Math.round(tile.getBoundingClientRect().width),
          tileH: Math.round(tile.getBoundingClientRect().height),
          titleSize: heading ? getComputedStyle(heading).fontSize : null,
        }
      })
  const recordingRow = await anatomy(
    '[data-testid="meeting-list-region"] li:first-child a'
  )
  assert.deepEqual(
    { tileW: recordingRow.tileW, tileH: recordingRow.tileH },
    { tileW: 48, tileH: 48 },
    `录音历史行的图标块应为 48×48,实际 ${recordingRow.tileW}×${recordingRow.tileH}`
  )
  assert.equal(
    recordingRow.titleSize,
    '16px',
    `录音历史行标题应与实录/纪要同字号,实际 ${recordingRow.titleSize}`
  )
  // UX 修复:录音历史行的元信息与实录一致,是**单行横排**(时间 · 来源),不是竖排两行。
  const recordingMetaDirection = await page
    .locator(
      '[data-testid="meeting-list-region"] li:first-child a > span:nth-child(2) > span:nth-child(2)'
    )
    .evaluate((el) => getComputedStyle(el).flexDirection)
  assert.equal(
    recordingMetaDirection,
    'row',
    `录音行元信息应单行横排,实际 flex-direction=${recordingMetaDirection}`
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

  // 节标题上方的空白:节间距只由**一层**负责(容器给 marginTop,标题不再自带)。
  // 两层各顶 24px 时首节标题距固定区下沿 64px —— 就是截图里「预约会议 / 历史会议
  // 上面多出来的空白」;现在是一档 28px(滚动区上边距 4 + 节间距 24)。
  const homeSpacing = await page.evaluate(() => {
    const region = document.querySelector('[data-testid="meeting-list-region"]')
    const headings = [...region.querySelectorAll('h3')]
    const first = headings[0]
    const style = getComputedStyle(first)
    return {
      headingCount: headings.length,
      headingMarginTops: headings.map((el) => getComputedStyle(el).marginTop),
      sectionMarginTops: headings.map(
        (el) => getComputedStyle(el.parentElement).marginTop
      ),
      firstHeadingGap: Math.round(
        first.getBoundingClientRect().top +
          Number.parseFloat(style.paddingTop) -
          region.previousElementSibling.getBoundingClientRect().bottom
      ),
    }
  })
  assert.equal(
    homeSpacing.headingCount,
    2,
    '视频会议页是「预约会议 + 历史会议」两节'
  )
  assert.deepEqual(
    homeSpacing.headingMarginTops,
    ['0px', '0px'],
    '节容器已经排过节间距,节标题不该再自带一档(两层相加就是那截多余空白)'
  )
  assert.deepEqual(
    homeSpacing.sectionMarginTops,
    ['24px', '24px'],
    '节间距由容器给一档 xl(24px)'
  )
  assert.ok(
    Math.abs(homeSpacing.firstHeadingGap - 28) <= 2,
    `首节标题应距固定区下沿 28px(4px 滚动区上边距 + 24px 节间距),实际 ${homeSpacing.firstHeadingGap}px`
  )

  // 样板 ①:铺满内容列(不限宽居中)。
  const homeShell = await page.locator('main').boundingBox()
  const homeColumn = await page.locator('main').evaluate((el) => {
    const box = el.parentElement.getBoundingClientRect()
    return { width: box.width }
  })
  assert.equal(
    Math.round(homeShell.width),
    Math.round(homeColumn.width),
    '视频会议页也要铺满内容列'
  )

  // 样板 ②:视频会议也钉头(2026-09-16 起与另外三个栏目页一致)——页头(标题行 +
  // 三个入口)固定,只有下面两段会议列表滚。
  const homeList = page.getByTestId('meeting-list-region')
  assert.equal(await homeList.count(), 1, '视频会议页应有唯一的列表滚动区')
  const homeHeaderBefore = await page
    .getByRole('heading', { name: '视频会议', exact: true })
    .boundingBox()
  const homeQuickBefore = await page
    .getByRole('button', { name: '快速会议' })
    .boundingBox()
  const homeScrolled = await homeList.evaluate((el) => {
    el.scrollTop = el.scrollHeight
    return el.scrollTop
  })
  assert.ok(homeScrolled > 0, '两段会议列表应可滚动')
  const homeHeaderAfter = await page
    .getByRole('heading', { name: '视频会议', exact: true })
    .boundingBox()
  const homeQuickAfter = await page
    .getByRole('button', { name: '快速会议' })
    .boundingBox()
  assert.equal(
    Math.round(homeHeaderAfter.y),
    Math.round(homeHeaderBefore.y),
    '列表滚动时页头必须固定不动'
  )
  assert.equal(
    Math.round(homeQuickAfter.y),
    Math.round(homeQuickBefore.y),
    '列表滚动时页头的三个入口也必须固定不动'
  )
  // 三个入口在标题行里、右对齐(与标题竖向重叠,而不是另起一行)。
  const homeTitleBox = await page
    .getByRole('heading', { name: '视频会议', exact: true })
    .boundingBox()
  assert.ok(
    homeQuickBefore.y < homeTitleBox.y + homeTitleBox.height + 24 &&
      homeQuickBefore.y + homeQuickBefore.height > homeTitleBox.y,
    '三个入口应与页面标题同一行(竖向重叠)'
  )
  const homeListBox = await homeList.boundingBox()
  assert.ok(
    homeQuickBefore.x + homeQuickBefore.width >
      homeListBox.x + homeListBox.width / 2,
    '三个入口应右对齐'
  )
  // 三个入口都带图标(按钮里应有一个 aria-hidden 的 svg)。
  for (const name of ['快速会议', '加入会议', '预约会议']) {
    const icons = await page
      .getByRole('button', { name })
      .locator('svg[aria-hidden="true"]')
      .count()
    assert.ok(icons >= 1, `「${name}」应带图标`)
  }
  await homeList.evaluate((el) => {
    el.scrollTop = 0
  })

  // UX 修复:预约列表默认只预览 10 条,超出时可就地展开/收起。
  const previewCount = await page
    .locator('[data-testid^="scheduled-row-"]')
    .count()
  assert.equal(previewCount, 10, `预约列表默认预览 10 条,实际 ${previewCount}`)
  const expandButton = page.getByRole('button', { name: /查看全部/ })
  assert.equal(await expandButton.getAttribute('aria-expanded'), 'false')
  await expandButton.click()
  const expandedCount = await page
    .locator('[data-testid^="scheduled-row-"]')
    .count()
  assert.equal(expandedCount, 14, `展开后显示全部 14 条,实际 ${expandedCount}`)
  await page.getByRole('button', { name: '收起' }).click()
  assert.equal(
    await page.locator('[data-testid^="scheduled-row-"]').count(),
    10,
    '收起后回到 10 条'
  )
  // 区域底色:页壳浅灰 surface.canvas(滚动到尽头露出的那一层),列表滚动区白,
  // 页头那一栏也是白底 —— 2026-09-17 起对齐「消息」模块聊天窗口的标题栏。
  const homeRegionBg = await homeList.evaluate((el) => ({
    shell: getComputedStyle(el.closest('main')).backgroundColor,
    list: getComputedStyle(el).backgroundColor,
    fixedTop: getComputedStyle(el.previousElementSibling).backgroundColor,
  }))
  assert.equal(
    homeRegionBg.shell,
    'rgb(246, 246, 246)',
    `页壳应保持浅灰 surface.canvas,实际 ${homeRegionBg.shell}`
  )
  assert.equal(
    homeRegionBg.fixedTop,
    'rgb(255, 255, 255)',
    `页头那一栏应为白(对齐聊天窗口标题栏),实际 ${homeRegionBg.fixedTop}`
  )
  assert.equal(
    homeRegionBg.list,
    'rgb(255, 255, 255)',
    `列表滚动区应为白 surface.default,实际 ${homeRegionBg.list}`
  )
  // 解析不了的 scheduled_at 不再原样回显 —— 该行只剩标题。
  const dirtyRowText = await page
    .locator('[data-testid="scheduled-row-room-dirty"]')
    .innerText()
  assert.equal(
    dirtyRowText.trim(),
    '无日期会议',
    `脏值不该被画出来,实际行文本:${JSON.stringify(dirtyRowText)}`
  )
  // 点「查看全部」会把列表滚下去,复位回顶部,后面的截图才是首屏的样子。
  await homeList.evaluate((el) => {
    el.scrollTop = 0
  })

  // 样板 ③:两段会议列表的行风格与实录/纪要一致(48px 图标块 + 16px 标题)。
  const scheduledRow = await page
    .locator('[data-testid="scheduled-row-room-upcoming"]')
    .evaluate((row) => {
      const tile = row.querySelector('span[aria-hidden]')
      const heading = tile?.nextElementSibling?.firstElementChild
      return {
        tileW: Math.round(tile.getBoundingClientRect().width),
        tileH: Math.round(tile.getBoundingClientRect().height),
        titleSize: heading ? getComputedStyle(heading).fontSize : null,
      }
    })
  assert.deepEqual(
    { tileW: scheduledRow.tileW, tileH: scheduledRow.tileH },
    { tileW: 48, tileH: 48 },
    `预约会议行的图标块应为 48×48,实际 ${scheduledRow.tileW}×${scheduledRow.tileH}`
  )
  assert.equal(
    scheduledRow.titleSize,
    '16px',
    `会议行标题应与实录/纪要同字号,实际 ${scheduledRow.titleSize}`
  )
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
