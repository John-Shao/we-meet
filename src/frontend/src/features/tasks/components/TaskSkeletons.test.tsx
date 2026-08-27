import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  TaskAttachmentListSkeleton,
  TaskBoardSkeleton,
  TaskCommentListSkeleton,
  TaskDetailSkeleton,
  TaskHistoryListSkeleton,
  TaskListSkeleton,
  TaskSubtaskListSkeleton,
} from './TaskSkeletons'

describe('task skeletons', () => {
  it.each([
    ['task list', <TaskListSkeleton label="task list" />],
    [
      'compact task list',
      <TaskListSkeleton label="compact task list" compact />,
    ],
    [
      'grouped task list',
      <TaskListSkeleton label="grouped task list" grouped />,
    ],
    ['task board', <TaskBoardSkeleton label="task board" />],
    ['task detail', <TaskDetailSkeleton label="task detail" />],
    ['subtasks', <TaskSubtaskListSkeleton label="subtasks" />],
    ['comments', <TaskCommentListSkeleton label="comments" />],
    ['attachments', <TaskAttachmentListSkeleton label="attachments" />],
    ['history', <TaskHistoryListSkeleton label="history" />],
  ])('announces the %s loading region', (label, skeleton) => {
    render(skeleton)

    expect(screen.getByRole('status', { name: label })).toHaveAttribute(
      'aria-busy',
      'true'
    )
  })
})
