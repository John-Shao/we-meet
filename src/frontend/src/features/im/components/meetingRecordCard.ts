/** 会议记录(纪要/实录)分享到聊天时携带的静态快照。 */
export interface MeetingRecordCardBody {
  v: 1
  record_id: string
  title: string
  /** 会议发生时间(ISO)。卡片上只作副标题,点开按 record_id 跳转。 */
  origin_at?: string | null
  scope?: 'record' | 'minutes'
}

export const buildMeetingRecordCardBody = (card: {
  recordId: string
  title: string
  originAt?: string | null
  scope?: 'record' | 'minutes'
}) =>
  JSON.stringify({
    v: 1,
    record_id: card.recordId,
    title: card.title,
    ...(card.scope ? { scope: card.scope } : {}),
    ...(card.originAt ? { origin_at: card.originAt } : {}),
  } satisfies MeetingRecordCardBody)

export const parseMeetingRecordCard = (
  raw: string
): MeetingRecordCardBody | null => {
  try {
    const value = JSON.parse(raw) as Partial<MeetingRecordCardBody>
    // record_id 是唯一的跳转依据,缺了这张卡就只剩标题可看 —— 按坏卡处理。
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.record_id !== 'string' ||
      !value.record_id ||
      typeof value.title !== 'string' ||
      (value.scope !== undefined &&
        value.scope !== 'record' &&
        value.scope !== 'minutes')
    )
      return null
    return {
      v: 1,
      record_id: value.record_id,
      title: value.title,
      origin_at: typeof value.origin_at === 'string' ? value.origin_at : null,
      ...(value.scope === 'record' || value.scope === 'minutes'
        ? { scope: value.scope }
        : {}),
    }
  } catch {
    return null
  }
}
