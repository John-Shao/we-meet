import { expect, test, type Page } from '@playwright/test'

import {
  createTaskVisualFixture,
  deleteTaskVisualFixture,
  settleTaskVisuals,
  taskVisualListUrl,
  type TaskVisualFixture,
} from './taskVisualFixture'

let visualFixture: TaskVisualFixture | undefined

const openExpandedTaskList = async (
  page: Page,
  fixture: TaskVisualFixture,
  listUrl: string
) => {
  await page.goto(listUrl)
  const expandButton = page.getByRole('button', {
    name: `展开“${fixture.root.title}”的子任务`,
  })
  await expect(expandButton).toBeVisible({ timeout: 20_000 })
  await expandButton.click()
  await expect(
    page
      .getByText(fixture.research.title, { exact: true })
      .filter({ visible: true })
  ).toBeVisible()
  await expect(page.getByText('4 个匹配结果')).toBeVisible()
  await settleTaskVisuals(page)
}

const screenshotOptions = (fixture: TaskVisualFixture) => ({
  mask: [fixture.createdAtCells],
  maskColor: '#f2f3f5',
})

test.afterEach(async ({ context }) => {
  await deleteTaskVisualFixture(context, visualFixture)
  visualFixture = undefined
})

test('keeps the task workspace visually stable across responsive widths', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await page.addInitScript(() => {
    window.localStorage.removeItem('we-meet:rail-collapsed')
    window.localStorage.removeItem('we-meet-task-panel-width')
  })

  const fixture = await createTaskVisualFixture(page)
  visualFixture = fixture
  const listUrl = taskVisualListUrl(fixture)

  await page.setViewportSize({ width: 1600, height: 900 })
  await openExpandedTaskList(page, fixture, listUrl)
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByRole('button', { name: /任务筛选/ })).toBeHidden()
  await expect(fixture.createdAtCells).toHaveCount(4)
  await expect(page).toHaveScreenshot(
    'tasks-desktop-list.png',
    screenshotOptions(fixture)
  )

  const desktopRootRow = page.getByRole('row', {
    name: `打开任务：${fixture.root.title}`,
  })
  await desktopRootRow.focus()
  await desktopRootRow.press('Enter')
  const desktopDetails = page.getByRole('complementary', { name: '任务详情' })
  await expect(desktopDetails).toBeVisible()
  await expect(
    desktopDetails
      .getByText(fixture.root.title, { exact: true })
      .filter({ visible: true })
  ).toBeVisible()
  await expect(
    desktopDetails.getByRole('button', {
      name: `上移“${fixture.research.title}”`,
    })
  ).toBeDisabled({ timeout: 20_000 })
  await expect(desktopDetails.getByText('正在加载子任务…')).toBeHidden()
  await settleTaskVisuals(page)
  await expect(page).toHaveScreenshot(
    'tasks-desktop-detail.png',
    screenshotOptions(fixture)
  )

  await page.setViewportSize({ width: 1024, height: 768 })
  await openExpandedTaskList(page, fixture, listUrl)
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByRole('button', { name: /任务筛选/ })).toBeHidden()
  await expect(page).toHaveScreenshot(
    'tasks-web-1024.png',
    screenshotOptions(fixture)
  )

  await page.setViewportSize({ width: 1366, height: 768 })
  await openExpandedTaskList(page, fixture, listUrl)
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page).toHaveScreenshot(
    'tasks-web-1366.png',
    screenshotOptions(fixture)
  )

  await page.setViewportSize({ width: 1439, height: 810 })
  await page.goto(`${listUrl}&task=${fixture.root.id}`)
  const narrowDetails = page.getByRole('complementary', { name: '任务详情' })
  await expect(narrowDetails).toBeVisible({ timeout: 20_000 })
  await expect(
    narrowDetails
      .getByText(fixture.root.title, { exact: true })
      .filter({ visible: true })
  ).toBeVisible()
  await expect(
    narrowDetails.getByRole('button', {
      name: `上移“${fixture.research.title}”`,
    })
  ).toBeDisabled({ timeout: 20_000 })
  await expect(narrowDetails.getByText('正在加载子任务…')).toBeHidden()
  await settleTaskVisuals(page)
  await expect(page).toHaveScreenshot(
    'tasks-web-detail-1439.png',
    screenshotOptions(fixture)
  )

  await page.setViewportSize({ width: 1440, height: 810 })
  await expect(narrowDetails).toBeVisible()
  await settleTaskVisuals(page)
  await expect(page).toHaveScreenshot(
    'tasks-web-detail-1440.png',
    screenshotOptions(fixture)
  )
})
