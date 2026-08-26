import { describe, expect, it } from 'vitest'

import type { ApiTask } from '../api/ApiTask'
import { parseRichCard } from '@/features/im/components/richCard'
import { buildTaskCardBody, buildTaskLink } from './taskCard'

const task = {
  id: '5443ab57-82fb-4b42-b5be-3b6046cf955a',
  title: 'Review launch checklist',
  assignee: { full_name: 'Ada Lovelace', avatar_url: '/ada.png' },
  due_date: '2026-08-31',
} as ApiTask

describe('buildTaskCardBody', () => {
  it('keeps copied links permission-neutral', () => {
    const link = new URL(buildTaskLink(task.id))

    expect(link.searchParams.get('task')).toBe(task.id)
    expect(link.searchParams.has('shared_via')).toBe(false)
  })

  it('builds a task snapshot with conversation-scoped actions', () => {
    const cid = '3ddb775e-3e26-43e2-b69f-b0db4f89f750'
    const t = ((key: string) =>
      ({
        'share.cardTitle': 'Shared task',
        'share.viewDetails': 'View details',
        'followers.cardFollow': 'Follow',
        'meta.assignee': 'Assignee',
        'meta.dueDate': 'Due date',
        'meta.none': 'None',
      })[key] || key) as never

    const card = parseRichCard(buildTaskCardBody(task, cid, t, 'en-US'))!

    expect(card.header?.title).toBe('Shared task')
    expect(card.blocks.map((block) => block.type)).toEqual([
      'text',
      'fields',
      'divider',
      'actions',
    ])
    const fields = card.blocks[1]
    if (fields.type !== 'fields') throw new Error('expected fields')
    expect(fields.items[0]).toMatchObject({
      value: 'Ada Lovelace',
      avatar_url: '/ada.png',
    })
    const actions = card.blocks[3]
    if (actions.type !== 'actions') throw new Error('expected actions')
    expect(actions.buttons[0].id).toBe(`follow-task:${task.id}:${cid}`)
    expect(actions.buttons[1].url).toContain(`shared_via=${cid}`)
  })
})
