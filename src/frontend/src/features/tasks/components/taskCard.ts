import type { TFunction } from 'i18next'

import type { ApiTask } from '../api/ApiTask'
import { taskAssignees } from '../taskUi'

const taskUrl = (taskId: string, cid?: string) => {
  const url = new URL('/tasks', window.location.origin)
  url.searchParams.set('task', taskId)
  if (cid) url.searchParams.set('shared_via', cid)
  return url.toString()
}

export const buildTaskLink = (taskId: string) => taskUrl(taskId)

export const buildTaskCardBody = (
  task: ApiTask,
  cid: string,
  t: TFunction<'tasks'>,
  locale: string
) => {
  const detailUrl = taskUrl(task.id, cid)
  const assignees = taskAssignees(task)
  const assignee =
    assignees
      .map(
        (user) =>
          user.full_name || user.short_name || user.email || t('meta.none')
      )
      .join('、') || t('meta.none')
  const dueDate = task.due_date
    ? new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(new Date(`${task.due_date}T00:00:00`))
    : t('meta.none')

  return JSON.stringify({
    plain: `${t('share.cardTitle')} ${task.title}`,
    v: 1,
    header: { title: t('share.cardTitle'), theme: 'info' },
    blocks: [
      {
        type: 'text',
        spans: [{ tag: 'text', text: task.title, b: true }],
      },
      {
        type: 'fields',
        items: [
          {
            label: t('meta.assignee'),
            value: assignee,
            avatar_url: assignees[0]?.avatar_url || undefined,
          },
          { label: t('meta.dueDate'), value: dueDate },
        ],
      },
      { type: 'divider' },
      {
        type: 'actions',
        resolve: 'each',
        buttons: [
          {
            id: `follow-task:${task.id}:${cid}`,
            text: t('followers.cardFollow'),
            style: 'default',
            action: 'url',
            url: detailUrl,
          },
          {
            id: `view-task:${task.id}`,
            text: t('share.viewDetails'),
            style: 'primary',
            action: 'url',
            url: detailUrl,
          },
        ],
      },
    ],
  })
}
