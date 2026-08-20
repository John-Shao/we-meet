import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'

import type {
  ApiTask,
  ApiTaskActivity,
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

const fetchTaskActivities = (taskId: string) =>
  fetchApi<ApiTaskActivity[]>(`tasks/${encodeURIComponent(taskId)}/activities/`)

export const useTaskActivities = (taskId: string) =>
  useQuery<ApiTaskActivity[], ApiError>({
    queryKey: ['tasks', taskId, 'activities'],
    queryFn: () => fetchTaskActivities(taskId),
  })

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
