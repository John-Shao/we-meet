import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseDocCard } from './docCard'
import { parseEventCard } from './eventCard'
import { parseMeetingCard } from './meetingCard'
import { parseRichText, richTextPlain } from './richText'

/**
 * Contract test against the backend's golden card fixtures.
 *
 * These are the *same files* the backend asserts in
 * `core/tests/test_im_card_contract.py` and the Android suite parses. Reading
 * them here is what makes a protocol change impossible to land in one client
 * only: the fixture is committed, so the diff shows up in review and the other
 * two suites go red.
 */
const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../../../backend/core/tests/fixtures/im_cards',
)

const load = (name: string): string =>
  fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf-8')

describe('IM card golden fixtures', () => {
  it('fixture directory is reachable from the frontend', () => {
    // A silent path break would turn every assertion below into a no-op.
    expect(fs.existsSync(FIXTURE_DIR)).toBe(true)
    expect(fs.readdirSync(FIXTURE_DIR).length).toBeGreaterThan(0)
  })

  describe('event-card', () => {
    it('parses a created card', () => {
      const card = parseEventCard(load('event_card_created'))
      expect(card).not.toBeNull()
      expect(card?.kind).toBe('created')
      expect(card?.title).toBe('季度评审')
      expect(card?.attendee_count).toBe(4)
    })

    it('parses a time_changed card with the previous window', () => {
      const card = parseEventCard(load('event_card_time_changed'))
      expect(card?.kind).toBe('time_changed')
      expect(card?.old_start).toBe('2026-08-10T02:00:00+00:00')
      expect(card?.old_end).toBe('2026-08-10T03:00:00+00:00')
    })

    it('parses an attendees_changed card', () => {
      const card = parseEventCard(load('event_card_attendees_changed'))
      expect(card?.kind).toBe('attendees_changed')
      expect(card?.added_count).toBe(2)
    })

    it('parses a cancelled card', () => {
      expect(parseEventCard(load('event_card_cancelled'))?.kind).toBe(
        'cancelled',
      )
    })
  })

  describe('doc-card', () => {
    it('parses the shared document snapshot', () => {
      const card = parseDocCard(load('doc_card'))
      expect(card).not.toBeNull()
      expect(card?.title).toBe('产品需求文档')
      expect(card?.doc_id).toBe('22222222-2222-4222-8222-222222222222')
      expect(card?.url).toContain('/docs/')
    })
  })

  describe('meeting-card', () => {
    it('parses an ongoing meeting', () => {
      const card = parseMeetingCard(load('meeting_card_ongoing'))
      expect(card?.status).toBe('ongoing')
      expect(card?.slug).toBe('team-standup')
    })

    it('parses a scheduled meeting with its start time', () => {
      const card = parseMeetingCard(load('meeting_card_scheduled'))
      expect(card?.status).toBe('scheduled')
      expect(card?.scheduled_at).toBe('2026-08-10T02:00:00+00:00')
    })
  })

  describe('rich-text', () => {
    it('parses a single-paragraph body', () => {
      const body = parseRichText(load('rich_text_simple'))
      expect(body?.title).toBe('部署完成')
      expect(body?.content).toHaveLength(1)
      expect(body?.content[0][0]).toEqual({
        tag: 'text',
        text: '生产环境已更新到 v1.2.0',
      })
    })

    it('parses every tag a bot can send', () => {
      const body = parseRichText(load('rich_text_full'))
      expect(body?.title).toBe('构建失败')
      expect(body?.content[0][1]).toEqual({
        tag: 'a',
        text: '查看日志',
        href: 'https://ci.example.com/runs/1',
      })
      expect(body?.content[1][0]).toEqual({
        tag: 'at',
        uid: 'all',
        name: '所有人',
      })
      // Images degrade server-side; the client only ever sees the placeholder.
      expect(body?.content[2][0]).toEqual({ tag: 'text', text: '[图片]' })
    })

    it('carries the server-derived plain projection', () => {
      const body = parseRichText(load('rich_text_full'))
      // Not rendered — it backs the conversation preview, full-text search and
      // the substring-based "@我" check.
      expect(body?.plain).toContain('@所有人')
      expect(richTextPlain(body!)).toContain('构建失败')
    })
  })
})
