// 「任务」筛选工具栏的走查(真实 Chromium,只挂这一个组件,不需要后端)。
//
// 守两件事:
//   ① 工具栏**永远是一行**:六个控件在 1024px 窗口(~590px 内容列)下放不下,从前是
//      折行、把「分组 / 排序 / 字段设置」甩到第二行右对齐;现在整行横滑。
//   ② 横滑不能把行内的下拉面板裁掉:`overflow-x: auto` 会让 `overflow-y` 也按 auto
//      算,`position: absolute` 的面板可视高度直接变 0(改之前实测),所以两个
//      `<details>` 面板挂在 fixed 坐标上 —— 这条是这次改动的关键,必须自动守住。
//
// 用法(cwd = src/frontend):
//   npm run dev
//   CAPTURE_TEST_ORIGIN=http://localhost:3187 node scripts/check-task-filter-toolbar-ui.mjs
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://localhost:3187'
const browser = await chromium.launch({ headless: true })
// 588px ≈ 1024px 窗口下任务内容列的实际宽度(左列 AppRail 192 + 任务面板 240)。
const COLUMN_WIDTH = 588

try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: COLUMN_WIDTH, height: 600 },
  })
  await context.route('**/task-toolbar-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Task toolbar check</title><div id="root"></div></html>',
    })
  )
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/task-toolbar-harness`)
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
    const { TaskFilterToolbar } =
      await import('/src/features/tasks/components/TaskFilterToolbar.tsx')
    const { DEFAULT_TASK_COLUMNS, DEFAULT_TASK_COLUMN_ORDER } =
      await import('/src/features/tasks/taskWorkspaceState.ts')
    const state = {
      scope: 'assigned',
      status: 'open',
      time: 'all',
      priority: 'all',
      ordering: '',
      grouping: 'none',
      columns: [...DEFAULT_TASK_COLUMNS],
      columnOrder: [...DEFAULT_TASK_COLUMN_ORDER],
      taskList: 'all',
      group: 'all',
      mode: 'list',
    }
    const noop = () => undefined
    createRoot(document.getElementById('root')).render(
      React.createElement(TaskFilterToolbar, {
        state,
        resultCount: 12,
        onStatusChange: noop,
        onTimeChange: noop,
        onPriorityChange: noop,
        onGroupingChange: noop,
        onOrderingChange: noop,
        onColumnsChange: noop,
        onClear: noop,
      })
    )
  })
  await page.getByLabel('状态').waitFor()

  const rowSelector = 'section[aria-label] > div:first-child'
  const rowMetrics = () =>
    page.locator(rowSelector).evaluate((row) => {
      const style = getComputedStyle(row)
      // 只算有尺寸的子元素:每个 Select 还会塞一个零尺寸的隐藏节点进来。
      const boxes = [...row.children]
        .map((child) => child.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0)
      // 一行 = 每个子元素与第一个子元素在竖直方向上有重叠(控件高度不同,不能比 top
      // 是否相等:工具栏是 align-items: end)。
      const singleLine =
        boxes.length > 0 &&
        boxes.every(
          (box) =>
            Math.max(box.top, boxes[0].top) <
            Math.min(box.bottom, boxes[0].bottom)
        )
      return {
        flexWrap: style.flexWrap,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        singleLine,
        childCount: boxes.length,
        boxes: boxes.map((box) => [
          Math.round(box.top),
          Math.round(box.bottom),
          Math.round(box.left),
          Math.round(box.width),
        ]),
        scrollWidth: row.scrollWidth,
        clientWidth: row.clientWidth,
        scrollLeft: row.scrollLeft,
        bottom: Math.round(row.getBoundingClientRect().bottom),
        top: Math.round(row.getBoundingClientRect().top),
      }
    })

  // ① 一行 + 横滑:内容比可视宽,说明「放不下」是真的,而不是没测到。
  const row = await rowMetrics()
  assert.equal(row.flexWrap, 'nowrap', '工具栏不得折行')
  assert.equal(row.overflowX, 'auto', '放不下时应整行横滑')
  assert.equal(row.singleLine, true, '工具栏只能有一行')
  assert.equal(row.childCount, 4, '工具栏是 三个筛选 + 一组显示设置')
  assert.ok(
    row.scrollWidth > row.clientWidth,
    `夹具应真的放不下(内容 ${row.scrollWidth}px / 可视 ${row.clientWidth}px)`
  )
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    ),
    '工具栏横滑不能把整页撑出横向滚动'
  )

  /** 面板必须完整可见:fixed 定位 + 落在视口内 + 不被滚动容器裁掉。 */
  const assertPanelVisible = async (label, trigger) => {
    await trigger.click()
    const panelSelector = `${rowSelector} details[open] > div`
    const panel = page.locator(panelSelector).first()
    await panel.waitFor()
    // 坐标是 React 渲染后写进内联样式的:等它落上再量,否则量到的是还没定位的一帧。
    await page.waitForFunction(
      (selector) => {
        const element = document.querySelector(selector)
        return Boolean(element && element.style.top)
      },
      panelSelector,
      { timeout: 5000 }
    )
    const metrics = await panel.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        position: style.position,
        zIndex: style.zIndex,
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        left: Math.round(box.left),
        right: Math.round(box.right),
        height: Math.round(box.height),
        browserBottom: window.innerHeight,
        browserWidth: window.innerWidth,
      }
    })
    const currentRow = await rowMetrics()
    assert.equal(
      metrics.position,
      'fixed',
      `${label}:面板必须是 fixed,否则会被工具栏的横滑裁剪区域吃掉`
    )
    // 被横滑容器裁掉时面板高度会直接变成 0(改之前就是),这条是最关键的一条。
    assert.ok(
      metrics.height > 100,
      `${label}:面板应完整展开,实际高 ${metrics.height}px`
    )
    assert.ok(
      metrics.top >= currentRow.top - 1,
      `${label}:面板应在工具栏下方,实际 top ${metrics.top}(工具栏 top ${currentRow.top})`
    )
    assert.ok(
      metrics.bottom <= metrics.browserBottom,
      `${label}:面板不得超出视口底部,实际 ${metrics.bottom} > ${metrics.browserBottom}`
    )
    assert.ok(
      metrics.left >= 0 && metrics.right <= metrics.browserWidth,
      `${label}:面板不得被推到视口外,实际 ${metrics.left}~${metrics.right}`
    )
    assert.notEqual(
      metrics.zIndex,
      'auto',
      `${label}:面板要压在工具栏与表头之上`
    )
    return metrics
  }

  // 「排序」触发器用 aria-label 定位:面板里也有一份「智能排序」文案,按文字点会撞上。
  const orderingPanel = await assertPanelVisible(
    '排序',
    page.getByLabel('排序')
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(80)
  assert.equal(
    await page.locator(`${rowSelector} details[open]`).count(),
    0,
    'Escape 应关闭排序面板'
  )

  const columnPanel = await assertPanelVisible(
    '字段设置',
    page.getByText('显示与排序', { exact: true })
  )
  assert.ok(
    columnPanel.height > 100,
    `字段设置面板应完整展开,实际高 ${columnPanel.height}px`
  )

  // ② 横滑后坐标跟随:面板不能留在原地,也不能被推出视口。
  await page.locator(rowSelector).evaluate((row) => {
    row.scrollLeft = row.scrollWidth
  })
  await page.waitForTimeout(120)
  const scrolled = await page
    .locator(`${rowSelector} details[open] > div`)
    .first()
    .evaluate((element) => {
      const box = element.getBoundingClientRect()
      return {
        top: Math.round(box.top),
        left: Math.round(box.left),
        right: Math.round(box.right),
        width: window.innerWidth,
      }
    })
  assert.ok(
    scrolled.left >= 0 && scrolled.right <= scrolled.width,
    `横滑后字段设置面板不得被推出视口,实际 ${scrolled.left}~${scrolled.right}`
  )
  // 横滑到底时,最后一个控件与右边缘之间要还有一档留白(滚动容器末端不吃
  // padding-right 的话,最后一个控件会贴着边缘)。
  const tailGap = await page.locator(rowSelector).evaluate((row) => {
    const last = [...row.children]
      .filter((child) => child.getBoundingClientRect().width > 0)
      .at(-1)
    return Math.round(
      row.getBoundingClientRect().right - last.getBoundingClientRect().right
    )
  })
  assert.ok(
    tailGap >= 12 && tailGap <= 20,
    `横滑到底应留一档 16px 尾部留白,实际 ${tailGap}px`
  )

  await page.screenshot({
    path: 'test-results/task-filter-toolbar.png',
    fullPage: true,
  })

  // ③ 宽屏不横滑、显示设置组仍然贴右:改成 nowrap 不能把宽屏版式带坏(右边距仍是
  //    原来那一档 16px)。
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1400, height: 600 })
  await page.waitForTimeout(150)
  const wide = await rowMetrics()
  assert.ok(
    wide.scrollWidth <= wide.clientWidth,
    `宽屏不该出现横向滚动(内容 ${wide.scrollWidth}px / 可视 ${wide.clientWidth}px)`
  )
  const wideGap = await page.locator(rowSelector).evaluate((row) => {
    const last = [...row.children]
      .filter((child) => child.getBoundingClientRect().width > 0)
      .at(-1)
    return Math.round(
      row.getBoundingClientRect().right - last.getBoundingClientRect().right
    )
  })
  assert.ok(
    wideGap >= 12 && wideGap <= 20,
    `宽屏显示设置组应贴右并留一档 16px 边距,实际 ${wideGap}px`
  )

  assert.deepEqual(errors, [], `页面不应有运行时错误:${errors.join(' / ')}`)
  console.log(
    'Task filter toolbar passed: 单行横向可滑(内容 %dpx / 可视 %dpx),两个下拉面板都是 fixed 且完整可见,横滑后坐标跟随;宽屏仍有 16px 右边距。截图:test-results/task-filter-toolbar.png',
    row.scrollWidth,
    row.clientWidth
  )
} finally {
  await browser.close()
}
