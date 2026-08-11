import type { CalendarEvent } from '@/features/calendar'

/** jusi-light-im 服务端注入消息的 SYSTEM 身份 uid(后端变更/取消卡的 sender)。 */
export const IM_SYSTEM_UID = '00000000-0000-0000-0000-000000000000'

/** P8 event-card 线上协议 v1(与 Android / 后端 calendar_im_notify 一致)。 */
export interface EventCardBody {
  v: number
  kind: 'created' | 'time_changed' | 'attendees_changed' | 'cancelled'
  event_id: string
  title: string
  /** ISO-8601 UTC;渲染端转本地。 */
  start: string
  end: string
  all_day?: boolean
  attendee_count?: number
  organizer_name?: string
  old_start?: string
  old_end?: string
  recurrence_scope?: 'one' | 'following' | 'all'
  /** 只随 kind=attendees_changed 出现,且为 0 时后端省略该键。 */
  added_count?: number
  removed_count?: number
}

/** 创建成功后由客户端组卡(created 卡只由客户端发,变更卡只由后端发)。 */
export const buildEventCardBody = (event: CalendarEvent): string =>
  JSON.stringify({
    v: 1,
    kind: 'created',
    event_id: event.id,
    title: event.title,
    start: event.start_at,
    end: event.end_at,
    all_day: event.all_day,
    // 以后端返回体为准 —— 跨组织 id 会被服务端静默丢弃,本地选择数会虚高。
    attendee_count: event.attendees.length,
    organizer_name: event.organizer?.full_name ?? '',
  } satisfies EventCardBody)

const KINDS = new Set([
  'created',
  'time_changed',
  'attendees_changed',
  'cancelled',
])
const RECURRENCE_SCOPES = new Set(['one', 'following', 'all'])

/** 宽容解析:缺 event_id → 不可点;kind 未知 → 按 created;整体坏 → null。 */
export const parseEventCard = (raw: string): EventCardBody | null => {
  try {
    const o = JSON.parse(raw) as Partial<EventCardBody>
    if (!o || typeof o !== 'object' || typeof o.title !== 'string') return null
    return {
      v: typeof o.v === 'number' ? o.v : 1,
      kind: KINDS.has(o.kind as string)
        ? (o.kind as EventCardBody['kind'])
        : 'created',
      event_id: typeof o.event_id === 'string' ? o.event_id : '',
      title: o.title,
      start: typeof o.start === 'string' ? o.start : '',
      end: typeof o.end === 'string' ? o.end : '',
      all_day: !!o.all_day,
      attendee_count:
        typeof o.attendee_count === 'number' ? o.attendee_count : undefined,
      organizer_name:
        typeof o.organizer_name === 'string' ? o.organizer_name : undefined,
      old_start: typeof o.old_start === 'string' ? o.old_start : undefined,
      old_end: typeof o.old_end === 'string' ? o.old_end : undefined,
      recurrence_scope: RECURRENCE_SCOPES.has(o.recurrence_scope as string)
        ? (o.recurrence_scope as EventCardBody['recurrence_scope'])
        : undefined,
      // 后端一直在发这两个键,而这里原本只声明了 added_count 且解析时漏拷,
      // removed_count 连类型都没有 —— 金标准 fixture 契约测试跑第一次就抓到了。
      added_count:
        typeof o.added_count === 'number' ? o.added_count : undefined,
      removed_count:
        typeof o.removed_count === 'number' ? o.removed_count : undefined,
    }
  } catch {
    return null
  }
}
