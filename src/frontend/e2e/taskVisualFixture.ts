import type {
  APIResponse,
  BrowserContext,
  Locator,
  Page,
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

export type TaskVisualFixture = {
  apiOrigin: string
  taskList: CreatedTaskList
  root: CreatedTask
  research: CreatedTask
  prototype: CreatedTask
  implementation: CreatedTask
  discovery: CreatedTaskGroup
  delivery: CreatedTaskGroup
  createdAtCells: Locator
}

const requestHeaders = async (context: BrowserContext, apiOrigin: string) => {
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
  apiOrigin: string,
  path: string,
  data: Record<string, unknown>
) => {
  const response = await page.request.post(`${apiOrigin}/api/v1.0/${path}`, {
    data,
    headers: await requestHeaders(page.context(), apiOrigin),
  })
  await expectApiSuccess(response, `POST ${path}`)
  return (await response.json()) as T
}

export const createTaskVisualFixture = async (
  page: Page
): Promise<TaskVisualFixture> => {
  const initialTasksResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/v1.0/tasks/' &&
      response.ok()
  )
  await page.goto(
    '/tasks?scope=all&status=open&time=all&priority=all&task_list=all&view=list'
  )
  const apiOrigin = new URL((await initialTasksResponse).url()).origin

  const taskList = await postJson<CreatedTaskList>(
    page,
    apiOrigin,
    'task-lists/',
    {
      name: 'E2E 任务视觉回归',
      description: 'Playwright task visual regression fixture',
      color: 'blue',
    }
  )
  const discovery = await postJson<CreatedTaskGroup>(
    page,
    apiOrigin,
    `task-lists/${taskList.id}/groups/`,
    { name: '需求阶段', sort_order: 0 }
  )
  const delivery = await postJson<CreatedTaskGroup>(
    page,
    apiOrigin,
    `task-lists/${taskList.id}/groups/`,
    { name: '交付阶段', sort_order: 1 }
  )

  const root = await postJson<CreatedTask>(page, apiOrigin, 'tasks/', {
    title: '产品发布准备',
    description: '确认范围、设计、开发与发布安排。',
    priority: 'high',
    start_date: '2030-08-26',
    due_date: '2030-09-01',
    task_list_id: taskList.id,
    group_id: discovery.id,
  })
  const research = await postJson<CreatedTask>(page, apiOrigin, 'tasks/', {
    title: '竞品调研',
    priority: 'medium',
    due_date: '2030-08-29',
    task_list_id: taskList.id,
    group_id: discovery.id,
    parent_id: root.id,
  })
  const prototype = await postJson<CreatedTask>(page, apiOrigin, 'tasks/', {
    title: '交互原型确认',
    priority: 'low',
    due_date: '2030-08-30',
    task_list_id: taskList.id,
    group_id: discovery.id,
    parent_id: root.id,
  })
  const implementation = await postJson<CreatedTask>(
    page,
    apiOrigin,
    'tasks/',
    {
      title: '移动端适配',
      priority: 'high',
      due_date: '2030-09-01',
      task_list_id: taskList.id,
      group_id: delivery.id,
    }
  )

  const completeResponse = await page.request.patch(
    `${apiOrigin}/api/v1.0/tasks/${prototype.id}/`,
    {
      data: { status: 'completed' },
      headers: await requestHeaders(page.context(), apiOrigin),
    }
  )
  await expectApiSuccess(completeResponse, `complete task ${prototype.id}`)

  return {
    apiOrigin,
    taskList,
    root,
    research,
    prototype,
    implementation,
    discovery,
    delivery,
    createdAtCells: page.locator(
      'tr[aria-label^="打开任务"] > td:nth-child(7)'
    ),
  }
}

export const deleteTaskVisualFixture = async (
  context: BrowserContext,
  fixture: TaskVisualFixture | undefined
) => {
  if (!fixture) return
  const request = context.request
  const headers = await requestHeaders(context, fixture.apiOrigin)
  const taskIds = [
    fixture.implementation.id,
    fixture.prototype.id,
    fixture.research.id,
    fixture.root.id,
  ]
  for (const taskId of taskIds) {
    const taskUrl = `${fixture.apiOrigin}/api/v1.0/tasks/${encodeURIComponent(taskId)}/`
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

  const listResponse = await request.delete(
    `${fixture.apiOrigin}/api/v1.0/task-lists/${encodeURIComponent(fixture.taskList.id)}/?delete_unassigned=true`,
    { headers }
  )
  if (listResponse.status() !== 204 && listResponse.status() !== 404) {
    throw new Error(
      `Task-list cleanup failed with HTTP ${listResponse.status()}`
    )
  }
}

export const taskVisualListUrl = (fixture: TaskVisualFixture) =>
  `/tasks?scope=all&status=all&time=all&priority=all&task_list=${fixture.taskList.id}&view=list`

export const settleTaskVisuals = async (page: Page) => {
  await page.evaluate(async () => {
    await document.fonts.ready
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
}
