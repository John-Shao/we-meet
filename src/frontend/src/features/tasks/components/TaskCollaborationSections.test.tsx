import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TaskAttachmentsSection,
  TaskCommentsSection,
  TaskHistorySection,
} from './TaskCollaborationSections'

const { attachmentState, commentState } = vi.hoisted(() => ({
  attachmentState: {
    current: {
      data: undefined as
        | Array<{
            id: string
            file_id: string
            title: string
            filename: string
            mimetype: string | null
            size: number | null
            url: string
            uploader: {
              id: string
              full_name: string
              short_name: null
              avatar_url: string
            } | null
            created_at: string
          }>
        | undefined,
      isLoading: true,
      error: null,
    },
  },
  commentState: {
    current: {
      data: undefined as
        | Array<{
            id: string
            author: {
              id: string
              full_name: string
              short_name: null
              avatar_url: string
            } | null
            content: string
            created_at: string
          }>
        | undefined,
      isLoading: true,
      error: null,
    },
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === 'attachments.meta' ? `${values?.size} · ${values?.date}` : key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@/components/ConfirmProvider', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}))

vi.mock('../api/fetchTasks', () => ({
  useTaskComments: () => commentState.current,
  useTaskAttachments: () => attachmentState.current,
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
  beforeEach(() => {
    attachmentState.current = {
      data: undefined,
      isLoading: true,
      error: null,
    }
    commentState.current = {
      data: undefined,
      isLoading: true,
      error: null,
    }
  })

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

  it('presents attachment actions as hover controls with a real download', () => {
    attachmentState.current = {
      data: [
        {
          id: 'attachment-1',
          file_id: 'file-1',
          title: 'Launch plan',
          filename: 'launch-plan.pdf',
          mimetype: 'application/pdf',
          size: 2048,
          url: '/media/launch-plan.pdf',
          uploader: {
            id: 'user-1',
            full_name: 'Alice',
            short_name: null,
            avatar_url: '/alice.png',
          },
          created_at: '2026-08-28T08:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
    }

    render(<TaskAttachmentsSection taskId="task-1" />)

    expect(
      screen.getByRole('button', { name: 'attachments.upload' })
    ).toHaveTextContent('actions.upload')
    expect(screen.getByText('launch-plan.pdf').tagName).toBe('SPAN')
    expect(
      screen
        .getByText('launch-plan.pdf')
        .closest('li')
        ?.querySelector('[data-file-kind="pdf"]')
    ).not.toBeNull()
    const attachmentRow = screen.getByText('launch-plan.pdf').closest('li')!
    expect(attachmentRow.querySelector('img')).toBeNull()
    expect(within(attachmentRow).getByText(/^2\.0 KB · /)).toBeVisible()
    expect(within(attachmentRow).queryByText('Alice')).not.toBeInTheDocument()
    const download = screen.getByRole('link', {
      name: 'attachments.download',
    })
    expect(download).toHaveAttribute('href', '/media/launch-plan.pdf')
    expect(download).toHaveAttribute('download', 'launch-plan.pdf')
    expect(download.closest('[data-attachment-actions]')).toContainElement(
      screen.getByRole('button', { name: 'attachments.remove' })
    )
  })

  it('selects file icons from MIME types and filename extensions', () => {
    attachmentState.current = {
      data: [
        {
          id: 'attachment-word',
          file_id: 'file-word',
          title: 'Brief',
          filename: 'brief.docx',
          mimetype: null,
          size: 1024,
          url: '/media/brief.docx',
          uploader: null,
          created_at: '2026-08-28T08:00:00Z',
        },
        {
          id: 'attachment-image',
          file_id: 'file-image',
          title: 'Preview',
          filename: 'preview.bin',
          mimetype: 'image/png',
          size: 1024,
          url: '/media/preview.png',
          uploader: null,
          created_at: '2026-08-28T08:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
    }

    const { container } = render(
      <TaskAttachmentsSection taskId="task-1" readOnly />
    )

    expect(container.querySelector('[data-file-kind="word"]')).not.toBeNull()
    expect(container.querySelector('[data-file-kind="image"]')).not.toBeNull()
  })

  it('renders comments as lightweight chat bubbles', () => {
    commentState.current = {
      data: [
        {
          id: 'comment-1',
          author: {
            id: 'user-1',
            full_name: 'Alice',
            short_name: null,
            avatar_url: '',
          },
          content: 'Looks good to me',
          created_at: '2026-08-28T08:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
    }

    render(<TaskCommentsSection taskId="task-1" readOnly />)

    const bubble = screen.getByText('Looks good to me')
    expect(bubble).toHaveAttribute('data-comment-bubble')
    expect(bubble.closest('li')?.querySelector('strong')).toBeNull()
  })

  it('uses a chat composer for new comments', () => {
    commentState.current = {
      data: [],
      isLoading: false,
      error: null,
    }

    render(<TaskCommentsSection taskId="task-1" />)

    expect(
      screen.getByRole('textbox', { name: 'comments.inputLabel' })
    ).toHaveAttribute('rows', '2')
    expect(
      screen
        .getByRole('button', { name: 'comments.submit' })
        .querySelector('svg')
    ).not.toBeNull()
  })
})
