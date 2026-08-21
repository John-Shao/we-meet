import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'
import { createFile } from '@/features/files/api/createFile'

import type {
  ApiTask,
  ApiTaskActivity,
  ApiTaskAttachment,
  ApiTaskComment,
  CreateTaskPayload,
  PatchTaskPayload,
  TaskScope,
} from './ApiTask'

const fetchTasks = (scope: TaskScope) =>
  fetchApi<Paginated<ApiTask>>(`tasks/?scope=${scope}&page_size=100`)

export const useTasks = (scope: TaskScope) =>
  useQuery<Paginated<ApiTask>, ApiError>({
    queryKey: ['tasks', scope],
    queryFn: () => fetchTasks(scope),
  })

const fetchTaskSubtasks = (taskId: string) =>
  fetchApi<ApiTask[]>(`tasks/${encodeURIComponent(taskId)}/subtasks/`)

export const useTaskSubtasks = (taskId: string) =>
  useQuery<ApiTask[], ApiError>({
    queryKey: ['tasks', taskId, 'subtasks'],
    queryFn: () => fetchTaskSubtasks(taskId),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
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
    onSuccess: (_task, variables) => {
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
    onSuccess: (_task, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
      void queryClient.invalidateQueries({
        queryKey: ['tasks', variables.taskId, 'activities'],
      })
    },
  })
}
