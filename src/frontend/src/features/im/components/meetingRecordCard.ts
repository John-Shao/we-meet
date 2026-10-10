/** 会议记录(纪要/实录)分享到聊天时携带的静态快照。 */
export interface MeetingRecordCardBody {
  v: 1
  record_id: string
  title: string
  /** 会议发生时间(ISO)。卡片上只作副标题,点开按 record_id 跳转。 */
  origin_at?: string | null
  scope?: 'record' | 'minutes'
  summary_id?: string
  human_id?: string
}

export type MeetingRecordTarget = Pick<
  MeetingRecordCardBody,
  'record_id' | 'scope' | 'summary_id' | 'human_id'
>

/** A pinned selector is never discarded in favor of the latest minutes. */
export const meetingRecordLink = (card: MeetingRecordTarget) => {
  const query =
    card.human_id !== undefined
      ? `human=${encodeURIComponent(card.human_id)}`
      : card.summary_id !== undefined
        ? `summary=${encodeURIComponent(card.summary_id)}`
        : `tab=${card.scope === 'record' ? 'overview' : 'summary'}`
  return `/meeting/records/${encodeURIComponent(card.record_id)}?${query}`
}

export const buildMeetingRecordCardBody = (card: {
  recordId: string
  title: string
  originAt?: string | null
  scope?: 'record' | 'minutes'
  summaryId?: string
  humanId?: string
}) =>
  JSON.stringify({
    v: 1,
    record_id: card.recordId,
    title: card.title,
    ...(card.scope ? { scope: card.scope } : {}),
    ...(card.originAt ? { origin_at: card.originAt } : {}),
    ...(card.summaryId !== undefined ? { summary_id: card.summaryId } : {}),
    ...(card.humanId !== undefined ? { human_id: card.humanId } : {}),
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
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    if (
      (value.summary_id !== undefined &&
        (typeof value.summary_id !== 'string' ||
          !uuid.test(value.summary_id))) ||
      (value.human_id !== undefined &&
        (typeof value.human_id !== 'string' || !uuid.test(value.human_id))) ||
      (value.summary_id !== undefined && value.human_id !== undefined) ||
      ((value.summary_id !== undefined || value.human_id !== undefined) &&
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
      ...(value.summary_id !== undefined
        ? { summary_id: value.summary_id }
        : {}),
      ...(value.human_id !== undefined ? { human_id: value.human_id } : {}),
    }
  } catch {
    return null
  }
}
