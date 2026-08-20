/** DTOs for the calendar / scheduling API (P2). Mirrors core/api/calendar.py. */

import type { MeetingRoomBrief } from '@/features/meeting-rooms'

export type { Paginated } from '@/api/Paginated'

export type RSVPStatus = 'needs_action' | 'accepted' | 'declined' | 'tentative'
export type AttendeeRole = 'required' | 'optional'
export type EventVisibility = 'default' | 'public' | 'private'

export interface AttendeeEntryInput {
  user_id: string
  role: AttendeeRole
}

export interface EventAttendee {
  id: string | null
  full_name: string | null
  email: string
  /** 短时效预签名头像 URL,'' = 未上传(字母色块兜底)。 */
  avatar_url?: string
  rsvp: RSVPStatus
  role: 'organizer' | 'required' | 'optional'
  /** True for an accepted external-contact account (legacy email rows too). */
  external?: boolean
}

export interface CalendarEvent {
  id: string
  title: string
  description: string
  location?: string
  attachment_names?: string[]
  /** ISO 8601 (UTC). */
  start_at: string
  end_at: string
  /** Canonical half-open civil-date range for all-day events. */
  start_date?: string | null
  end_date?: string | null
  timezone: string
  all_day: boolean
  status: string
  visibility: EventVisibility
  /** 私密日程被非参与人凭分享 id 打开时，详情字段已由服务端清空。 */
  details_redacted?: boolean
  calendar_ids?: string[]
  display_calendar_id?: string | null
  can_edit?: boolean
  can_delete?: boolean
  reminders: number[]
  organizer: {
    id: string
    full_name: string | null
    short_name?: string | null
    /** 短时效预签名头像 URL,'' = 未上传(字母色块兜底)。 */
    avatar_url?: string
  } | null
  /** Room id (join target) + slug; null when the event has no room. */
  room: string | null
  room_slug: string | null
  /**
   * P9 实体会议室 —— 与上面的 LiveKit `room` 无关。null = 未预订。
   * `booking_status === 'conflict'` 表示该场次没抢到房间(重复日程滚动物化
   * 时可能发生),会议照开,只是没订上会议室。
   */
  meeting_room: MeetingRoomBrief | null
  attendees: EventAttendee[]
  my_rsvp: RSVPStatus | null
  created_at: string
  /** P2-M1 重复日程:主事件带 RRULE 串;子场次为空串。 */
  recurrence: string
  /** 子场次指回主事件 id;主/单次事件为 null。 */
  recurrence_parent: string | null
}

export interface CreateEventPayload {
  title: string
  /** Target unified calendar; omitted for compatibility writes to the primary calendar. */
  calendar_id?: string
  /** Timed events use UTC instants; all-day events use start_date/end_date. */
  start_at?: string
  end_at?: string
  start_date?: string
  end_date?: string
  timezone?: string
  all_day?: boolean
  reminders?: number[]
  attendee_ids?: string[]
  attendee_entries?: AttendeeEntryInput[]
  visibility?: EventVisibility
  /** Marks an intentional edit so legacy default submissions cannot downgrade public. */
  visibility_explicit?: boolean
  description?: string
  location?: string
  attachment_names?: string[]
  /**
   * P2-M1: RRULE 串,空/缺省=单次。UNTIL 必须用「浮动本地时刻」(无 Z,如
   * `FREQ=WEEKLY;UNTIL=20261231T235959`)——后端按事件时区墙上钟展开,dateutil
   * 在 naive dtstart 下会拒绝带 Z 的 UTC 形式(400)。见 composeRRule。
   */
  recurrence?: string
  /**
   * P8:来源 IM 会话 cid(仅会话日历抽屉传)。写入后改时间/增删参会人/取消
   * 时后端向该会话推变更卡片;write_only,响应体不回读。
   */
  source_conversation_id?: string
  /**
   * P9 会议室 id。`''` = 不预订;字段缺省 = 不动既有预订。用空串而非 null
   * 表达「清空」,是为了和 Android 对齐(Moshi 不序列化 null)。
   */
  meeting_room_id?: string
  /** 重复日程占用策略:`strict`(默认,冲突即 409)/ `skip`(冲突场次标记)。 */
  booking_conflict_policy?: 'strict' | 'skip'
  /**
   * 是否随日程开一场视频会议(对标飞书「移除视频会议」)。缺省 = 开,与
   * 改动前行为一致;传 false 则只建日程,`room` / `room_slug` 为 null。
   */
  with_video_meeting?: boolean
}

/** P2-M2 重复日程编辑范围:仅此场次 / 此场次及以后 / 所有场次。 */
export type EditScope = 'one' | 'following' | 'all'

/**
 * PATCH payload for editing an event.
 *
 * P8 编辑增删参与者:`attendee_ids` 缺省 = 不动参与者(标量编辑);传列表 =
 * **全量同步**(新面孔补进、不在列表的移除并同步移出 Room,组织者恒保留)。
 * 重复日程的三选路径服务端会剔除该字段——编辑对话框仅对非重复日程展示
 * 参与者选择。
 */
export interface UpdateEventPayload {
  title?: string
  description?: string
  start_at?: string
  end_at?: string
  start_date?: string
  end_date?: string
  timezone?: string
  all_day?: boolean
  reminders?: number[]
  attendee_ids?: string[]
  attendee_entries?: AttendeeEntryInput[]
  visibility?: EventVisibility
  visibility_explicit?: boolean
  /** P2-M2:重复日程子场次的编辑范围;单次事件省略。 */
  edit_scope?: EditScope
  /** P9:`''` = 释放会议室;缺省 = 不动。见 CreateEventPayload 的说明。 */
  meeting_room_id?: string
  booking_conflict_policy?: 'strict' | 'skip'
  /**
   * 增删视频会议。**缺省 = 不动** —— 与创建时的「缺省 = 开」不同,否则任何
   * 一次标量编辑都会给本来没有会议的日程凭空补一个房间。
   * 移除只是解绑,房间本身保留(可能正在录制/有人在里面);重新添加会拿到
   * 一个新房间,会议号随之变化。重复日程的系列级编辑不支持该字段。
   */
  with_video_meeting?: boolean
}
