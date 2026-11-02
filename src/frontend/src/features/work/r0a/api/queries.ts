import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'

import {
  acceptWorkTask,
  createAdminAuditExport,
  downloadAdminAuditExport,
  retryWorkTask,
  fetchAdminAuditExport,
  fetchAdminOverview,
  fetchAdminProviderConfig,
  fetchAdminSeats,
  fetchAdminUsage,
  cancelWorkRun,
  deleteWorkTask,
  createWorkInput,
  createWorkPreview,
  fetchWorkArtifactContent,
  fetchWorkArtifactWorkspace,
  fetchWorkBootstrap,
  fetchWorkInbox,
  fetchWorkRunOperations,
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
  tasksAll: ['work', 'tasks'] as const,
  inbox: ['work', 'inbox'] as const,
  operations: (runId: string) => ['work', 'operations', runId] as const,
  task: (taskId: string) => ['work', 'task', taskId] as const,
  adminOverview: ['work', 'admin', 'overview'] as const,
  adminSeats: ['work', 'admin', 'seats'] as const,
  adminUsage: (from: string, to: string) =>
    ['work', 'admin', 'usage', from, to] as const,
  adminProviderConfig: ['work', 'admin', 'provider-config'] as const,
  adminExport: (id: string) => ['work', 'admin', 'export', id] as const,
  artifactWorkspace: (taskId: string, artifactId: string) =>
    ['work', 'artifact-workspace', taskId, artifactId] as const,
  artifactContent: (taskId: string, artifactId: string, versionNo: number) =>
    ['work', 'artifact-content', taskId, artifactId, versionNo] as const,
}

// invalidateWorkTaskLists covers both task projections at once. The inbox is the
// same tasks seen from "what needs you", so any mutation that changes a task's
// state changes that list too - and a page that refreshed only the task list
// would keep offering a task the owner has already accepted.
const invalidateWorkTaskLists = (queryClient: QueryClient) => {
  void queryClient.invalidateQueries({ queryKey: workKeys.tasksAll })
  void queryClient.invalidateQueries({ queryKey: workKeys.inbox })
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

// The inbox is the cross-task "需要你" projection, and R0a polls it: the task
// list's own SSE stream only covers the task the workspace is showing, so an
// acceptance that became due on another task has no other way to surface. 30s is
// what D5 fixes; the mutations invalidate the same key, so an action on the
// visible task does not have to wait for the next tick.
export const useWorkInbox = () =>
  useInfiniteQuery({
    queryKey: workKeys.inbox,
    queryFn: ({ pageParam }) => fetchWorkInbox(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    staleTime: 15_000,
    refetchInterval: 30_000,
  })

export const useWorkRunOperations = (runId: string | undefined) =>
  useInfiniteQuery({
    queryKey: workKeys.operations(runId ?? ''),
    queryFn: ({ pageParam }) => fetchWorkRunOperations(runId!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: !!runId,
    retry: false,
  })

export const useWorkTask = (taskId: string | undefined) =>
  useQuery({
    queryKey: workKeys.task(taskId ?? ''),
    queryFn: () => fetchWorkTask(taskId!),
    enabled: !!taskId,
    retry: false,
  })

export const useWorkArtifactWorkspace = (
  taskId: string | undefined,
  artifactId: string | undefined
) =>
  useQuery({
    queryKey: workKeys.artifactWorkspace(taskId ?? '', artifactId ?? ''),
    queryFn: () => fetchWorkArtifactWorkspace(taskId!, artifactId!),
    enabled: !!taskId && !!artifactId,
    retry: false,
  })

export const useWorkArtifactContent = (
  taskId: string | undefined,
  artifactId: string | undefined,
  versionNo: number | undefined,
  enabled: boolean
) =>
  useQuery({
    queryKey: workKeys.artifactContent(
      taskId ?? '',
      artifactId ?? '',
      versionNo ?? 0
    ),
    queryFn: () => fetchWorkArtifactContent(taskId!, artifactId!, versionNo!),
    enabled: enabled && !!taskId && !!artifactId && !!versionNo,
    staleTime: Infinity,
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
      invalidateWorkTaskLists(queryClient)
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
      invalidateWorkTaskLists(queryClient)
    },
  })
}

export const useDeleteWorkTask = (taskId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (expectedRevision: number) =>
      deleteWorkTask(taskId, expectedRevision),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: workKeys.task(taskId) })
      invalidateWorkTaskLists(queryClient)
    },
  })
}

export const useRetryWorkTask = (taskId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      client_request_id: string
      expected_revision: number
      target: { kind: string; profile: string }
    }) => retryWorkTask(taskId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workKeys.task(taskId) })
      invalidateWorkTaskLists(queryClient)
    },
  })
}

export const useCancelWorkRun = (taskId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => cancelWorkRun(runId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workKeys.task(taskId) })
      invalidateWorkTaskLists(queryClient)
    },
  })
}

export const useAcceptWorkTask = (taskId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Parameters<typeof acceptWorkTask>[1]) =>
      acceptWorkTask(taskId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workKeys.task(taskId) })
      invalidateWorkTaskLists(queryClient)
      void queryClient.invalidateQueries({
        queryKey: ['work', 'artifact-workspace'],
      })
    },
  })
}

export const workQueryKeys = workKeys

export const useAdminOverview = () =>
  useQuery({
    queryKey: workKeys.adminOverview,
    queryFn: fetchAdminOverview,
    retry: false,
  })

export const useAdminSeats = () =>
  useInfiniteQuery({
    queryKey: workKeys.adminSeats,
    queryFn: ({ pageParam }) => fetchAdminSeats(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    retry: false,
  })

export const useAdminUsage = (from: string, to: string) =>
  useQuery({
    queryKey: workKeys.adminUsage(from, to),
    queryFn: () => fetchAdminUsage(from, to),
    enabled: !!from && !!to,
    retry: false,
  })

export const useAdminProviderConfig = () =>
  useQuery({
    queryKey: workKeys.adminProviderConfig,
    queryFn: fetchAdminProviderConfig,
    retry: false,
  })

export const useCreateAdminAuditExport = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createAdminAuditExport,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['work', 'admin'] })
    },
  })
}

export const useAdminAuditExport = (exportId: string | undefined) =>
  useQuery({
    queryKey: workKeys.adminExport(exportId ?? ''),
    queryFn: () => fetchAdminAuditExport(exportId!),
    enabled: !!exportId,
    retry: false,
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
  })

export const useDownloadAdminAuditExport = () =>
  useMutation({ mutationFn: downloadAdminAuditExport })
