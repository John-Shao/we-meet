import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
  type Page,
} from '@playwright/test'

type CreatedTask = {
  id: string
  title: string
}

type CreatedTaskList = {
  id: string
  name: string
}

type CreatedTaskGroup = {
  id: string
  name: string
}

let apiOrigin: string | undefined
let taskList: CreatedTaskList | undefined
let createdTaskIds: string[] = []

const requestHeaders = async (context: BrowserContext) => {
  if (!apiOrigin) throw new Error('The task API origin is not initialized.')
  const csrfCookie = (await context.cookies(apiOrigin)).find(
    (cookie) => cookie.name === 'csrftoken'
  )
  return csrfCookie ? { 'X-CSRFToken': csrfCookie.value } : undefined
}

const expectApiSuccess = async (response: APIResponse, operation: string) => {
  if (response.ok()) return
  throw new Error(
    `${operation} failed with HTTP ${response.status()}: ${await response.text()}`
  )
}

const postJson = async <T>(
  page: Page,
  path: string,
  data: Record<string, unknown>
) => {
  if (!apiOrigin) throw new Error('The task API origin is not initialized.')
  const response = await page.request.post(`${apiOrigin}/api/v1.0/${path}`, {
    data,
    headers: await requestHeaders(page.context()),
  })
  await expectApiSuccess(response, `POST ${path}`)
  return (await response.json()) as T
}

const createVisualFixture = async (page: Page) => {
  const initialTasksResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/v1.0/tasks/' &&
      response.ok()
  )
  await page.goto(
    '/tasks?scope=all&status=open&time=all&priority=all&task_list=all&view=list'
  )
  apiOrigin = new URL((await initialTasksResponse).url()).origin

  taskList = await postJson<CreatedTaskList>(page, 'task-lists/', {
    name: 'E2E 移动端视觉回归',
    description: 'Playwright mobile visual regression fixture',
    color: 'blue',
  })
  const discovery = await postJson<CreatedTaskGroup>(
    page,
    `task-lists/${taskList.id}/groups/`,
    { name: '需求阶段', sort_order: 0 }
  )
  const delivery = await postJson<CreatedTaskGroup>(
    page,
    `task-lists/${taskList.id}/groups/`,
    { name: '交付阶段', sort_order: 1 }
  )

  const root = await postJson<CreatedTask>(page, 'tasks/', {
    title: '产品发布准备',
    description: '确认范围、设计、开发与发布安排。',
    priority: 'high',
    start_date: '2030-08-26',
    due_date: '2030-09-01',
    task_list_id: taskList.id,
    group_id: discovery.id,
  })
  createdTaskIds.push(root.id)

  const research = await postJson<CreatedTask>(page, 'tasks/', {
    title: '竞品调研',
    priority: 'medium',
    due_date: '2030-08-29',
    task_list_id: taskList.id,
    group_id: discovery.id,
    parent_id: root.id,
  })
  createdTaskIds.push(research.id)

  const prototype = await postJson<CreatedTask>(page, 'tasks/', {
    title: '交互原型确认',
    priority: 'low',
    due_date: '2030-08-30',
    task_list_id: taskList.id,
    group_id: discovery.id,
    parent_id: root.id,
  })
  createdTaskIds.push(prototype.id)

  const implementation = await postJson<CreatedTask>(page, 'tasks/', {
    title: '移动端适配',
    priority: 'high',
    due_date: '2030-09-01',
    task_list_id: taskList.id,
    group_id: delivery.id,
  })
  createdTaskIds.push(implementation.id)

  const completeResponse = await page.request.patch(
    `${apiOrigin}/api/v1.0/tasks/${prototype.id}/`,
    {
      data: { status: 'completed' },
      headers: await requestHeaders(page.context()),
    }
  )
  await expectApiSuccess(completeResponse, `complete task ${prototype.id}`)

  return { root, research, prototype, implementation, discovery, delivery }
}

const deleteVisualFixture = async (context: BrowserContext) => {
  if (!apiOrigin) return
  const request = context.request
  const headers = await requestHeaders(context)
  for (const taskId of [...createdTaskIds].reverse()) {
    const taskUrl = `${apiOrigin}/api/v1.0/tasks/${encodeURIComponent(taskId)}/`
    const impactResponse = await request.get(`${taskUrl}subtree-impact/`)
    const impact = impactResponse.ok()
      ? ((await impactResponse.json()) as { node_count: number })
      : undefined
    const deleteResponse = await request.delete(
      impact
        ? `${taskUrl}?confirm_subtree_node_count=${impact.node_count}`
        : taskUrl,
      { headers }
    )
    if (deleteResponse.status() !== 204 && deleteResponse.status() !== 404) {
      throw new Error(
        `Task cleanup failed with HTTP ${deleteResponse.status()}`
      )
    }
  }
  if (taskList) {
    const listResponse = await request.delete(
      `${apiOrigin}/api/v1.0/task-lists/${encodeURIComponent(taskList.id)}/?delete_unassigned=true`,
      { headers }
    )
    if (listResponse.status() !== 204 && listResponse.status() !== 404) {
      throw new Error(
        `Task-list cleanup failed with HTTP ${listResponse.status()}`
      )
    }
  }
  apiOrigin = undefined
  taskList = undefined
  createdTaskIds = []
}

const settleVisuals = async (page: Page) => {
  await page.evaluate(async () => {
    await document.fonts.ready
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
}

test.afterEach(async ({ context }) => {
  await deleteVisualFixture(context)
})

test('keeps the task workspace usable and visually stable on mobile', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => {
    window.localStorage.setItem('we-meet:rail-collapsed', '1')
  })
  const fixture = await createVisualFixture(page)
  const listUrl =
    `/tasks?scope=all&status=all&time=all&priority=all&task_list=${taskList!.id}` +
    '&view=list'

  await page.goto(listUrl)
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
  await settleVisuals(page)
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
  await settleVisuals(page)
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
  await settleVisuals(page)
  await expect(page).toHaveScreenshot('tasks-mobile-detail.png')

  await page.goto(
    `/tasks?scope=all&status=open&time=all&priority=urgent&task_list=${taskList!.id}&view=list`
  )
  const emptyState = page.getByRole('status').filter({
    has: page.getByRole('heading', { name: '没有匹配的任务' }),
  })
  await expect(emptyState).toBeVisible()
  await expect(
    emptyState.getByRole('button', { name: '清除筛选' })
  ).toBeVisible()
  await settleVisuals(page)
  await expect(page).toHaveScreenshot('tasks-mobile-empty-filter.png')
})
