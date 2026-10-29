import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import {
  acceptWorkTask,
  cancelWorkRun,
  createWorkInput,
  createWorkPreview,
  fetchWorkBootstrap,
  fetchWorkTask,
  fetchWorkTasks,
  fetchWorkTemplates,
  submitWorkTask,
  updateWorkTaskTitle,
} from './client'
import type { WorkTaskView } from './types'

const workKeys = {
  bootstrap: ['work', 'bootstrap'] as const,
  templates: ['work', 'templates'] as const,
  tasks: (view: string) => ['work', 'tasks', view] as const,
  task: (taskId: string) => ['work', 'task', taskId] as const,
}

export const useWorkBootstrap = () =>
  useQuery({
    queryKey: workKeys.bootstrap,
    queryFn: fetchWorkBootstrap,
    staleTime: 5 * 60_000,
    retry: false,
  })

export const useWorkTemplates = () =>
  useQuery({
    queryKey: workKeys.templates,
    queryFn: fetchWorkTemplates,
    staleTime: 10 * 60_000,
    retry: false,
  })

export const useWorkTasks = (view: WorkTaskView) =>
  useInfiniteQuery({
    queryKey: workKeys.tasks(view),
    queryFn: ({ pageParam }) => fetchWorkTasks(view, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    staleTime: 15_000,
  })

export const useWorkTask = (taskId: string | undefined) =>
  useQuery({
    queryKey: workKeys.task(taskId ?? ''),
    queryFn: () => fetchWorkTask(taskId!),
    enabled: !!taskId,
    retry: false,
  })

export const useCreateWorkInput = () =>
  useMutation({ mutationFn: createWorkInput })

export const useCreateWorkPreview = () =>
  useMutation({ mutationFn: createWorkPreview })

export const useSubmitWorkTask = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: submitWorkTask,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['work', 'tasks'] })
    },
  })
}

export const useUpdateWorkTitle = (taskId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      client_request_id: string
      expected_revision: number
      title: string
    }) => updateWorkTaskTitle(taskId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workKeys.task(taskId) })
      void queryClient.invalidateQueries({ queryKey: ['work', 'tasks'] })
    },
  })
}

export const useCancelWorkRun = (taskId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => cancelWorkRun(runId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workKeys.task(taskId) })
      void queryClient.invalidateQueries({ queryKey: ['work', 'tasks'] })
    },
  })
}

export const useAcceptWorkTask = (taskId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      client_request_id: string
      expected_revision: number
      completion_reason: string
    }) => acceptWorkTask(taskId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workKeys.task(taskId) })
      void queryClient.invalidateQueries({ queryKey: ['work', 'tasks'] })
    },
  })
}

export const workQueryKeys = workKeys
