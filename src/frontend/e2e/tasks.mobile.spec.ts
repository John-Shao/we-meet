import { expect, test } from '@playwright/test'

import {
  createTaskVisualFixture,
  deleteTaskVisualFixture,
  settleTaskVisuals,
  taskVisualListUrl,
  type TaskVisualFixture,
} from './taskVisualFixture'

let visualFixture: TaskVisualFixture | undefined

test.afterEach(async ({ context }) => {
  await deleteTaskVisualFixture(context, visualFixture)
  visualFixture = undefined
})

test('keeps the task workspace usable and visually stable on mobile', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => {
    window.localStorage.removeItem('we-meet:rail-collapsed')
  })
  const fixture = await createTaskVisualFixture(page, {
    taskListName: 'E2E 移动端视觉回归',
    description: 'Playwright mobile visual regression fixture',
  })
  visualFixture = fixture
  const listUrl = taskVisualListUrl(fixture)

  await page.goto(listUrl)
  const railToggle = page.getByTestId('rail-collapse-toggle')
  await expect(railToggle).toHaveAccessibleName('展开导航栏')
  await railToggle.click()
  await expect(railToggle).toHaveAccessibleName('收起导航栏')
  await railToggle.click()
  await expect(railToggle).toHaveAccessibleName('展开导航栏')
  const filterDisclosure = page.getByRole('button', { name: /任务筛选/ })
  await expect(filterDisclosure).toHaveAttribute('aria-expanded', 'false')
  await filterDisclosure.click()
  await expect(filterDisclosure).toHaveAttribute('aria-expanded', 'true')
  await expect(
    page.locator('#task-filter-controls').getByRole('button', { name: /状态/ })
  ).toBeVisible()
  await filterDisclosure.click()
  await expect(filterDisclosure).toHaveAttribute('aria-expanded', 'false')
  const rootCard = page.getByRole('button', {
    name: `打开任务：${fixture.root.title}`,
    exact: true,
  })
  await expect(rootCard).toBeVisible({ timeout: 20_000 })
  await page
    .getByRole('button', {
      name: `展开“${fixture.root.title}”的子任务`,
    })
    .click()
  await expect(
    page.getByRole('button', {
      name: `打开任务：${fixture.research.title}`,
      exact: true,
    })
  ).toBeVisible()
  await expect(page.getByText('4 个匹配结果')).toBeVisible()
  await settleTaskVisuals(page)
  await expect(page).toHaveScreenshot('tasks-mobile-list.png')

  const moveHandle = page.getByRole('button', {
    name: `拖拽或选择分组以移动“${fixture.root.title}”`,
  })
  await moveHandle.click()
  const moveMenu = page.getByRole('menu', {
    name: `拖拽或选择分组以移动“${fixture.root.title}”`,
  })
  await expect(moveMenu).toBeVisible()
  await expect(
    moveMenu.getByRole('menuitemradio', { name: fixture.delivery.name })
  ).toBeVisible()
  await settleTaskVisuals(page)
  await expect(page).toHaveScreenshot('tasks-mobile-move-menu.png')
  await page.keyboard.press('Escape')

  await rootCard.click()
  const details = page.getByRole('complementary', { name: '任务详情' })
  await expect(details).toBeVisible()
  await expect(details.getByRole('heading', { name: '协作' })).toBeVisible()
  await expect(
    details.getByRole('heading', { name: '计划与归属' })
  ).toBeVisible()
  await expect(details.getByRole('heading', { name: '任务内容' })).toBeVisible()
  await expect(
    details.getByRole('button', { name: `上移“${fixture.research.title}”` })
  ).toBeDisabled()
  await settleTaskVisuals(page)
  await expect(page).toHaveScreenshot('tasks-mobile-detail.png')

  await page.goto(
    `/tasks?scope=all&status=open&time=all&priority=urgent&task_list=${fixture.taskList.id}&view=list`
  )
  const emptyState = page.getByRole('status').filter({
    has: page.getByRole('heading', { name: '没有匹配的任务' }),
  })
  await expect(emptyState).toBeVisible()
  await expect(
    emptyState.getByRole('button', { name: '清除筛选' })
  ).toBeVisible()
  await settleTaskVisuals(page)
  await expect(page).toHaveScreenshot('tasks-mobile-empty-filter.png')
})
