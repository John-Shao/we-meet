import { Track } from 'livekit-client'
import Source = Track.Source

export type ApiLiveKit = {
  url: string
  room: string
  token: string
}

export enum ApiAccessLevel {
  PUBLIC = 'public',
  TRUSTED = 'trusted',
  RESTRICTED = 'restricted',
}

export type RoomConfiguration = {
  can_publish_sources?: Source[] | null
  everyone_can_mute?: boolean | null
}

export type ApiRoom = {
  id: string
  name: string
  slug: string
  pin_code: string
  /** admin 或 owner —— 可改房间配置。 */
  is_administrable: boolean
  /** 严格房主。删除房间只认这个(admin 删会 403),收敛删除入口须用它。 */
  is_owner?: boolean
  /**
   * 关联日程 id;无日程(快速会议/存量裸预约)= null。
   * 「预约会议 = 创建日程」后同一场会既在会议列表又在日历,客户端据此把
   * 详情统一收敛到日程详情,避免一场会两个详情页。
   */
  event_id?: string | null
  access_level: ApiAccessLevel
  livekit?: ApiLiveKit
  configuration?: RoomConfiguration
  // ISO timestamp set when the owner ended the room; empty string while still open.
  closed_at?: string
  // ISO 8601 timestamp for the host's intended start time, or null when
  // the room wasn't scheduled. Informational only — the room is reachable
  // at any time; UIs surface this as "scheduled for X".
  scheduled_at?: string | null
}
