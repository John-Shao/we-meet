import { describe, expect, it } from 'vitest'
import {
  buildMeetingRecordCardBody,
  parseMeetingRecordCard,
} from './meetingRecordCard'

/**
 * 卡片契约:body 是**静态快照**,跨端只认 record_id / title / origin_at。
 * 与 doc-card/meeting-card 同一套规矩 —— 解析器对未知/坏 JSON 一律返回 null,
 * 让调用方降级成一句占位文案,而不是把裸 JSON 渲染出来。
 */
describe('meeting-record-card', () => {
  it('round-trips a shared record snapshot', () => {
    const body = buildMeetingRecordCardBody({
      recordId: '11111111-1111-4111-8111-111111111111',
      title: '产品设计评审',
      originAt: '2026-09-21T09:06:00Z',
    })
    expect(parseMeetingRecordCard(body)).toEqual({
      v: 1,
      record_id: '11111111-1111-4111-8111-111111111111',
      title: '产品设计评审',
      origin_at: '2026-09-21T09:06:00Z',
    })
  })

  it('omits the time when the record has none and parses the result as null-time', () => {
    const body = buildMeetingRecordCardBody({
      recordId: 'r',
      title: 'Imported audio',
      originAt: null,
    })
    expect(JSON.parse(body)).toEqual({
      v: 1,
      record_id: 'r',
      title: 'Imported audio',
    })
    expect(parseMeetingRecordCard(body)?.origin_at).toBeNull()
  })

  it('rejects a card without a record id instead of rendering it as text', () => {
    // 没有 record_id 就没有跳转目标 —— 这类卡只能降级,否则用户点开是空页。
    expect(parseMeetingRecordCard(JSON.stringify({ title: 'x' }))).toBeNull()
    expect(
      parseMeetingRecordCard(JSON.stringify({ record_id: '', title: 'x' }))
    ).toBeNull()
    expect(parseMeetingRecordCard('{ malformed')).toBeNull()
  })

  it('keeps a title that contains mention-like text', () => {
    // 卡片标题里的「@所有人」不是提及:mentions.ts 的 switch 不认这个 content_type。
    const card = parseMeetingRecordCard(
      buildMeetingRecordCardBody({ recordId: 'r', title: '@所有人 周会' })
    )
    expect(card?.title).toBe('@所有人 周会')
  })
})
