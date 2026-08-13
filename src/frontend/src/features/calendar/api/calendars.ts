import { fetchApi } from '@/api/fetchApi'

export type CalendarKind = 'primary' | 'shared' | 'resource' | 'external'
export type CalendarRole = 'none' | 'free_busy' | 'details' | 'writer' | 'admin'

export interface UnifiedCalendar {
  id: string
  kind: CalendarKind
  name: string
  display_name: string
  description: string
  owner: {
    id: string
    full_name: string | null
    short_name?: string | null
  } | null
  meeting_room: { id: string; name: string; code: string } | null
  organization_default_access: 'none' | 'free_busy' | 'details'
  effective_role: CalendarRole
  effective_permission: 'none' | 'free_busy' | 'details'
  subscribed: boolean
  enabled: boolean
  color: string
  subscriber_count: number
  capabilities: {
    can_write: boolean
    can_manage: boolean
    can_share: boolean
    can_export: boolean
    can_delete: boolean
  }
  deleted_at: string | null
}

export interface CalendarMember {
  id: string
  user: { id: string; full_name: string | null; short_name?: string | null }
  role: Exclude<CalendarRole, 'none'>
  external: boolean
}

export interface CalendarExportJob {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  row_count: number
  document_url: string
  download_url: string
  error_code: string
  error_detail: string
}

export interface ExternalCalendarAccount {
  id: string
  provider: 'google' | 'microsoft'
  email: string
  status: 'active' | 'reauth_required' | 'error'
  error_code: string
  bindings: Array<{
    id: string
    calendar_id: string
    remote_calendar_id: string
    name: string
    is_primary: boolean
    sync_status: string
    error_code: string
    last_synced_at: string | null
  }>
}

export interface ProviderCalendar {
  id: string
  name: string
  primary: boolean
  selected: boolean
}

export const fetchCalendars = (): Promise<UnifiedCalendar[]> =>
  fetchApi('/calendars/')

export const discoverCalendars = (
  type: 'contact' | 'room' | 'public',
  query: string
): Promise<UnifiedCalendar[]> =>
  fetchApi(
    `/calendars/discover/?${new URLSearchParams({ type, q: query }).toString()}`
  )

export const createCalendar = (payload: {
  name: string
  description?: string
  color?: string
  organization_default_access: 'none' | 'free_busy' | 'details'
  members?: Array<{ user_id: string; role: Exclude<CalendarRole, 'none'> }>
}): Promise<UnifiedCalendar> =>
  fetchApi('/calendars/', { method: 'POST', body: JSON.stringify(payload) })

export const updateCalendar = (
  id: string,
  payload: Partial<
    Pick<
      UnifiedCalendar,
      'name' | 'description' | 'organization_default_access'
    >
  >
): Promise<UnifiedCalendar> =>
  fetchApi(`/calendars/${encodeURIComponent(id)}/`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })

export const deleteCalendar = (id: string): Promise<void> =>
  fetchApi(`/calendars/${encodeURIComponent(id)}/`, { method: 'DELETE' }).then(
    () => undefined
  )

export const setCalendarSubscription = (
  id: string,
  payload: { enabled?: boolean; color?: string }
): Promise<UnifiedCalendar> =>
  fetchApi(`/calendars/${encodeURIComponent(id)}/subscription/`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })

export const unsubscribeUnifiedCalendar = (id: string): Promise<void> =>
  fetchApi(`/calendars/${encodeURIComponent(id)}/subscription/`, {
    method: 'DELETE',
  }).then(() => undefined)

export const fetchCalendarMembers = (id: string): Promise<CalendarMember[]> =>
  fetchApi(`/calendars/${encodeURIComponent(id)}/members/`)

export const addCalendarMember = (
  id: string,
  userId: string,
  role: Exclude<CalendarRole, 'none'>
): Promise<CalendarMember> =>
  fetchApi(`/calendars/${encodeURIComponent(id)}/members/`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, role }),
  })

export const updateCalendarMember = (
  calendarId: string,
  memberId: string,
  role: Exclude<CalendarRole, 'none'>
): Promise<CalendarMember> =>
  fetchApi(
    `/calendars/${encodeURIComponent(calendarId)}/members/${encodeURIComponent(memberId)}/`,
    { method: 'PATCH', body: JSON.stringify({ role }) }
  )

export const removeCalendarMember = (
  calendarId: string,
  memberId: string
): Promise<void> =>
  fetchApi(
    `/calendars/${encodeURIComponent(calendarId)}/members/${encodeURIComponent(memberId)}/`,
    { method: 'DELETE' }
  ).then(() => undefined)

export const fetchCalendarShareLink = (
  id: string
): Promise<{ token: string; url: string }> =>
  fetchApi(`/calendars/${encodeURIComponent(id)}/share-link/`)

export const resetCalendarShareLink = (
  id: string
): Promise<{ token: string; url: string }> =>
  fetchApi(`/calendars/${encodeURIComponent(id)}/share-link/`, {
    method: 'POST',
  })

export const subscribeShareToken = (token: string): Promise<UnifiedCalendar> =>
  fetchApi(`/calendar-share/${encodeURIComponent(token)}/`, { method: 'POST' })

export const previewShareToken = (token: string): Promise<UnifiedCalendar> =>
  fetchApi(`/calendar-share/${encodeURIComponent(token)}/`)

export const createCalendarExport = (
  id: string,
  payload:
    | { range: 'today' | 'week' | 'month'; timezone: string }
    | { range: 'custom'; timezone: string; start: string; end: string }
): Promise<CalendarExportJob> =>
  fetchApi(`/calendars/${encodeURIComponent(id)}/exports/`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const fetchExternalCalendarAccounts = (): Promise<
  ExternalCalendarAccount[]
> => fetchApi('/external-calendar-accounts/')

export const authorizeExternalCalendar = (
  provider: 'google' | 'microsoft'
): Promise<{ authorization_url: string }> =>
  fetchApi('/external-calendar-accounts/authorize/', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  })

export const fetchProviderCalendars = (
  accountId: string
): Promise<ProviderCalendar[]> =>
  fetchApi(
    `/external-calendar-accounts/${encodeURIComponent(accountId)}/calendars/`
  )

export const selectProviderCalendars = (
  accountId: string,
  calendarIds: string[]
): Promise<ExternalCalendarAccount> =>
  fetchApi(
    `/external-calendar-accounts/${encodeURIComponent(accountId)}/calendars/`,
    { method: 'POST', body: JSON.stringify({ calendar_ids: calendarIds }) }
  )

export const syncExternalCalendarAccount = (accountId: string): Promise<void> =>
  fetchApi(
    `/external-calendar-accounts/${encodeURIComponent(accountId)}/sync/`,
    {
      method: 'POST',
    }
  ).then(() => undefined)

export const disconnectExternalCalendarAccount = (
  accountId: string
): Promise<void> =>
  fetchApi(`/external-calendar-accounts/${encodeURIComponent(accountId)}/`, {
    method: 'DELETE',
  }).then(() => undefined)
