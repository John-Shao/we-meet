import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@jusi/light-im-sdk'

import type { ApiTask } from '@/features/tasks/api/ApiTask'

import { MessageTaskDialog } from './MessageTaskDialog'

const { createTask } = vi.hoisted(() => ({ createTask: vi.fn() }))

vi.mock('@/features/auth', () => ({
  useUser: () => ({
    user: {
      id: 'user-1',
      full_name: 'Ari Chen',
      email: 'ari@example.test',
      avatar_url: '',
    },
  }),
}))

vi.mock('@/features/tasks/api/fetchTasks', () => ({
  useCreateTask: () => ({
    mutateAsync: createTask,
    isPending: false,
    error: null,
  }),
}))

vi.mock('@/features/tasks/components/TaskAssigneePickerDialog', () => ({
  TaskAssigneePickerDialog: () => null,
}))

const sourceMessage: Message = {
  mid: 42,
  cid: 'conversation-1',
  sender_uid: 'user-2',
  seq: 7,
  content_type: 'text',
  body: 'Review the API changes before Friday.',
  ts: 1788571200000,
}

describe('MessageTaskDialog', () => {
  beforeEach(() => createTask.mockReset())

  it('requires a user title while keeping the message as description and source', async () => {
    const saved = { id: 'task-1', title: 'Review launch risks' } as ApiTask
    createTask.mockResolvedValue(saved)
    const onCreated = vi.fn()
    const onClose = vi.fn()

    render(
      <MessageTaskDialog
        message={sourceMessage}
        onCreated={onCreated}
        onClose={onClose}
      />
    )

    const title = screen.getByLabelText('messageTask.taskTitle')
    const description = screen.getByLabelText('messageTask.description')
    expect(title).toHaveFocus()
    expect(description).toHaveValue('Review the API changes before Friday.')
    expect(
      screen.getByRole('button', { name: 'messageTask.create' })
    ).toBeDisabled()

    fireEvent.change(title, { target: { value: 'Review launch risks' } })
    fireEvent.change(description, {
      target: { value: 'Edited task context' },
    })
    fireEvent.change(screen.getByLabelText('messageTask.dueDate'), {
      target: { value: '2026-09-08' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'messageTask.create' }))

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith({
        title: 'Review launch risks',
        description: 'Edited task context',
        assignee_ids: ['user-1'],
        due_date: '2026-09-08',
        source_message: {
          cid: 'conversation-1',
          mid: '42',
          seq: 7,
          sender_uid: 'user-2',
          sent_at: 1788571200000,
          content_type: 'text',
          snapshot: 'Review the API changes before Friday.',
        },
      })
    )
    expect(onCreated).toHaveBeenCalledWith(saved)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
