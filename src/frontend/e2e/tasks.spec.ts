import { expect, test, type BrowserContext, type Page } from '@playwright/test'

type TaskUser = {
  id: string
  full_name: string | null
  short_name: string | null
  email?: string | null
}

type CreatedTask = {
  id: string
  creator: TaskUser
  assignees?: TaskUser[]
  assignee: TaskUser | null
  recurrence?: {
    sequence: number
    frequency: 'daily' | 'weekly' | 'monthly'
  } | null
}

let taskId: string | undefined
let taskApiOrigin: string | undefined
let cleanupTaskIds: string[] = []

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
  if (!taskApiOrigin || cleanupTaskIds.length === 0) return
  const csrfCookie = (await context.cookies(taskApiOrigin)).find(
    (cookie) => cookie.name === 'csrftoken'
  )
  for (const id of [...cleanupTaskIds].reverse()) {
    const taskUrl =
      taskApiOrigin + '/api/v1.0/tasks/' + encodeURIComponent(id) + '/'
    const impactResponse = await context.request.get(
      taskUrl + 'subtree-impact/'
    )
    const impact = impactResponse.ok()
      ? ((await impactResponse.json()) as { node_count: number })
      : undefined
    const deleteUrl = impact
      ? taskUrl + '?confirm_subtree_node_count=' + impact.node_count
      : taskUrl
    const response = await context.request.delete(deleteUrl, {
      headers: csrfCookie ? { 'X-CSRFToken': csrfCookie.value } : undefined,
    })
    if (response.status() !== 204 && response.status() !== 404) {
      throw new Error(`Task cleanup failed with HTTP ${response.status()}`)
    }
  }
  taskId = undefined
  taskApiOrigin = undefined
  cleanupTaskIds = []
}

test.afterEach(async ({ context }) => {
  await deleteCreatedTask(context)
})

test('create, edit, persist, and complete a self-assigned task', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const title = `E2E 任务 ${Date.now()}`
  const startDate = await dateInBrowserTimezone(page, 0)
  const dueDate = await dateInBrowserTimezone(page, 1)

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
  cleanupTaskIds.push(createdTask.id)

  await page.getByRole('button', { name: '关闭任务面板' }).click()
  let row = page.getByRole('row', { name: `打开任务：${title}` })
  await expect(row).toBeVisible({ timeout: 15_000 })

  const assignee = createdTask.assignees?.[0] || createdTask.assignee
  expect(assignee).toBeDefined()
  expect(assignee).not.toBeNull()
  const assigneeName = displayName(assignee!)
  const assigneeControl = row.getByRole('button', { name: '编辑 负责人' })
  if (assigneeName) {
    await expect(assigneeControl).toContainText(assigneeName)
  }
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
  await expect(row).toBeVisible({ timeout: 15_000 })
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

  await page.keyboard.press('Control+k')
  await page.getByTestId('global-search-input').fill(title)
  await page.getByTestId('global-search-tab-tasks').click()
  const searchResult = page.getByTestId(`global-search-task-${taskId}`)
  await expect(searchResult).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('global-search-task-filter-creator').click()
  await page
    .getByTestId(
      `global-search-task-filter-creator-option-${createdTask.creator.id}`
    )
    .click()
  await page.keyboard.press('Escape')

  await page.getByTestId('global-search-task-filter-assignee').click()
  await page
    .getByTestId(`global-search-task-filter-assignee-option-${assignee!.id}`)
    .click()
  await page.keyboard.press('Escape')

  await page.getByTestId('global-search-task-filter-status').click()
  await page.getByTestId('global-search-task-filter-status-todo').click()
  await page.getByTestId('global-search-task-filter-due').click()
  await page.getByTestId('global-search-task-filter-due-tomorrow').click()
  await expect(searchResult).toBeVisible({ timeout: 20_000 })

  await searchResult.click()
  await expect(page).toHaveURL(new RegExp(`task=${taskId}`))
  await expect(
    page.getByRole('complementary', { name: '任务详情' })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('complementary', { name: '任务详情' })
  ).toBeVisible()
  await page.goto(
    `/tasks?scope=all&status=open&time=all&priority=all&task_list=all&view=list&task=${taskId}`
  )
  row = page.getByRole('row', { name: `打开任务：${title}` })

  const completePatch = waitForTaskPatch(page, taskId)
  await page
    .getByRole('complementary', { name: '任务详情' })
    .getByRole('button', { name: '完成任务', exact: true })
    .click()
  await completePatch
  await expect(
    page
      .getByRole('complementary', { name: '任务详情' })
      .getByRole('button', { name: '重启任务' })
  ).toBeVisible()

  await page
    .getByRole('complementary', { name: '任务视图' })
    .getByRole('button', { name: /^已完成/ })
    .click()
  row = page.getByRole('row', { name: `打开任务：${title}` })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.getByRole('button', { name: '编辑 优先级' })).toContainText(
    '高'
  )
  await row.getByRole('button', { name: '编辑 截止日期' }).click()
  await expect(row.getByLabel('截止日期')).toHaveValue(dueDate)
  await row.getByLabel('截止日期').press('Escape')
})

test('create and advance a recurring task without duplicating its cycle', async ({
  context,
  page,
}) => {
  test.setTimeout(90_000)
  const title = `E2E 每日重复任务 ${Date.now()}`

  await page.goto(
    '/tasks?scope=all&status=open&time=all&priority=all&task_list=all&view=list'
  )
  await page.getByRole('button', { name: '新建任务' }).click()
  const createPanel = page.getByRole('dialog', { name: '新建任务' })
  await createPanel.getByPlaceholder('输入标题，回车确认').fill(title)
  await createPanel.getByRole('button', { name: /重复任务/ }).click()
  await page.getByRole('option', { name: '每天重复' }).click()

  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/v1.0/tasks/') &&
      response.ok()
  )
  await createPanel.getByRole('button', { name: '新建', exact: true }).click()
  const createResponse = await createResponsePromise
  const first = (await createResponse.json()) as CreatedTask
  expect(first.recurrence?.frequency).toBe('daily')
  expect(first.recurrence?.sequence).toBe(1)
  taskId = first.id
  taskApiOrigin = new URL(createResponse.url()).origin
  cleanupTaskIds.push(first.id)

  const completeResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      response.url().endsWith(`/api/v1.0/tasks/${first.id}/`) &&
      response.ok()
  )
  await page
    .getByRole('complementary', { name: '任务详情' })
    .getByRole('button', { name: '完成任务', exact: true })
    .click()
  await completeResponsePromise

  const openTasksResponse = await context.request.get(
    `${taskApiOrigin}/api/v1.0/tasks/?scope=all&status=open&q=${encodeURIComponent(title)}&page_size=50`
  )
  expect(openTasksResponse.ok()).toBe(true)
  const openTasksPayload = (await openTasksResponse.json()) as {
    results: CreatedTask[]
  }
  const following = openTasksPayload.results.filter(
    (candidate) => candidate.id !== first.id
  )
  expect(following).toHaveLength(1)
  expect(following[0].recurrence?.sequence).toBe(2)
  cleanupTaskIds.push(following[0].id)
})

test('close the bounded recursive hierarchy through depth, movement, and deletion', async ({
  context,
  page,
}) => {
  test.setTimeout(90_000)
  const suffix = Date.now()
  const rootTitle = 'E2E 根任务 ' + suffix
  const targetTitle = 'E2E 移动目标 ' + suffix
  const subtaskTitles = Array.from(
    { length: 5 },
    (_value, index) => `E2E ${index + 1} 级子任务 ${suffix}`
  )

  await page.goto(
    '/tasks?scope=all&status=open&time=all&priority=all&task_list=all&view=list'
  )
  const createRootTask = async (title: string) => {
    await page.getByRole('button', { name: '新建任务' }).click()
    await page.getByPlaceholder('输入标题，回车确认').fill(title)
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/v1.0/tasks/') &&
        response.ok()
    )
    await page.getByRole('button', { name: '新建', exact: true }).click()
    const response = await responsePromise
    const created = (await response.json()) as CreatedTask
    await page.getByRole('button', { name: '关闭任务面板' }).click()
    return { created, response }
  }

  const { created: root, response: rootResponse } =
    await createRootTask(rootTitle)
  taskId = root.id
  taskApiOrigin = new URL(rootResponse.url()).origin
  cleanupTaskIds.push(root.id)
  const csrfCookie = (await context.cookies(taskApiOrigin)).find(
    (cookie) => cookie.name === 'csrftoken'
  )
  const targetResponse = await context.request.post(
    taskApiOrigin + '/api/v1.0/tasks/',
    {
      data: { title: targetTitle },
      headers: csrfCookie ? { 'X-CSRFToken': csrfCookie.value } : undefined,
    }
  )
  expect(targetResponse.ok()).toBe(true)
  const target = (await targetResponse.json()) as CreatedTask
  cleanupTaskIds.push(target.id)

  await page.getByRole('row', { name: '打开任务：' + rootTitle }).press('Enter')
  let details = page.getByRole('complementary', { name: '任务详情' })
  const createdSubtasks: CreatedTask[] = []

  for (const subtaskTitle of subtaskTitles) {
    details = page.getByRole('complementary', { name: '任务详情' })
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/v1.0/tasks/') &&
        response.ok()
    )
    await details.getByRole('button', { name: '添加子任务' }).click()
    const createDialog = page.getByRole('dialog', { name: '新建任务' })
    await createDialog.getByPlaceholder('输入标题，回车确认').fill(subtaskTitle)
    await createDialog
      .getByRole('button', { name: '新建', exact: true })
      .click()
    const created = (await (await responsePromise).json()) as CreatedTask
    createdSubtasks.push(created)
    await expect(page).toHaveURL(new RegExp(`task=${created.id}`), {
      timeout: 15_000,
    })
  }

  const child = createdSubtasks[0]
  const leaf = createdSubtasks.at(-1)!

  details = page.getByRole('complementary', { name: '任务详情' })
  await expect(
    details.getByRole('navigation', { name: '任务父链' })
  ).toContainText([rootTitle, ...subtaskTitles.slice(0, -1)].join('›'))
  const completePatch = waitForTaskPatch(page, leaf.id)
  await details.getByRole('button', { name: '完成任务', exact: true }).click()
  await completePatch

  await page.goto('/tasks?scope=all&status=all&task=' + root.id)
  details = page.getByRole('complementary', { name: '任务详情' })
  await expect(details).toContainText('1 / 5')
  await expect(
    details.getByRole('button', { name: '完成任务', exact: true })
  ).toBeVisible()

  const childDetailRow = details
    .getByRole('listitem')
    .filter({ hasText: subtaskTitles[0] })
  await childDetailRow
    .getByRole('button', { name: '打开任务：' + subtaskTitles[0] })
    .click()
  await expect(
    page.getByRole('row', { name: '打开任务：' + subtaskTitles[0] })
  ).toHaveAttribute('data-selected', 'true', { timeout: 15_000 })

  await page.keyboard.press('Control+k')
  await page.getByTestId('global-search-input').fill(subtaskTitles.at(-1)!)
  await page.getByTestId('global-search-tab-tasks').click()
  await expect(page.getByTestId('global-search-task-' + leaf.id)).toContainText(
    [rootTitle, ...subtaskTitles].join(' › '),
    { timeout: 15_000 }
  )
  await page.keyboard.press('Escape')

  details = page.getByRole('complementary', { name: '任务详情' })
  await details.getByRole('button', { name: '编辑 父任务' }).click()
  const movePatch = waitForTaskPatch(page, child.id)
  await page.getByRole('option', { name: targetTitle }).click()
  const moveDialog = page.getByRole('dialog', { name: '移动任务子树' })
  await expect(moveDialog).toContainText('共 5 个任务')
  await moveDialog.getByRole('button', { name: '移动任务' }).click()
  await movePatch
  await expect(
    details.getByRole('navigation', { name: '任务父链' })
  ).toContainText(targetTitle)

  await page.goto('/tasks?scope=all&status=all&task=' + target.id)
  details = page.getByRole('complementary', { name: '任务详情' })
  await details.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '删除任务' }).click()
  const deleteDialog = page.getByRole('dialog', { name: '删除任务' })
  await expect(deleteDialog).toContainText('5 个子任务')
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes('/api/v1.0/tasks/' + target.id + '/') &&
      response.ok()
  )
  await deleteDialog.getByRole('button', { name: '删除任务' }).click()
  await deleteResponse
  await expect(
    page.getByRole('row', { name: '打开任务：' + targetTitle })
  ).not.toBeVisible()

  expect(child.id).not.toBe(root.id)
})
