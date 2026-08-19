import { describe, expect, it } from 'vitest'

import { buildMeetingCardBody, parseMeetingCard } from './meetingCard'

describe('parseMeetingCard', () => {
  it('round-trips a full web-built card', () => {
    const body = buildMeetingCardBody({
      v: 1,
      room_id: 'r1',
      slug: '20801316',
      title: 'W008 的会议',
      status: 'scheduled',
      scheduled_at: '2026-07-25T01:00:00Z',
    })
    expect(parseMeetingCard(body)).toEqual({
      v: 1,
      room_id: 'r1',
      slug: '20801316',
      title: 'W008 的会议',
      status: 'scheduled',
      scheduled_at: '2026-07-25T01:00:00Z',
    })
  })

  it('accepts an App card that carries no room_id (slug-only)', () => {
    // App(ScheduledDetailScreen)分享只带 slug,不带 room_id——必须能解析,
    // 否则安卓分享到 Web 端渲染不出卡片。
    const card = parseMeetingCard(
      JSON.stringify({
        v: 1,
        slug: '20801316',
        title: 'W008 的会议',
        status: 'scheduled',
        scheduled_at: '2026-07-25T01:00:00Z',
      })
    )
    expect(card).not.toBeNull()
    expect(card?.room_id).toBe('')
    expect(card?.slug).toBe('20801316')
  })

  it('defaults an unknown status to ongoing and normalizes missing time', () => {
    const card = parseMeetingCard(
      JSON.stringify({ slug: 's', title: 't', status: 'weird' })
    )
    expect(card?.status).toBe('ongoing')
    expect(card?.scheduled_at).toBeNull()
  })

  it('returns null when the join key (slug) or title is missing', () => {
    expect(parseMeetingCard(JSON.stringify({ title: 't' }))).toBeNull()
    expect(parseMeetingCard(JSON.stringify({ slug: 's' }))).toBeNull()
    expect(parseMeetingCard('not json')).toBeNull()
  })
})
