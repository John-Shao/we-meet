import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  TaskAttachmentsSection,
  TaskCommentsSection,
  TaskHistorySection,
} from './TaskCollaborationSections'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@/components/ConfirmProvider', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}))

vi.mock('../api/fetchTasks', () => ({
  useTaskComments: () => ({ data: undefined, isLoading: true, error: null }),
  useTaskAttachments: () => ({
    data: undefined,
    isLoading: true,
    error: null,
  }),
  useTaskActivities: () => ({ data: undefined, isLoading: true, error: null }),
  useCreateTaskComment: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
  }),
  useCreateTaskAttachment: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
  }),
  useDeleteTaskAttachment: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
  }),
}))

describe('task collaboration loading states', () => {
  it('uses stable skeletons for comments, attachments, and history', () => {
    render(
      <>
        <TaskCommentsSection taskId="task-1" readOnly />
        <TaskAttachmentsSection taskId="task-1" readOnly />
        <TaskHistorySection taskId="task-1" />
      </>
    )

    for (const label of [
      'comments.loading',
      'attachments.loading',
      'history.loading',
    ]) {
      expect(screen.getByRole('status', { name: label })).toHaveAttribute(
        'aria-busy',
        'true'
      )
    }
  })
})
