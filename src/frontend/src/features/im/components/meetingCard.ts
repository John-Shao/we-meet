/** Stable, forwardable meeting snapshot carried by an IM rich message. */
export interface MeetingCardBody {
  v: 1
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
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.room_id !== 'string' ||
      typeof value.slug !== 'string' ||
      typeof value.title !== 'string'
    )
      return null
    return {
      v: 1,
      room_id: value.room_id,
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
