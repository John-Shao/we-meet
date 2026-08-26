import { useInfiniteQuery } from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import type { Paginated } from '@/api/Paginated'
import { toApiPath } from '@/features/contacts/api/fetchDirectoryMembers'

import type { ApiTask } from './ApiTask'

export type TaskSearchStatus = 'all' | 'todo' | 'completed'
export type TaskSearchDue =
  | 'all'
  | 'today'
  | 'tomorrow'
  | 'this_week'
  | 'overdue'
  | 'no_date'

export interface TaskSearchFilters {
  creatorIds: string[]
  assigneeIds: string[]
  followerIds: string[]
  status: TaskSearchStatus
  due: TaskSearchDue
}

export const EMPTY_TASK_SEARCH_FILTERS: TaskSearchFilters = {
  creatorIds: [],
  assigneeIds: [],
  followerIds: [],
  status: 'all',
  due: 'all',
}

const normalizedIds = (ids: string[]) => [...new Set(ids)].sort()

export const buildTaskSearchUrl = (
  query: string,
  filters: TaskSearchFilters,
  pageSize: number
) => {
  const params = new URLSearchParams({
    scope: 'all',
    status: filters.status,
    q: query.trim(),
  })
  const people: Array<[string, string[]]> = [
    ['creator_ids', filters.creatorIds],
    ['assignee_ids', filters.assigneeIds],
    ['follower_ids', filters.followerIds],
  ]
  for (const [parameter, ids] of people) {
    const normalized = normalizedIds(ids)
    if (normalized.length) params.set(parameter, normalized.join(','))
  }
  if (filters.due !== 'all') params.set('due', filters.due)
  params.set('page_size', String(pageSize))
  return `tasks/?${params.toString()}`
}

const fetchTaskSearchPage = (searchUrl: string, pageUrl?: string) =>
  fetchApi<Paginated<ApiTask>>(pageUrl ? toApiPath(pageUrl) : searchUrl)

export const useTaskSearch = (
  query: string,
  filters: TaskSearchFilters,
  pageSize: number,
  enabled: boolean
) => {
  const searchUrl = buildTaskSearchUrl(query, filters, pageSize)
  return useInfiniteQuery<Paginated<ApiTask>, ApiError>({
    queryKey: ['tasks', 'global-search', searchUrl],
    queryFn: ({ pageParam }) =>
      fetchTaskSearchPage(searchUrl, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next ?? undefined,
    enabled,
    retry: false,
    staleTime: 15_000,
  })
}
