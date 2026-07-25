/** Stable, forwardable meeting snapshot carried by an IM rich message. */
export interface MeetingCardBody {
  v: 1
  /** Optional: carried by the web sender; the App shares by slug only. Not
   *  required to render/join (navigation uses `slug`). */
  room_id: string
  slug: string
  title: string
  status: 'scheduled' | 'ongoing'
  scheduled_at?: string | null
}

export const buildMeetingCardBody = (card: MeetingCardBody) =>
  JSON.stringify(card)

export const parseMeetingCard = (raw: string): MeetingCardBody | null => {
  try {
    const value = JSON.parse(raw) as Partial<MeetingCardBody>
    // slug 是入会关键;room_id 可缺省(App 分享只带 slug)。
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.slug !== 'string' ||
      typeof value.title !== 'string'
    )
      return null
    return {
      v: 1,
      room_id: typeof value.room_id === 'string' ? value.room_id : '',
      slug: value.slug,
      title: value.title,
      status: value.status === 'scheduled' ? 'scheduled' : 'ongoing',
      scheduled_at:
        typeof value.scheduled_at === 'string' ? value.scheduled_at : null,
    }
  } catch {
    return null
  }
}
