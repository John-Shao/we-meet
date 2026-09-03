import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'
import { createFile } from '@/features/files/api/createFile'
import { toApiPath } from '@/features/contacts/api/fetchDirectoryMembers'

import type {
  ApiTask,
  ApiStandaloneTaskCount,
  ApiTaskSettings,
  ApiTaskReminderPreference,
  ApiTaskSavedView,
  ApiTaskList,
  ApiTaskListAccess,
  ApiTaskListGroup,
  ApiTaskParentCandidate,
  ApiTaskGroup,
  ApiTaskStatistics,
  ApiTaskActivity,
  ApiTaskAttachment,
  ApiTaskComment,
  ApiTaskShareResult,
  ApiTaskSubtreeImpact,
  CreateTaskPayload,
  PatchTaskPayload,
  PatchTaskSettingsPayload,
  PatchTaskReminderPreferencePayload,
  CreateTaskSavedViewPayload,
  PatchTaskSavedViewPayload,
  TaskRecurrencePayload,
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
  group: string = 'all',
  ordering: TaskOrdering = ''
) =>
  `tasks/?scope=${scope}&status=${status}&time=${time}&priority=${priority}&task_list=${encodeURIComponent(taskList)}&group=${encodeURIComponent(group)}${ordering ? `&ordering=${encodeURIComponent(ordering)}` : ''}&page_size=50`

const fetchTasks = (
  scope: TaskScope,
  status: TaskStatusFilter,
  time: TaskTimeFilter,
  priority: TaskPriorityFilter,
  taskList: string,
  group: string,
  ordering: TaskOrdering,
  pageUrl?: string,
  signal?: AbortSignal
) =>
  fetchApi<Paginated<ApiTask>>(
    pageUrl
      ? toApiPath(pageUrl)
      : buildTasksUrl(scope, status, time, priority, taskList, group, ordering),
    { signal }
  )

export const getNextTasksPageParam = (lastPage: Paginated<ApiTask>) =>
  lastPage.next ?? undefined

export const useTasks = (
  scope: TaskScope,
  status: TaskStatusFilter,
  time: TaskTimeFilter,
  priority: TaskPriorityFilter,
  taskList: string,
  group: string = 'all',
  ordering: TaskOrdering = ''
) =>
  useInfiniteQuery<Paginated<ApiTask>, ApiError>({
    queryKey: [
      'tasks',
      scope,
      status,
      time,
      priority,
      taskList,
      group,
      ordering,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchTasks(
        scope,
        status,
        time,
        priority,
        taskList,
        group,
        ordering,
        pageParam as string | undefined,
        signal
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: getNextTasksPageParam,
  })

const sharedViaQuery = (sharedVia?: string) =>
  sharedVia ? `?shared_via=${encodeURIComponent(sharedVia)}` : ''

const fetchTask = (taskId: string, sharedVia?: string, signal?: AbortSignal) =>
  fetchApi<ApiTask>(
    `tasks/${encodeURIComponent(taskId)}/${sharedViaQuery(sharedVia)}`,
    { signal }
  )

export const useTask = (taskId?: string, sharedVia?: string) =>
  useQuery<ApiTask, ApiError>({
    queryKey: ['tasks', 'detail', taskId, sharedVia],
    queryFn: ({ signal }) => fetchTask(taskId!, sharedVia, signal),
    enabled: Boolean(taskId),
  })

const fetchTaskReminder = (taskId: string) =>
  fetchApi<ApiTaskReminderPreference>(
    `tasks/${encodeURIComponent(taskId)}/reminder/`
  )

const patchTaskReminder = (
  taskId: string,
  patch: PatchTaskReminderPreferencePayload
) =>
  fetchApi<ApiTaskReminderPreference>(
    `tasks/${encodeURIComponent(taskId)}/reminder/`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }
  )

export const useTaskReminder = (taskId?: string, enabled = true) =>
  useQuery<ApiTaskReminderPreference, ApiError>({
    queryKey: ['tasks', taskId, 'reminder'],
    queryFn: () => fetchTaskReminder(taskId!),
    enabled: Boolean(taskId) && enabled,
  })

export const useUpdateTaskReminder = (taskId: string) => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskReminderPreference,
    ApiError,
    PatchTaskReminderPreferencePayload
  >({
    mutationFn: (patch) => patchTaskReminder(taskId, patch),
    onSuccess: (preference) => {
      queryClient.setQueryData(['tasks', taskId, 'reminder'], preference)
    },
  })
}

const fetchTaskSubtasks = (
  taskId: string,
  sharedVia?: string,
  signal?: AbortSignal
) =>
  fetchApi<ApiTask[]>(
    `tasks/${encodeURIComponent(taskId)}/subtasks/${sharedViaQuery(sharedVia)}`,
    { signal }
  )

export const useTaskSubtasks = (taskId?: string, sharedVia?: string) =>
  useQuery<ApiTask[], ApiError>({
    queryKey: ['tasks', taskId, 'subtasks', sharedVia],
    queryFn: ({ signal }) => fetchTaskSubtasks(taskId!, sharedVia, signal),
    enabled: Boolean(taskId),
  })

const reorderTaskSubtasks = (taskId: string, taskIds: string[]) =>
  fetchApi<ApiTask[]>(`tasks/${encodeURIComponent(taskId)}/subtasks/reorder/`, {
    method: 'POST',
    body: JSON.stringify({ task_ids: taskIds }),
  })

export const useReorderTaskSubtasks = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTask[],
    ApiError,
    { taskId: string; taskIds: string[] }
  >({
    mutationFn: ({ taskId, taskIds }) => reorderTaskSubtasks(taskId, taskIds),
    onSuccess: (subtasks, { taskId }) => {
      queryClient.setQueryData(['tasks', taskId, 'subtasks'], subtasks)
      return queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export const fetchTaskSubtreeImpact = (
  taskId: string,
  sharedVia?: string,
  signal?: AbortSignal
) =>
  fetchApi<ApiTaskSubtreeImpact>(
    `tasks/${encodeURIComponent(taskId)}/subtree-impact/${sharedViaQuery(sharedVia)}`,
    { signal }
  )

export const useTaskSubtreeImpact = (taskId?: string, sharedVia?: string) =>
  useQuery<ApiTaskSubtreeImpact, ApiError>({
    queryKey: ['tasks', taskId, 'subtree-impact', sharedVia],
    queryFn: ({ signal }) => fetchTaskSubtreeImpact(taskId!, sharedVia, signal),
    enabled: Boolean(taskId),
  })

export const fetchTaskParentCandidates = (
  taskId: string,
  sharedVia?: string,
  signal?: AbortSignal
) =>
  fetchApi<ApiTaskParentCandidate[]>(
    `tasks/${encodeURIComponent(taskId)}/parent-candidates/${sharedViaQuery(sharedVia)}`,
    { signal }
  )

export const useTaskParentCandidates = (taskId?: string, sharedVia?: string) =>
  useQuery<ApiTaskParentCandidate[], ApiError>({
    queryKey: ['tasks', taskId, 'parent-candidates', sharedVia],
    queryFn: ({ signal }) =>
      fetchTaskParentCandidates(taskId!, sharedVia, signal),
    enabled: Boolean(taskId),
  })

const fetchConversationTasks = (cid: string) =>
  fetchApi<ApiTask[]>(`tasks/conversation/?cid=${encodeURIComponent(cid)}`)

export const useConversationTasks = (cid?: string) =>
  useQuery<ApiTask[], ApiError>({
    queryKey: ['tasks', 'conversation', cid],
    queryFn: () => fetchConversationTasks(cid!),
    enabled: Boolean(cid),
  })

export const shareTaskToConversations = (
  taskId: string,
  conversationIds: string[],
  sharedVia?: string
) =>
  fetchApi<ApiTaskShareResult>(
    `tasks/${encodeURIComponent(taskId)}/share/${sharedViaQuery(sharedVia)}`,
    {
      method: 'POST',
      body: JSON.stringify({ conversation_ids: conversationIds }),
    }
  )

const fetchStandaloneTaskCount = () =>
  fetchApi<ApiStandaloneTaskCount>('tasks/standalone-count/')

export const useStandaloneTaskCount = () =>
  useQuery<ApiStandaloneTaskCount, ApiError>({
    queryKey: ['tasks', 'standalone-count'],
    queryFn: fetchStandaloneTaskCount,
  })

export const fetchTaskSettings = () =>
  fetchApi<ApiTaskSettings>('tasks/settings/')

export const patchTaskSettings = (patch: PatchTaskSettingsPayload) =>
  fetchApi<ApiTaskSettings>('tasks/settings/', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

export const useTaskSettings = () =>
  useQuery<ApiTaskSettings, ApiError>({
    queryKey: ['task-settings'],
    queryFn: fetchTaskSettings,
  })

export const useUpdateTaskSettings = () => {
  const queryClient = useQueryClient()
  return useMutation<ApiTaskSettings, ApiError, PatchTaskSettingsPayload>({
    mutationFn: patchTaskSettings,
    onSuccess: (settings) => {
      queryClient.setQueryData(['task-settings'], settings)
    },
  })
}

const fetchTaskSavedViews = () =>
  fetchApi<ApiTaskSavedView[]>('task-saved-views/')

export const useTaskSavedViews = () =>
  useQuery<ApiTaskSavedView[], ApiError>({
    queryKey: ['task-saved-views'],
    queryFn: fetchTaskSavedViews,
  })

const createTaskSavedView = (payload: CreateTaskSavedViewPayload) =>
  fetchApi<ApiTaskSavedView>('task-saved-views/', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const useCreateTaskSavedView = () => {
  const queryClient = useQueryClient()
  return useMutation<ApiTaskSavedView, ApiError, CreateTaskSavedViewPayload>({
    mutationFn: createTaskSavedView,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['task-saved-views'] }),
  })
}

const updateTaskSavedView = (
  viewId: string,
  patch: PatchTaskSavedViewPayload
) =>
  fetchApi<ApiTaskSavedView>(
    `task-saved-views/${encodeURIComponent(viewId)}/`,
    { method: 'PATCH', body: JSON.stringify(patch) }
  )

export const useUpdateTaskSavedView = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskSavedView,
    ApiError,
    { viewId: string; patch: PatchTaskSavedViewPayload }
  >({
    mutationFn: ({ viewId, patch }) => updateTaskSavedView(viewId, patch),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['task-saved-views'] }),
  })
}

const deleteTaskSavedView = (viewId: string) =>
  fetchApi<void>(`task-saved-views/${encodeURIComponent(viewId)}/`, {
    method: 'DELETE',
  })

export const useDeleteTaskSavedView = () => {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, string>({
    mutationFn: deleteTaskSavedView,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['task-saved-views'] }),
  })
}

const fetchTaskLists = (archived = false) =>
  fetchApi<ApiTaskList[]>(`task-lists/${archived ? '?archived=true' : ''}`)

export const useTaskLists = () =>
  useQuery<ApiTaskList[], ApiError>({
    queryKey: ['task-lists'],
    queryFn: () => fetchTaskLists(),
  })

export const useArchivedTaskLists = (enabled = true) =>
  useQuery<ApiTaskList[], ApiError>({
    queryKey: ['task-lists', 'archived'],
    queryFn: () => fetchTaskLists(true),
    enabled,
  })

const fetchTaskListGroups = () =>
  fetchApi<ApiTaskListGroup[]>('task-list-groups/')

export const useTaskListGroups = () =>
  useQuery<ApiTaskListGroup[], ApiError>({
    queryKey: ['task-list-groups'],
    queryFn: fetchTaskListGroups,
  })

const createTaskListGroup = (payload: { name: string; sort_order?: number }) =>
  fetchApi<ApiTaskListGroup>('task-list-groups/', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const useCreateTaskListGroup = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskListGroup,
    ApiError,
    { name: string; sort_order?: number }
  >({
    mutationFn: createTaskListGroup,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['task-list-groups'] }),
  })
}

const updateTaskListGroup = (groupId: string, patch: { name: string }) =>
  fetchApi<ApiTaskListGroup>(
    `task-list-groups/${encodeURIComponent(groupId)}/`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }
  )

export const useUpdateTaskListGroup = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskListGroup,
    ApiError,
    { groupId: string; name: string }
  >({
    mutationFn: ({ groupId, name }) => updateTaskListGroup(groupId, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-list-groups'] })
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
    },
  })
}

const deleteTaskListGroup = (groupId: string) =>
  fetchApi<void>(`task-list-groups/${encodeURIComponent(groupId)}/`, {
    method: 'DELETE',
  })

export const useDeleteTaskListGroup = () => {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, string>({
    mutationFn: deleteTaskListGroup,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-list-groups'] })
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
    },
  })
}

const createTaskList = (payload: {
  name: string
  description?: string
  color: ApiTaskList['color']
  list_group_id?: string | null
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
    {
      name: string
      description?: string
      color: ApiTaskList['color']
      list_group_id?: string | null
    }
  >({
    mutationFn: createTaskList,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      void queryClient.invalidateQueries({ queryKey: ['task-list-groups'] })
    },
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
      void queryClient.invalidateQueries({ queryKey: ['task-list-groups'] })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

const updateTaskList = (
  taskListId: string,
  patch: { name?: string; is_archived?: boolean },
  archived = false
) =>
  fetchApi<ApiTaskList>(
    `task-lists/${encodeURIComponent(taskListId)}/${archived ? '?archived=true' : ''}`,
    { method: 'PATCH', body: JSON.stringify(patch) }
  )

export const useUpdateTaskList = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskList,
    ApiError,
    {
      taskListId: string
      patch: { name?: string; is_archived?: boolean }
      archived?: boolean
    }
  >({
    mutationFn: ({ taskListId, patch, archived }) =>
      updateTaskList(taskListId, patch, archived),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

const fetchTaskListShares = (taskListId: string) =>
  fetchApi<ApiTaskListAccess[]>(
    `task-lists/${encodeURIComponent(taskListId)}/shares/`
  )

export const useTaskListShares = (taskListId?: string) =>
  useQuery<ApiTaskListAccess[], ApiError>({
    queryKey: ['task-lists', taskListId, 'shares'],
    queryFn: () => fetchTaskListShares(taskListId!),
    enabled: Boolean(taskListId),
  })

export const useShareTaskList = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskListAccess,
    ApiError,
    { taskListId: string; userId: string; role: 'viewer' | 'editor' }
  >({
    mutationFn: ({ taskListId, userId, role }) =>
      fetchApi<ApiTaskListAccess>(
        `task-lists/${encodeURIComponent(taskListId)}/shares/`,
        {
          method: 'POST',
          body: JSON.stringify({ user_id: userId, role }),
        }
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['task-lists', variables.taskListId, 'shares'],
      })
    },
  })
}

export const useUpdateTaskListShare = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskListAccess,
    ApiError,
    { taskListId: string; userId: string; role: 'viewer' | 'editor' }
  >({
    mutationFn: ({ taskListId, userId, role }) =>
      fetchApi<ApiTaskListAccess>(
        `task-lists/${encodeURIComponent(taskListId)}/shares/${encodeURIComponent(userId)}/`,
        { method: 'PATCH', body: JSON.stringify({ role }) }
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['task-lists', variables.taskListId, 'shares'],
      })
    },
  })
}

export const useRemoveTaskListShare = () => {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, { taskListId: string; userId: string }>({
    mutationFn: ({ taskListId, userId }) =>
      fetchApi<void>(
        `task-lists/${encodeURIComponent(taskListId)}/shares/${encodeURIComponent(userId)}/`,
        { method: 'DELETE' }
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['task-lists', variables.taskListId, 'shares'],
      })
    },
  })
}

export const useLeaveTaskList = () => {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, string>({
    mutationFn: (taskListId) =>
      fetchApi<void>(`task-lists/${encodeURIComponent(taskListId)}/leave/`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export const useDestroyTaskList = () => {
  const queryClient = useQueryClient()
  return useMutation<
    void,
    ApiError,
    { taskListId: string; deleteUnassigned: boolean }
  >({
    mutationFn: ({ taskListId, deleteUnassigned }) =>
      fetchApi<void>(
        `task-lists/${encodeURIComponent(taskListId)}/?delete_unassigned=${deleteUnassigned}`,
        { method: 'DELETE' }
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      void queryClient.invalidateQueries({ queryKey: ['task-list-groups'] })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

const moveTaskListToGroup = ({
  taskListId,
  listGroupId,
}: {
  taskListId: string
  listGroupId: string | null
}) =>
  fetchApi<ApiTaskList>(`task-lists/${encodeURIComponent(taskListId)}/`, {
    method: 'PATCH',
    body: JSON.stringify({ list_group_id: listGroupId }),
  })

export const useMoveTaskListToGroup = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskList,
    ApiError,
    { taskListId: string; listGroupId: string | null }
  >({
    mutationFn: moveTaskListToGroup,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      void queryClient.invalidateQueries({ queryKey: ['task-list-groups'] })
    },
  })
}

const createTaskGroup = (
  taskListId: string | undefined,
  payload: { name: string; sort_order?: number }
) =>
  fetchApi<ApiTaskGroup>(
    taskListId
      ? `task-lists/${encodeURIComponent(taskListId)}/groups/`
      : 'task-groups/',
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
    { taskListId?: string; name: string; sort_order?: number }
  >({
    mutationFn: ({ taskListId, ...payload }) =>
      createTaskGroup(taskListId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      void queryClient.invalidateQueries({ queryKey: ['task-groups'] })
    },
  })
}

const fetchTaskGroups = () => fetchApi<ApiTaskGroup[]>('task-groups/')

export const useTaskGroups = () =>
  useQuery<ApiTaskGroup[], ApiError>({
    queryKey: ['task-groups'],
    queryFn: fetchTaskGroups,
  })

const updateTaskGroup = (
  groupId: string,
  patch: { name?: string; sort_order?: number }
) =>
  fetchApi<ApiTaskGroup>(`task-groups/${encodeURIComponent(groupId)}/`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

export const useUpdateTaskGroup = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTaskGroup,
    ApiError,
    { groupId: string; patch: { name?: string; sort_order?: number } }
  >({
    mutationFn: ({ groupId, patch }) => updateTaskGroup(groupId, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      void queryClient.invalidateQueries({ queryKey: ['task-groups'] })
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-groups'] })
    },
  })
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
      void queryClient.invalidateQueries({ queryKey: ['task-groups'] })
      void queryClient.invalidateQueries({ queryKey: ['task-saved-views'] })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

const fetchTaskStatistics = (
  scope: TaskScope,
  time: TaskTimeFilter,
  priority: TaskPriorityFilter,
  taskList: string,
  group: string
) =>
  fetchApi<ApiTaskStatistics>(
    `tasks/statistics/?scope=${scope}&status=all&time=${time}&priority=${priority}&task_list=${encodeURIComponent(taskList)}&group=${encodeURIComponent(group)}&hierarchy=include_descendants`
  )

export const useTaskStatistics = (
  scope: TaskScope,
  time: TaskTimeFilter,
  priority: TaskPriorityFilter,
  taskList: string,
  group: string = 'all',
  enabled = true
) =>
  useQuery<ApiTaskStatistics, ApiError>({
    queryKey: ['tasks', 'statistics', scope, time, priority, taskList, group],
    queryFn: () => fetchTaskStatistics(scope, time, priority, taskList, group),
    enabled,
  })

const fetchTaskActivities = (
  taskId: string,
  sharedVia?: string,
  signal?: AbortSignal
) =>
  fetchApi<ApiTaskActivity[]>(
    `tasks/${encodeURIComponent(taskId)}/activities/${sharedViaQuery(sharedVia)}`,
    { signal }
  )

export const useTaskActivities = (taskId: string, sharedVia?: string) =>
  useQuery<ApiTaskActivity[], ApiError>({
    queryKey: ['tasks', taskId, 'activities', sharedVia],
    queryFn: ({ signal }) => fetchTaskActivities(taskId, sharedVia, signal),
  })

const fetchTaskActivityFeed = (pageUrl?: string, signal?: AbortSignal) =>
  fetchApi<Paginated<ApiTaskActivity>>(
    pageUrl ? toApiPath(pageUrl) : 'tasks/activity/?page_size=50',
    { signal }
  )

export const getNextTaskActivityPageParam = (
  lastPage: Paginated<ApiTaskActivity>
) => lastPage.next ?? undefined

export const useTaskActivityFeed = () =>
  useInfiniteQuery<Paginated<ApiTaskActivity>, ApiError>({
    queryKey: ['tasks', 'activity'],
    queryFn: ({ pageParam, signal }) =>
      fetchTaskActivityFeed(pageParam as string | undefined, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: getNextTaskActivityPageParam,
  })

const fetchTaskComments = (
  taskId: string,
  sharedVia?: string,
  signal?: AbortSignal
) =>
  fetchApi<ApiTaskComment[]>(
    `tasks/${encodeURIComponent(taskId)}/comments/${sharedViaQuery(sharedVia)}`,
    { signal }
  )

export const useTaskComments = (taskId: string, sharedVia?: string) =>
  useQuery<ApiTaskComment[], ApiError>({
    queryKey: ['tasks', taskId, 'comments', sharedVia],
    queryFn: ({ signal }) => fetchTaskComments(taskId, sharedVia, signal),
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

const fetchTaskAttachments = (
  taskId: string,
  sharedVia?: string,
  signal?: AbortSignal
) =>
  fetchApi<ApiTaskAttachment[]>(
    `tasks/${encodeURIComponent(taskId)}/attachments/${sharedViaQuery(sharedVia)}`,
    { signal }
  )

export const useTaskAttachments = (taskId: string, sharedVia?: string) =>
  useQuery<ApiTaskAttachment[], ApiError>({
    queryKey: ['tasks', taskId, 'attachments', sharedVia],
    queryFn: ({ signal }) => fetchTaskAttachments(taskId, sharedVia, signal),
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
      if (task.parent_id) {
        void queryClient.invalidateQueries({
          queryKey: ['tasks', task.parent_id, 'subtasks'],
        })
        void queryClient.invalidateQueries({
          queryKey: ['tasks', 'detail', task.parent_id],
        })
      }
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      return queryClient.invalidateQueries({ queryKey: ['tasks'] })
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

const updateTaskRecurrence = (
  taskId: string,
  recurrence: TaskRecurrencePayload
) =>
  fetchApi<ApiTask>(`tasks/${encodeURIComponent(taskId)}/recurrence/`, {
    method: 'PATCH',
    body: JSON.stringify(recurrence),
  })

const stopTaskRecurrence = (taskId: string) =>
  fetchApi<ApiTask>(`tasks/${encodeURIComponent(taskId)}/recurrence/`, {
    method: 'DELETE',
  })

const useRecurrenceMutationSuccess = () => {
  const queryClient = useQueryClient()
  return (task: ApiTask) => {
    queryClient.setQueryData(['tasks', 'detail', task.id], task)
    void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    void queryClient.invalidateQueries({
      queryKey: ['tasks', task.id, 'activities'],
    })
  }
}

export const useUpdateTaskRecurrence = () => {
  const onSuccess = useRecurrenceMutationSuccess()
  return useMutation<
    ApiTask,
    ApiError,
    { taskId: string; recurrence: TaskRecurrencePayload }
  >({
    mutationFn: ({ taskId, recurrence }) =>
      updateTaskRecurrence(taskId, recurrence),
    onSuccess,
  })
}

export const useStopTaskRecurrence = () => {
  const onSuccess = useRecurrenceMutationSuccess()
  return useMutation<ApiTask, ApiError, string>({
    mutationFn: stopTaskRecurrence,
    onSuccess,
  })
}

export type TaskFollowTarget = string | { taskId: string; sharedVia?: string }

const unpackFollowTarget = (target: TaskFollowTarget) =>
  typeof target === 'string' ? { taskId: target, sharedVia: undefined } : target

const followTask = (target: TaskFollowTarget) => {
  const { taskId, sharedVia } = unpackFollowTarget(target)
  return fetchApi<ApiTask>(
    `tasks/${encodeURIComponent(taskId)}/follow/${sharedViaQuery(sharedVia)}`,
    {
      method: 'POST',
    }
  )
}

const unfollowTask = (target: TaskFollowTarget) => {
  const { taskId, sharedVia } = unpackFollowTarget(target)
  return fetchApi<ApiTask>(
    `tasks/${encodeURIComponent(taskId)}/follow/${sharedViaQuery(sharedVia)}`,
    {
      method: 'DELETE',
    }
  )
}

const refreshTaskFollowers = (taskId: string, followerIds: string[]) =>
  fetchApi<ApiTask>(`tasks/${encodeURIComponent(taskId)}/followers/`, {
    method: 'POST',
    body: JSON.stringify({ follower_ids: followerIds }),
  })

const removeTaskFollower = (taskId: string, followerId: string) =>
  fetchApi<void>(
    `tasks/${encodeURIComponent(taskId)}/followers/${encodeURIComponent(followerId)}/`,
    { method: 'DELETE' }
  )

const invalidateFollowerQueries = (
  queryClient: QueryClient,
  taskId: string
) => {
  void queryClient.invalidateQueries({ queryKey: ['tasks'] })
  return queryClient.invalidateQueries({
    queryKey: ['tasks', 'detail', taskId],
  })
}

export const useFollowTask = () => {
  const queryClient = useQueryClient()
  return useMutation<ApiTask, ApiError, TaskFollowTarget>({
    mutationFn: followTask,
    onSuccess: (task) => {
      queryClient.setQueryData(['tasks', 'detail', task.id], task)
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export const useUnfollowTask = () => {
  const queryClient = useQueryClient()
  return useMutation<ApiTask, ApiError, TaskFollowTarget>({
    mutationFn: unfollowTask,
    onSuccess: (task) => {
      queryClient.setQueryData(['tasks', 'detail', task.id], task)
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export const useAddTaskFollowers = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ApiTask,
    ApiError,
    { taskId: string; followerIds: string[] }
  >({
    mutationFn: ({ taskId, followerIds }) =>
      refreshTaskFollowers(taskId, followerIds),
    onSuccess: (task) => {
      queryClient.setQueryData(['tasks', 'detail', task.id], task)
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export const useRemoveTaskFollower = () => {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, { taskId: string; followerId: string }>({
    mutationFn: ({ taskId, followerId }) =>
      removeTaskFollower(taskId, followerId),
    onSuccess: (_result, variables) =>
      invalidateFollowerQueries(queryClient, variables.taskId),
  })
}

export type DeleteTaskTarget = {
  taskId: string
  confirmSubtreeNodeCount?: number
}

const deleteTask = ({ taskId, confirmSubtreeNodeCount }: DeleteTaskTarget) =>
  fetchApi<void>(
    `tasks/${encodeURIComponent(taskId)}/${
      confirmSubtreeNodeCount
        ? `?confirm_subtree_node_count=${confirmSubtreeNodeCount}`
        : ''
    }`,
    {
      method: 'DELETE',
    }
  )

export const useDeleteTask = () => {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, DeleteTaskTarget>({
    mutationFn: deleteTask,
    onSuccess: (_result, { taskId }) => {
      queryClient.removeQueries({ queryKey: ['tasks', 'detail', taskId] })
      void queryClient.invalidateQueries({ queryKey: ['task-lists'] })
      return queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}
