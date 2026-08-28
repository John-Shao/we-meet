import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiTask } from '../api/ApiTask'
import { TaskDetailPanel } from './TaskSidePanel'

const {
  confirm,
  createMutateAsync,
  deleteMutateAsync,
  followMutate,
  mutate,
  mutateAsync,
  notifyAction,
  notifyFailure,
  reorderMutate,
  subtaskLoadingState,
  subtaskState,
  taskQueryState,
} = vi.hoisted(() => ({
  confirm: vi.fn().mockResolvedValue(true),
  createMutateAsync: vi.fn().mockResolvedValue(undefined),
  deleteMutateAsync: vi.fn().mockResolvedValue(undefined),
  followMutate: vi.fn(),
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue(undefined),
  notifyAction: vi.fn(),
  notifyFailure: vi.fn(),
  reorderMutate: vi.fn(),
  subtaskLoadingState: { current: false },
  subtaskState: { current: [] as ApiTask[] },
  taskQueryState: {
    current: {
      data: undefined as ApiTask | undefined,
      isLoading: false,
      error: null,
    },
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('../api/fetchTasks', () => ({
  useTask: () => taskQueryState.current,
  useTaskSubtasks: () => ({
    data: subtaskState.current,
    isLoading: subtaskLoadingState.current,
    error: null,
  }),
  useTaskParentCandidates: () => ({ data: [] }),
  useTaskSubtreeImpact: () => ({
    data: {
      task_id: 'task-1',
      node_count: 1,
      descendant_count: 0,
      maximum_depth: 0,
    },
  }),
  useCreateTask: () => ({
    mutateAsync: createMutateAsync,
    isPending: false,
    error: null,
  }),
  useDeleteTask: () => ({
    mutateAsync: deleteMutateAsync,
    isPending: false,
    error: null,
  }),
  usePatchTask: () => ({
    mutate,
    mutateAsync,
    isPending: false,
    isSuccess: false,
    error: null,
  }),
  useReorderTaskSubtasks: () => ({
    mutate: reorderMutate,
    isPending: false,
    error: null,
  }),
  useFollowTask: () => ({
    mutate: followMutate,
    isPending: false,
    error: null,
  }),
  useUnfollowTask: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useAddTaskFollowers: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
  useRemoveTaskFollower: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
  useUpdateTaskRecurrence: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
  useStopTaskRecurrence: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}))

vi.mock('@/components/ConfirmProvider', () => ({
  useConfirm: () => ({ confirm }),
}))

vi.mock('./TaskActionFeedbackContext', () => ({
  useTaskActionFeedback: () => ({ notifyAction, notifyFailure }),
}))

vi.mock('./TaskCollaborationSections', () => ({
  TaskAttachmentsSection: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="attachments" data-read-only={String(Boolean(readOnly))} />
  ),
  TaskCommentsSection: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="comments" data-read-only={String(Boolean(readOnly))} />
  ),
  TaskHistorySection: () => null,
}))

vi.mock('./TaskAssigneePickerDialog', () => ({
  TaskAssigneePickerDialog: ({
    initial,
    onConfirm,
  }: {
    initial: ApiTask['followers']
    onConfirm: (assignees: ApiTask['followers']) => void
  }) => (
    <div role="dialog" aria-label="assignees.select">
      <button
        type="button"
        onClick={() =>
          onConfirm([
            ...initial,
            {
              id: 'assignee-2',
              full_name: 'Second assignee',
              short_name: null,
              avatar_url: '/assignee-2.png',
            },
          ])
        }
      >
        assignees.confirmTest
      </button>
    </div>
  ),
}))

const task: ApiTask = {
  id: 'task-1',
  title: 'Prepare release',
  description: 'Run the release checks',
  creator: {
    id: 'creator',
    full_name: 'Creator',
    short_name: null,
    avatar_url: '/creator.png',
  },
  assignee: {
    id: 'assignee',
    full_name: 'Assignee',
    short_name: null,
    avatar_url: '/assignee.png',
  },
  followers: [],
  status: 'todo',
  priority: 'high',
  task_list: null,
  group: null,
  parent_id: null,
  depth: 0,
  ancestor_path: [{ id: 'task-1', title: 'Prepare release', depth: 0 }],
  descendant_progress: { completed: 0, total: 0 },
  can_create_subtasks: false,
  position: 0,
  start_date: '2026-08-21',
  due_date: '2026-08-31',
  completed_at: null,
  source_action_item_id: null,
  source_room_id: null,
  source_room_name: null,
  can_edit: false,
  can_update_status: false,
  can_delete: false,
  can_comment: false,
  can_manage_attachments: false,
  can_manage_followers: false,
  is_following: false,
  time_state: null,
  created_at: '2026-08-21T08:00:00Z',
  updated_at: '2026-08-21T09:00:00Z',
}

describe('TaskDetailPanel', () => {
  beforeEach(() => {
    mutate.mockClear()
    mutateAsync.mockClear()
    notifyAction.mockClear()
    notifyFailure.mockClear()
    reorderMutate.mockClear()
    createMutateAsync.mockClear()
    deleteMutateAsync.mockClear()
    followMutate.mockClear()
    confirm.mockClear()
    confirm.mockResolvedValue(true)
    subtaskState.current = []
    subtaskLoadingState.current = false
    taskQueryState.current = {
      data: undefined,
      isLoading: false,
      error: null,
    }
  })

  it('reserves the detail layout while the task is loading', () => {
    taskQueryState.current = {
      data: undefined,
      isLoading: true,
      error: null,
    }

    render(
      <TaskDetailPanel
        taskId={task.id}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByRole('status', { name: 'loading' })).toHaveAttribute(
      'aria-busy',
      'true'
    )
  })

  it('reserves subtask rows while subtasks are loading', () => {
    subtaskLoadingState.current = true

    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={task}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(
      screen.getByRole('status', { name: 'subtasks.loading' })
    ).toHaveAttribute('aria-busy', 'true')
  })

  it('renders start and due dates as separate properties', () => {
    const { container } = render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={task}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    const startDateLabel = screen.getByText('meta.startDate', {
      selector: 'dt',
    })
    const dueDateLabel = screen.getByText('meta.dueDate', { selector: 'dt' })

    expect(startDateLabel.parentElement).toHaveTextContent('Aug 21')
    expect(startDateLabel.parentElement).not.toHaveTextContent('2026')
    expect(dueDateLabel.parentElement).toHaveTextContent('Aug 31')
    expect(dueDateLabel.parentElement).not.toHaveTextContent('2026')
    expect(
      screen.queryByText('meta.startDate / meta.dueDate')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^actions\.edit / })
    ).not.toBeInTheDocument()
    expect(
      within(
        screen.getByLabelText('workspace.details').querySelector('header')!
      ).getByText('statuses.todo')
    ).toBeInTheDocument()
    expect(container.querySelector('img[src="/assignee.png"]')).toBeTruthy()
    expect(container.querySelector('img[src="/creator.png"]')).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: 'detailGroups.collaboration' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'detailGroups.planning' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'detailGroups.content' })
    ).toBeInTheDocument()
  })

  it('edits each creator-managed field inline without a global edit page', async () => {
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{ ...task, can_edit: true }}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(
      screen.queryByRole('button', { name: 'actions.edit' })
    ).not.toBeInTheDocument()
    const editableFields = [
      'form.title',
      'meta.startDate',
      'meta.dueDate',
      'form.priority',
      'form.description',
      'taskLists.field',
    ]
    editableFields.forEach((field) => {
      expect(
        screen.getByRole('button', { name: `actions.edit ${field}` })
      ).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('button', { name: 'actions.edit meta.creator' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'actions.edit meta.assignee' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'assignees.add' })
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'actions.edit form.title' })
    )
    const titleInput = screen.getByRole('textbox', { name: 'form.title' })
    fireEvent.change(titleInput, {
      target: { value: 'Ship release' },
    })
    expect(
      screen.queryByRole('button', { name: 'actions.save' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'form.cancel' })
    ).not.toBeInTheDocument()
    fireEvent.blur(titleInput)

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: task.id,
        patch: { title: 'Ship release' },
      })
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'actions.edit meta.startDate',
      })
    )
    const startDateInput = screen.getByLabelText('meta.startDate')
    fireEvent.change(startDateInput, {
      target: { value: '2026-08-22' },
    })
    expect(mutateAsync).toHaveBeenCalledTimes(1)
    fireEvent.blur(startDateInput)

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: task.id,
        patch: { start_date: '2026-08-22' },
      })
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'actions.edit taskLists.field',
      })
    )
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
  })

  it('shows assignees as removable member chips like followers', async () => {
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{
          ...task,
          can_edit: true,
          assignees: [
            task.assignee!,
            {
              id: 'assignee-2',
              full_name: 'Second assignee',
              short_name: null,
              avatar_url: '/assignee-2.png',
            },
          ],
        }}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(
      screen.getAllByRole('button', { name: 'assignees.remove' })[1]
    )

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: task.id,
        patch: { assignee_ids: ['assignee'] },
      })
    )
    expect(notifyAction).toHaveBeenCalledWith({
      taskId: task.id,
      title: task.title,
      kind: 'assigneesUpdated',
      undoPatch: { assignee_ids: ['assignee', 'assignee-2'] },
    })
  })

  it('sends an explicit scope when editing a recurring task', async () => {
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{
          ...task,
          can_edit: true,
          recurrence: {
            rule_id: 'rule-1',
            frequency: 'weekly',
            interval: 1,
            timezone: 'Asia/Shanghai',
            end_date: null,
            max_occurrences: null,
            generated_count: 1,
            next_occurrence_date: '2026-09-07',
            is_active: true,
            last_error: '',
            sequence: 1,
            can_manage: true,
          },
        }}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByLabelText('recurrence.editScope')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'actions.edit form.title' })
    )
    const input = screen.getByRole('textbox', { name: 'form.title' })
    fireEvent.change(input, { target: { value: 'Recurring release' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: task.id,
        patch: {
          title: 'Recurring release',
          recurrence_scope: 'one',
        },
      })
    )
  })

  it('uses dedicated collaboration capabilities for comments and attachments', () => {
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{
          ...task,
          can_update_status: true,
          can_comment: true,
          can_manage_attachments: false,
        }}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('comments')).toHaveAttribute(
      'data-read-only',
      'false'
    )
    expect(screen.getByTestId('attachments')).toHaveAttribute(
      'data-read-only',
      'true'
    )
    const contentGroup = screen
      .getByRole('heading', { name: 'detailGroups.content' })
      .closest('dl')
    expect(contentGroup).toContainElement(screen.getByTestId('attachments'))
    expect(screen.getByTestId('attachments').closest('details')).toBeNull()
  })

  it('places the status action first and secondary actions in the panel header', async () => {
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{
          ...task,
          can_update_status: true,
          can_delete: true,
        }}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    const panel = screen.getByLabelText('workspace.details')
    const header = panel.querySelector('header')!
    expect(
      within(header)
        .getAllByRole('button')
        .map(
          (button) => button.getAttribute('aria-label') || button.textContent
        )
    ).toEqual([
      'actions.to_completed',
      'share.action',
      'followers.follow',
      'actions.more',
      'workspace.closePanel',
    ])
    expect(within(header).getByText('statuses.todo')).toBeInTheDocument()
    expect(screen.queryByText('followers.empty')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: 'actions.delete' })
    ).not.toBeInTheDocument()

    fireEvent.click(
      within(header).getByRole('button', { name: 'actions.to_completed' })
    )
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: task.id,
        patch: { status: 'completed' },
      })
    )
    expect(notifyAction).toHaveBeenCalledWith({
      taskId: task.id,
      title: task.title,
      kind: 'completed',
      undoPatch: { status: 'todo' },
    })

    fireEvent.click(
      within(header).getByRole('button', { name: 'followers.follow' })
    )
    expect(followMutate).toHaveBeenCalledWith(task.id)

    fireEvent.click(
      within(header).getByRole('button', { name: 'actions.more' })
    )
    expect(
      screen.getByRole('menuitem', { name: 'actions.delete' })
    ).toBeInTheDocument()
  })

  it('warns before completing a parent with unfinished descendants', async () => {
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{
          ...task,
          can_update_status: true,
          descendant_progress: { completed: 1, total: 3 },
        }}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'actions.to_completed' })
    )

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith({
        title: 'actions.completeWithOpenSubtasksTitle',
        message: 'actions.completeWithOpenSubtasksDescription',
        confirmLabel: 'actions.completeAnyway',
      })
    )
    expect(mutateAsync).toHaveBeenCalledWith({
      taskId: task.id,
      patch: { status: 'completed' },
    })
  })

  it('shows unfinished descendants on an already completed parent', () => {
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{
          ...task,
          status: 'completed',
          descendant_progress: { completed: 1, total: 3 },
        }}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(
      screen.getByText('subtasks.completedWithOpenSubtasks')
    ).toBeInTheDocument()
  })

  it('supports every compact subtask action without opening details from the title', async () => {
    const onCreateSubtask = vi.fn()
    const onOpenSubtask = vi.fn()
    const child: ApiTask = {
      ...task,
      id: 'child-1',
      title: 'Backend',
      parent_id: task.id,
      depth: 1,
      ancestor_path: [
        { id: task.id, title: task.title, depth: 0 },
        { id: 'child-1', title: 'Backend', depth: 1 },
      ],
      can_edit: true,
      can_update_status: true,
    }
    subtaskState.current = [child]
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{
          ...task,
          can_create_subtasks: true,
          descendant_progress: { completed: 0, total: 1 },
        }}
        taskLists={[]}
        onCreateSubtask={onCreateSubtask}
        onOpenSubtask={onOpenSubtask}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('subtasks.progressSummary')).toBeInTheDocument()
    const childRow = screen.getByText(child.title).closest('li')!
    expect(within(childRow).queryByRole('link')).not.toBeInTheDocument()
    expect(
      within(childRow).queryByText(task.assignee!.full_name!)
    ).not.toBeInTheDocument()
    expect(childRow.querySelector('img[src="/assignee.png"]')).toBeTruthy()

    fireEvent.click(
      within(childRow).getByRole('button', { name: 'workspace.quickComplete' })
    )
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: child.id,
        patch: { status: 'completed' },
      })
    )

    fireEvent.click(
      within(childRow).getByRole('button', {
        name: 'actions.edit form.title',
      })
    )
    const titleInput = within(childRow).getByRole('textbox', {
      name: 'form.title',
    })
    fireEvent.change(titleInput, { target: { value: 'Backend API' } })
    fireEvent.blur(titleInput)
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: child.id,
        patch: { title: 'Backend API' },
      })
    )

    fireEvent.click(
      await within(childRow).findByRole('button', {
        name: 'actions.edit meta.dueDate',
      })
    )
    const dueDateInput = within(childRow).getByLabelText('meta.dueDate')
    fireEvent.change(dueDateInput, { target: { value: '2026-09-01' } })
    fireEvent.blur(dueDateInput)
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: child.id,
        patch: { due_date: '2026-09-01' },
      })
    )

    fireEvent.click(
      await within(childRow).findByRole('button', {
        name: 'actions.edit meta.assignee',
      })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'assignees.confirmTest' })
    )
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: child.id,
        patch: { assignee_ids: ['assignee', 'assignee-2'] },
      })
    )

    fireEvent.click(
      within(childRow).getByRole('button', { name: 'workspace.openTask' })
    )
    expect(onOpenSubtask).toHaveBeenCalledWith(child)

    fireEvent.click(screen.getByRole('button', { name: 'subtasks.addAction' }))
    expect(onCreateSubtask).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id })
    )
  })

  it('reorders direct subtasks from the detail panel', () => {
    const first = {
      ...task,
      id: 'child-1',
      title: 'First',
      parent_id: task.id,
      depth: 1,
      can_edit: true,
    }
    const second = {
      ...first,
      id: 'child-2',
      title: 'Second',
    }
    subtaskState.current = [first, second]
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{ ...task, can_edit: true }}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    const firstRow = screen.getByText('First').closest('li')!
    fireEvent.click(
      within(firstRow).getByRole('button', { name: 'subtasks.moveDown' })
    )

    expect(reorderMutate).toHaveBeenCalledWith({
      taskId: task.id,
      taskIds: ['child-2', 'child-1'],
    })

    reorderMutate.mockClear()
    const secondRow = screen.getByText('Second').closest('li')!
    const dragHandle = within(firstRow).getByRole('button', {
      name: 'subtasks.dragToReorder',
    })
    let draggedId = ''
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: (_type: string, value: string) => {
        draggedId = value
      },
      getData: () => draggedId,
    }

    expect(firstRow).not.toHaveAttribute('draggable')
    expect(dragHandle).toHaveAttribute('draggable', 'true')
    fireEvent.dragStart(dragHandle, { dataTransfer })
    fireEvent.dragOver(secondRow, { dataTransfer })
    expect(secondRow).toHaveAttribute('data-drag-over', 'true')
    fireEvent.drop(secondRow, { dataTransfer })

    expect(reorderMutate).toHaveBeenCalledWith({
      taskId: task.id,
      taskIds: ['child-2', 'child-1'],
    })
  })

  it('opens a subtask in the full task detail with ancestors above its title', () => {
    render(
      <TaskDetailPanel
        taskId="child-1"
        fallbackTask={{
          ...task,
          id: 'child-1',
          title: 'Backend',
          parent_id: task.id,
          depth: 1,
          ancestor_path: [
            { id: task.id, title: task.title, depth: 0 },
            { id: 'child-1', title: 'Backend', depth: 1 },
          ],
        }}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={vi.fn()}
      />
    )

    const parentChain = screen.getByRole('navigation', {
      name: 'subtasks.parentChain',
    })
    expect(within(parentChain).getByText(task.title)).toBeInTheDocument()
    expect(within(parentChain).queryByText('Backend')).not.toBeInTheDocument()
    expect(screen.getByText('meta.startDate', { selector: 'dt' })).toBeVisible()
    expect(screen.getByTestId('comments')).toBeInTheDocument()
    expect(screen.getByTestId('attachments')).toBeInTheDocument()
  })

  it('deletes an editable task after confirmation', async () => {
    const onClose = vi.fn()
    render(
      <TaskDetailPanel
        taskId={task.id}
        fallbackTask={{ ...task, can_delete: true }}
        taskLists={[]}
        onCreateSubtask={vi.fn()}
        onOpenSubtask={vi.fn()}
        onClose={onClose}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'actions.more' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'actions.delete' }))

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(deleteMutateAsync).toHaveBeenCalledWith({
        taskId: task.id,
        confirmSubtreeNodeCount: 1,
      })
    )
    expect(onClose).toHaveBeenCalledOnce()
  })
})
