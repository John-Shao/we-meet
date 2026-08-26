import { expect, test, type BrowserContext, type Page } from '@playwright/test'

type TaskUser = {
  full_name: string | null
  short_name: string | null
  email?: string | null
}

type CreatedTask = {
  id: string
  assignees?: TaskUser[]
  assignee: TaskUser | null
}

let taskId: string | undefined
let taskApiOrigin: string | undefined

const dateInBrowserTimezone = (page: Page, daysFromToday: number) =>
  page.evaluate((days) => {
    const value = new Date()
    value.setDate(value.getDate() + days)
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-')
  }, daysFromToday)

const waitForTaskPatch = (page: Page, id: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      response.url().endsWith(`/api/v1.0/tasks/${id}/`) &&
      response.ok()
  )

const displayName = (user: TaskUser) =>
  user.full_name || user.short_name || user.email || ''

const deleteCreatedTask = async (context: BrowserContext) => {
  if (!taskId || !taskApiOrigin) return
  const csrfCookie = (await context.cookies(taskApiOrigin)).find(
    (cookie) => cookie.name === 'csrftoken'
  )
  const response = await context.request.delete(
    `${taskApiOrigin}/api/v1.0/tasks/${encodeURIComponent(taskId)}/`,
    {
      headers: csrfCookie ? { 'X-CSRFToken': csrfCookie.value } : undefined,
    }
  )
  if (response.status() !== 204 && response.status() !== 404) {
    throw new Error(`Task cleanup failed with HTTP ${response.status()}`)
  }
  taskId = undefined
  taskApiOrigin = undefined
}

test.afterEach(async ({ context }) => {
  await deleteCreatedTask(context)
})

test('create, edit, persist, and complete a self-assigned task', async ({
  page,
}) => {
  const title = `E2E 任务 ${Date.now()}`
  const startDate = await dateInBrowserTimezone(page, 2)
  const dueDate = await dateInBrowserTimezone(page, 4)

  await page.goto(
    '/tasks?scope=all&status=open&time=all&priority=all&task_list=all&view=list'
  )
  await page.getByRole('button', { name: '新建任务' }).click()
  await page.getByPlaceholder('输入标题，回车确认').fill(title)

  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/v1.0/tasks/') &&
      response.ok()
  )
  await page.getByRole('button', { name: '新建', exact: true }).click()
  const createResponse = await createResponsePromise
  const createdTask = (await createResponse.json()) as CreatedTask
  taskId = createdTask.id
  taskApiOrigin = new URL(createResponse.url()).origin

  await page.getByRole('button', { name: '关闭任务面板' }).click()
  let row = page.getByRole('row', { name: `打开任务：${title}` })
  await expect(row).toBeVisible()

  const assignee = createdTask.assignees?.[0] || createdTask.assignee
  expect(assignee).toBeDefined()
  expect(assignee).not.toBeNull()
  const assigneeName = displayName(assignee!)
  expect(assigneeName).not.toBe('')
  const assigneeControl = row.getByRole('button', { name: '编辑 负责人' })
  await expect(assigneeControl).toContainText(assigneeName)
  await expect(assigneeControl).not.toContainText('我自己')
  await expect(
    assigneeControl.locator(':is(span, img)[aria-hidden="true"]').first()
  ).toBeVisible()

  await row.getByRole('button', { name: '编辑 优先级' }).click()
  const priorityPatch = waitForTaskPatch(page, taskId)
  await page.getByRole('option', { name: '高', exact: true }).click()
  await priorityPatch

  row = page.getByRole('row', { name: `打开任务：${title}` })
  await row.getByRole('button', { name: '编辑 截止日期' }).click()
  const dueDateInput = row.getByLabel('截止日期')
  await dueDateInput.fill(dueDate)
  const dueDatePatch = waitForTaskPatch(page, taskId)
  await dueDateInput.press('Enter')
  await dueDatePatch

  row = page.getByRole('row', { name: `打开任务：${title}` })
  await row.press('Enter')
  const details = page.getByRole('complementary', { name: '任务详情' })
  await expect(details).toBeVisible()
  await details.getByRole('button', { name: '编辑 开始日期' }).click()
  const startDateInput = details.getByLabel('开始日期')
  await startDateInput.fill(startDate)
  const startDatePatch = waitForTaskPatch(page, taskId)
  await startDateInput.press('Enter')
  await startDatePatch

  await page.reload()
  row = page.getByRole('row', { name: `打开任务：${title}` })
  await expect(row).toBeVisible()
  await expect(row.getByRole('button', { name: '编辑 负责人' })).toContainText(
    assigneeName
  )
  await expect(row.getByRole('button', { name: '编辑 优先级' })).toContainText(
    '高'
  )

  const reloadedDetails = page.getByRole('complementary', { name: '任务详情' })
  await reloadedDetails.getByRole('button', { name: '编辑 开始日期' }).click()
  await expect(reloadedDetails.getByLabel('开始日期')).toHaveValue(startDate)
  const persistedDatePatch = waitForTaskPatch(page, taskId)
  await reloadedDetails.getByLabel('开始日期').press('Enter')
  await persistedDatePatch

  const completePatch = waitForTaskPatch(page, taskId)
  await reloadedDetails.getByRole('button', { name: '完成任务' }).click()
  await completePatch
  await expect(row).toHaveCount(0)

  await page
    .getByRole('complementary', { name: '任务视图' })
    .getByRole('button', { name: /^已完成/ })
    .click()
  row = page.getByRole('row', { name: `打开任务：${title}` })
  await expect(row).toBeVisible()
  await expect(row.getByRole('button', { name: '编辑 优先级' })).toContainText(
    '高'
  )
  await row.getByRole('button', { name: '编辑 截止日期' }).click()
  await expect(row.getByLabel('截止日期')).toHaveValue(dueDate)
  await row.getByLabel('截止日期').press('Escape')
})
