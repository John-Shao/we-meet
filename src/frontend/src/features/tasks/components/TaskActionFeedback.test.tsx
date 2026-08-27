import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskActionFeedbackProvider } from './TaskActionFeedback'
import { useTaskActionFeedback } from './TaskActionFeedbackContext'

const mutateAsync = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../api/fetchTasks', () => ({
  usePatchTask: () => ({ mutateAsync }),
}))

const FeedbackHarness = () => {
  const { notifyAction, notifyFailure } = useTaskActionFeedback()
  return (
    <>
      <button
        type="button"
        onClick={() =>
          notifyAction({
            taskId: 'task-1',
            title: 'Release',
            kind: 'completed',
            undoPatch: { status: 'todo' },
          })
        }
      >
        Complete
      </button>
      <button
        type="button"
        onClick={() => notifyFailure({ taskId: 'task-1', title: 'Release' })}
      >
        Fail
      </button>
    </>
  )
}

describe('TaskActionFeedbackProvider', () => {
  beforeEach(() => {
    mutateAsync.mockReset()
    mutateAsync.mockResolvedValue(undefined)
  })

  it('offers a real reverse patch and confirms the undo', async () => {
    render(
      <TaskActionFeedbackProvider>
        <FeedbackHarness />
      </TaskActionFeedbackProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Complete' }))
    expect(screen.getByText('feedback.completed')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'feedback.undo' }))
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: 'task-1',
        patch: { status: 'todo' },
      })
    )
    expect(await screen.findByText('feedback.undone')).toBeInTheDocument()
  })

  it('replaces a success toast with a failure for the same task', () => {
    render(
      <TaskActionFeedbackProvider>
        <FeedbackHarness />
      </TaskActionFeedbackProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Complete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fail' }))

    expect(screen.queryByText('feedback.completed')).not.toBeInTheDocument()
    expect(screen.getByText('feedback.updateFailed')).toBeInTheDocument()
  })

  it('reports a failed reverse patch', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('network'))
    render(
      <TaskActionFeedbackProvider>
        <FeedbackHarness />
      </TaskActionFeedbackProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Complete' }))
    fireEvent.click(screen.getByRole('button', { name: 'feedback.undo' }))

    expect(await screen.findByText('feedback.undoFailed')).toBeInTheDocument()
  })
})
