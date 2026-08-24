import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'
import { createFile } from '@/features/files/api/createFile'
import { toApiPath } from '@/features/contacts/api/fetchDirectoryMembers'

import type {
  ApiTask,
  ApiTaskList,
  ApiTaskGroup,
  ApiTaskStatistics,
  ApiTaskActivity,
  ApiTaskAttachment,
  ApiTaskComment,
  CreateTaskPayload,
  PatchTaskPayload,
  TaskScope,
  TaskPriorityFilter,
  TaskOrdering,
  TaskStatusFilter,
  TaskTimeFilter,
} from './ApiTask'

export const buildTasksUrl = (
  scope: TaskScope,
  status: TaskStatusFilter,
  time: TaskTimeFilter,
  priority: TaskPriorityFilter,
  taskList: string,
  ordering: TaskOrdering = ''
) =>
  `tasks/?scope=${scope}&status=${status}&time=${time}&priority=${priority}&task_list=${encodeURIComponent(taskList)}${ordering ? `&ordering=${encodeURIComponent(ordering)}` : ''}&page_size=50`

const fetchTasks = (
  scope: TaskScope,
  status: TaskStatusFilter,
  time: TaskTimeFilter,
  priority: TaskPriorityFilter,
  taskList: string,
  ordering: TaskOrdering,
  pageUrl?: string
) =>
  fetchApi<Paginated<ApiTask>>(
    pageUrl
      ? toApiPath(pageUrl)
      : buildTasksUrl(scope, status, time, priority, taskList, ordering)
  )

export const getNextTasksPageParam = (lastPage: Paginated<ApiTask>) =>
  lastPage.next ?? undefined

export const useTasks = (
  scope: TaskScope,
  status: TaskStatusFilter,
  time: TaskTimeFilter,
  priority: TaskPriorityFilter,
  taskList: string,
  ordering: TaskOrdering = ''
) =>
  useInfiniteQuery<Paginated<ApiTask>, ApiError>({
    queryKey: ['tasks', scope, status, time, priority, taskList, ordering],
    queryFn: ({ pageParam }) =>
      fetchTasks(
        scope,
        status,
        time,
        priority,
        taskList,
        ordering,
        pageParam as string | undefined
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: getNextTasksPageParam,
  })

const fetchTask = (taskId: string) =>
  fetchApi<ApiTask>(`tasks/${encodeURIComponent(taskId)}/`)

export const useTask = (taskId?: string) =>
  useQuery<ApiTask, ApiError>({
    queryKey: ['tasks', 'detail', taskId],
    queryFn: () => fetchTask(taskId!),
    enabled: Boolean(taskId),
  })

const fetchTaskLists = () => fetchApi<ApiTaskList[]>('task-lists/')

export const useTaskLists = () =>
  useQuery<ApiTaskList[], ApiError>({
    queryKey: ['task-lists'],
    queryFn: fetchTaskLists,
  })

const createTaskList = (payload: {
  name: string
  description?: string
  color: ApiTaskList['color']
}) =>
  fetchApi<ApiTaskList>('task-lists/', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const useCreateTaskList = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskList,
    ApiError,
    { name: string; description?: string; color: ApiTaskList['color'] }
  >({
    mutationFn: createTaskList,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['task-lists'] }),
  })
}

const deleteTaskList = (taskListId: string) =>
  fetchApi<void>(`task-lists/${encodeURIComponent(taskListId)}/`, {
    method: 'DELETE',
  })

export const useDeleteTaskList = () => {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, string>({
    mutationFn: deleteTaskList,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

const createTaskGroup = (
  taskListId: string,
  payload: { name: string; sort_order?: number }
) =>
  fetchApi<ApiTaskGroup>(
    `task-lists/${encodeURIComponent(taskListId)}/groups/`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  )

export const useCreateTaskGroup = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskGroup,
    ApiError,
    { taskListId: string; name: string; sort_order?: number }
  >({
    mutationFn: ({ taskListId, ...payload }) =>
      createTaskGroup(taskListId, payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['task-lists'] }),
  })
}

const updateTaskGroup = (groupId: string, patch: { name?: string }) =>
  fetchApi<ApiTaskGroup>(`task-groups/${encodeURIComponent(groupId)}/`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

export const useUpdateTaskGroup = () => {
  const queryClient = useQueryClient()
  return useMutation<ApiTaskGroup, ApiError, { groupId: string; name: string }>(
    {
      mutationFn: ({ groupId, name }) => updateTaskGroup(groupId, { name }),
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: ['task-lists'] }),
    }
  )
}

const deleteTaskGroup = (groupId: string) =>
  fetchApi<void>(`task-groups/${encodeURIComponent(groupId)}/`, {
    method: 'DELETE',
  })

export const useDeleteTaskGroup = () => {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, string>({
    mutationFn: deleteTaskGroup,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

const fetchTaskStatistics = (
  scope: TaskScope,
  time: TaskTimeFilter,
  priority: TaskPriorityFilter,
  taskList: string
) =>
  fetchApi<ApiTaskStatistics>(
    `tasks/statistics/?scope=${scope}&status=all&time=${time}&priority=${priority}&task_list=${encodeURIComponent(taskList)}`
  )

export const useTaskStatistics = (
  scope: TaskScope,
  time: TaskTimeFilter,
  priority: TaskPriorityFilter,
  taskList: string,
  enabled = true
) =>
  useQuery<ApiTaskStatistics, ApiError>({
    queryKey: ['tasks', 'statistics', scope, time, priority, taskList],
    queryFn: () => fetchTaskStatistics(scope, time, priority, taskList),
    enabled,
  })

const fetchTaskSubtasks = (taskId: string) =>
  fetchApi<ApiTask[]>(`tasks/${encodeURIComponent(taskId)}/subtasks/`)

export const useTaskSubtasks = (taskId: string, enabled = true) =>
  useQuery<ApiTask[], ApiError>({
    queryKey: ['tasks', taskId, 'subtasks'],
    queryFn: () => fetchTaskSubtasks(taskId),
    enabled,
  })

const fetchTaskActivities = (taskId: string) =>
  fetchApi<ApiTaskActivity[]>(`tasks/${encodeURIComponent(taskId)}/activities/`)

export const useTaskActivities = (taskId: string) =>
  useQuery<ApiTaskActivity[], ApiError>({
    queryKey: ['tasks', taskId, 'activities'],
    queryFn: () => fetchTaskActivities(taskId),
  })

const fetchTaskComments = (taskId: string) =>
  fetchApi<ApiTaskComment[]>(`tasks/${encodeURIComponent(taskId)}/comments/`)

export const useTaskComments = (taskId: string) =>
  useQuery<ApiTaskComment[], ApiError>({
    queryKey: ['tasks', taskId, 'comments'],
    queryFn: () => fetchTaskComments(taskId),
  })

const createTaskComment = (taskId: string, content: string) =>
  fetchApi<ApiTaskComment>(`tasks/${encodeURIComponent(taskId)}/comments/`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })

export const useCreateTaskComment = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskComment,
    ApiError,
    { taskId: string; content: string }
  >({
    mutationFn: ({ taskId, content }) => createTaskComment(taskId, content),
    onSuccess: (_comment, variables) =>
      queryClient.invalidateQueries({
        queryKey: ['tasks', variables.taskId, 'comments'],
      }),
  })
}

const fetchTaskAttachments = (taskId: string) =>
  fetchApi<ApiTaskAttachment[]>(
    `tasks/${encodeURIComponent(taskId)}/attachments/`
  )

export const useTaskAttachments = (taskId: string) =>
  useQuery<ApiTaskAttachment[], ApiError>({
    queryKey: ['tasks', taskId, 'attachments'],
    queryFn: () => fetchTaskAttachments(taskId),
  })

const createTaskAttachment = async (
  taskId: string,
  file: File,
  onProgress: (progress: number) => void
) => {
  const uploadedFile = await createFile({
    file,
    onProgress,
    type: 'task_attachment',
  })
  return fetchApi<ApiTaskAttachment>(
    `tasks/${encodeURIComponent(taskId)}/attachments/`,
    {
      method: 'POST',
      body: JSON.stringify({ file_id: uploadedFile.id }),
    }
  )
}

export const useCreateTaskAttachment = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskAttachment,
    Error,
    {
      taskId: string
      file: File
      onProgress: (progress: number) => void
    }
  >({
    mutationFn: ({ taskId, file, onProgress }) =>
      createTaskAttachment(taskId, file, onProgress),
    onSuccess: (_attachment, variables) =>
      queryClient.invalidateQueries({
        queryKey: ['tasks', variables.taskId, 'attachments'],
      }),
  })
}

const deleteTaskAttachment = (taskId: string, attachmentId: string) =>
  fetchApi<void>(
    `tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/`,
    { method: 'DELETE' }
  )

export const useDeleteTaskAttachment = () => {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, { taskId: string; attachmentId: string }>({
    mutationFn: ({ taskId, attachmentId }) =>
      deleteTaskAttachment(taskId, attachmentId),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['tasks', variables.taskId, 'attachments'],
      })
      void queryClient.invalidateQueries({
        queryKey: ['tasks', variables.taskId, 'activities'],
      })
    },
  })
}

const createTask = (payload: CreateTaskPayload) =>
  fetchApi<ApiTask>('tasks/', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const useCreateTask = () => {
  const queryClient = useQueryClient()
  return useMutation<ApiTask, ApiError, CreateTaskPayload>({
    mutationFn: createTask,
    onSuccess: (task) => {
      queryClient.setQueryData(['tasks', 'detail', task.id], task)
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      return queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

const createTaskSubtask = (taskId: string, payload: CreateTaskPayload) =>
  fetchApi<ApiTask>(`tasks/${encodeURIComponent(taskId)}/subtasks/`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const useCreateTaskSubtask = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTask,
    ApiError,
    { taskId: string; payload: CreateTaskPayload }
  >({
    mutationFn: ({ taskId, payload }) => createTaskSubtask(taskId, payload),
    onSuccess: (task, variables) => {
      queryClient.setQueryData(['tasks', 'detail', task.id], task)
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
      void queryClient.invalidateQueries({
        queryKey: ['tasks', variables.taskId, 'subtasks'],
      })
    },
  })
}

const patchTask = (taskId: string, patch: PatchTaskPayload) =>
  fetchApi<ApiTask>(`tasks/${encodeURIComponent(taskId)}/`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

export const usePatchTask = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTask,
    ApiError,
    { taskId: string; patch: PatchTaskPayload }
  >({
    mutationFn: ({ taskId, patch }) => patchTask(taskId, patch),
    onSuccess: (task, variables) => {
      queryClient.setQueryData(['tasks', 'detail', task.id], task)
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
      void queryClient.invalidateQueries({
        queryKey: ['tasks', variables.taskId, 'activities'],
      })
    },
  })
}
