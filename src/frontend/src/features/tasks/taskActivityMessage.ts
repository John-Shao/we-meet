import type { TFunction } from 'i18next'

import type { ApiTaskActivity } from './api/ApiTask'
import { taskDisplayName } from './taskUi'

export const taskActivityMessage = (
  activity: ApiTaskActivity,
  t: TFunction<'tasks'>
) => {
  const actor = taskDisplayName(activity.actor)
  if (activity.event === 'status_changed') {
    const status = activity.changes.status?.to
    const event = activity.changes.source_action_item_origin
      ? 'history.events.status_changed_from_action_item'
      : 'history.events.status_changed'
    const base = t(event, {
      actor,
      status: status ? t(`statuses.${status}`) : '—',
    })
    const sync = activity.changes.source_action_item_sync
    if (!sync) return base
    const sourceStatus = t(`actionItemStatuses.${sync.to}`)
    if (sync.result === 'updated')
      return t('history.events.status_changed_synced', { base, sourceStatus })
    if (sync.result === 'already_aligned')
      return t('history.events.status_changed_aligned', { base, sourceStatus })
    return t('history.events.status_changed_conflict', { base, sourceStatus })
  }
  if (activity.event === 'priority_changed') {
    const priority = activity.changes.priority
    return t('history.events.priority_changed', {
      actor,
      from: priority ? t(`priorities.${priority.from}`) : '—',
      to: priority ? t(`priorities.${priority.to}`) : '—',
    })
  }
  if (activity.event === 'placement_changed') {
    const placement = activity.changes.placement
    const from = placement?.from.task_list
      ? `${placement.from.task_list.name}${placement.from.group ? ` / ${placement.from.group.name}` : ''}`
      : t('taskLists.standalone')
    const to = placement?.to.task_list
      ? `${placement.to.task_list.name}${placement.to.group ? ` / ${placement.to.group.name}` : ''}`
      : t('taskLists.standalone')
    return t('history.events.placement_changed', { actor, from, to })
  }
  if (activity.event === 'hierarchy_changed') {
    const parent = activity.changes.parent
    return t('history.events.hierarchy_changed', {
      actor,
      from: parent?.from?.title || t('subtasks.noParent'),
      to: parent?.to?.title || t('subtasks.noParent'),
    })
  }
  if (activity.event === 'assignee_changed') {
    const assignees = activity.changes.assignees
    const assigneeNames =
      assignees == null
        ? null
        : Array.isArray(assignees)
          ? assignees.map((item) => item.name)
          : assignees.to.map((item) => item.name)
    const assignee = activity.changes.assignee
    const assigneeName =
      assignee == null
        ? null
        : 'to' in assignee
          ? assignee.to?.name ?? null
          : assignee.name
    return t('history.events.assignee_changed', {
      actor,
      assignee: assigneeNames?.join('、') || assigneeName || '—',
    })
  }
  if (activity.event === 'attachment_removed') {
    return t('history.events.attachment_removed', {
      actor,
      filename: activity.changes.attachment?.filename || '—',
    })
  }
  if (activity.event === 'source_action_item_changed') {
    const source = activity.changes.source_action_item
    const status = source?.status.to
    const event = source?.overrode_task_sync
      ? 'history.events.source_action_item_overrode'
      : 'history.events.source_action_item_changed'
    const base = t(event, {
      actor,
      status: status ? t(`actionItemStatuses.${status}`) : '—',
    })
    const sync = activity.changes.linked_task_sync
    if (!sync) return base
    const taskStatus = t(`statuses.${sync.to}`)
    if (sync.result === 'updated')
      return t('history.events.source_action_item_synced_task', {
        base,
        taskStatus,
      })
    if (sync.result === 'already_aligned')
      return t('history.events.source_action_item_task_aligned', {
        base,
        taskStatus,
      })
    return t('history.events.source_action_item_task_conflict', {
      base,
      taskStatus,
    })
  }
  return t(`history.events.${activity.event}`, { actor })
}
