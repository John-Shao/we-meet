import { describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'

import type { ApiTaskActivity, ApiTaskUser } from './api/ApiTask'
import { taskActivityMessage } from './taskActivityMessage'

const actor: ApiTaskUser = {
  id: 'u1',
  full_name: 'Alice',
  short_name: null,
  email: 'alice@example.com',
  avatar_url: '',
}

const baseActivity = (
  overrides: Partial<ApiTaskActivity> = {}
): ApiTaskActivity => ({
  id: 'act-1',
  task_id: 'task-1',
  task_title: 'A task',
  actor,
  event: 'status_changed',
  changes: {},
  created_at: '2026-08-21T08:00:00Z',
  ...overrides,
})

// Returns the translation key (ignoring interpolation), so assertions target
// which branch/message is chosen rather than the i18n runtime.
const keyOnlyT = ((key: string) => key) as unknown as TFunction<'tasks'>

const statusSyncChanges = (
  result: 'updated' | 'already_aligned' | 'skipped_manual_override' | 'skipped_conflict'
): ApiTaskActivity['changes'] => ({
  status: { from: 'todo', to: 'completed' },
  source_action_item_sync: {
    action_item_id: 'ai-1',
    result,
    from: 'proposed',
    to: 'completed',
  },
})

const linkedTaskSyncChanges = (
  result: 'updated' | 'already_aligned' | 'skipped_conflict'
): ApiTaskActivity['changes'] => ({
  source_action_item: {
    id: 'ai-1',
    status: { from: 'proposed', to: 'completed' },
    overrode_task_sync: false,
  },
  linked_task_sync: {
    task_id: 'task-2',
    result,
    from: 'todo',
    to: 'completed',
  },
})

describe('taskActivityMessage', () => {
  it('renders a plain status change', () => {
    expect(
      taskActivityMessage(
        baseActivity({ changes: { status: { from: 'todo', to: 'completed' } } }),
        keyOnlyT
      )
    ).toBe('history.events.status_changed')
  })

  it('distinguishes action-item-originated status changes', () => {
    expect(
      taskActivityMessage(
        baseActivity({
          changes: {
            status: { from: 'todo', to: 'completed' },
            source_action_item_origin: {
              action_item_id: 'ai-1',
              activity_id: 'a-1',
            },
          },
        }),
        keyOnlyT
      )
    ).toBe('history.events.status_changed_from_action_item')
  })

  it('renders each status sync result', () => {
    expect(
      taskActivityMessage(baseActivity({ changes: statusSyncChanges('updated') }), keyOnlyT)
    ).toBe('history.events.status_changed_synced')
    expect(
      taskActivityMessage(
        baseActivity({ changes: statusSyncChanges('already_aligned') }),
        keyOnlyT
      )
    ).toBe('history.events.status_changed_aligned')
    expect(
      taskActivityMessage(
        baseActivity({ changes: statusSyncChanges('skipped_conflict') }),
        keyOnlyT
      )
    ).toBe('history.events.status_changed_conflict')
  })

  it('renders a priority change', () => {
    expect(
      taskActivityMessage(
        baseActivity({
          event: 'priority_changed',
          changes: { priority: { from: 'low', to: 'high' } },
        }),
        keyOnlyT
      )
    ).toBe('history.events.priority_changed')
  })

  it('renders a placement change', () => {
    expect(
      taskActivityMessage(
        baseActivity({
          event: 'placement_changed',
          changes: {
            placement: {
              from: {
                task_list: { id: 'l1', name: 'List A', color: 'blue' },
                group: null,
                position: 0,
              },
              to: {
                task_list: { id: 'l2', name: 'List B', color: 'blue' },
                group: { id: 'g1', name: 'Group 1' },
                position: 1,
              },
            },
          },
        }),
        keyOnlyT
      )
    ).toBe('history.events.placement_changed')
  })

  it('renders a hierarchy change', () => {
    expect(
      taskActivityMessage(
        baseActivity({
          event: 'hierarchy_changed',
          changes: {
            parent: { from: null, to: { id: 'p1', title: 'Parent' } },
          },
        }),
        keyOnlyT
      )
    ).toBe('history.events.hierarchy_changed')
  })

  it('renders a removed attachment', () => {
    expect(
      taskActivityMessage(
        baseActivity({
          event: 'attachment_removed',
          changes: { attachment: { id: 'f1', filename: 'spec.pdf' } },
        }),
        keyOnlyT
      )
    ).toBe('history.events.attachment_removed')
  })

  it('renders a source action item change and its sync results', () => {
    expect(
      taskActivityMessage(
        baseActivity({
          event: 'source_action_item_changed',
          changes: linkedTaskSyncChanges('updated'),
        }),
        keyOnlyT
      )
    ).toBe('history.events.source_action_item_synced_task')
    expect(
      taskActivityMessage(
        baseActivity({
          event: 'source_action_item_changed',
          changes: linkedTaskSyncChanges('already_aligned'),
        }),
        keyOnlyT
      )
    ).toBe('history.events.source_action_item_task_aligned')
    expect(
      taskActivityMessage(
        baseActivity({
          event: 'source_action_item_changed',
          changes: linkedTaskSyncChanges('skipped_conflict'),
        }),
        keyOnlyT
      )
    ).toBe('history.events.source_action_item_task_conflict')
  })

  it('renders an overrode source action item', () => {
    expect(
      taskActivityMessage(
        baseActivity({
          event: 'source_action_item_changed',
          changes: {
            source_action_item: {
              id: 'ai-1',
              status: { from: 'proposed', to: 'completed' },
              overrode_task_sync: true,
            },
          },
        }),
        keyOnlyT
      )
    ).toBe('history.events.source_action_item_overrode')
  })

  it('falls back to the event key for unhandled events', () => {
    expect(
      taskActivityMessage(baseActivity({ event: 'title_changed' }), keyOnlyT)
    ).toBe('history.events.title_changed')
  })
})

describe('taskActivityMessage assignee rendering', () => {
  const capturingT = (key: string, params?: Record<string, unknown>) =>
    params ? `${key}::${JSON.stringify(params)}` : key

  it('renders the diff form (from/to) for plural assignees', () => {
    const t = vi.fn(capturingT) as unknown as TFunction<'tasks'>

    taskActivityMessage(
      baseActivity({
        event: 'assignee_changed',
        changes: {
          assignees: {
            from: [{ id: 'u2', name: 'Bob' }],
            to: [{ id: 'u3', name: 'Carol' }],
          },
        },
      }),
      t
    )

    expect(t).toHaveBeenCalledWith(
      'history.events.assignee_changed',
      expect.objectContaining({ assignee: 'Carol' })
    )
  })

  it('renders the snapshot form for plural and single assignees', () => {
    const plural = vi.fn(capturingT) as unknown as TFunction<'tasks'>
    taskActivityMessage(
      baseActivity({
        event: 'assignee_changed',
        changes: {
          assignees: [
            { id: 'u2', name: 'Bob' },
            { id: 'u3', name: 'Carol' },
          ],
        },
      }),
      plural
    )
    expect(plural).toHaveBeenCalledWith(
      'history.events.assignee_changed',
      expect.objectContaining({ assignee: 'Bob、Carol' })
    )

    const single = vi.fn(capturingT) as unknown as TFunction<'tasks'>
    taskActivityMessage(
      baseActivity({
        event: 'assignee_changed',
        changes: { assignee: { id: 'u2', name: 'Bob' } },
      }),
      single
    )
    expect(single).toHaveBeenCalledWith(
      'history.events.assignee_changed',
      expect.objectContaining({ assignee: 'Bob' })
    )
  })
})
