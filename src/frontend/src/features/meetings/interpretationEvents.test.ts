import { describe, expect, it } from 'vitest'
import {
  decodeInterpretationEvent,
  interpretationDeadline,
  updateInterpretationRows,
  type InterpretationChannel,
  type InterpretationEvent,
  type InterpretationSubscription,
} from './interpretationEvents'

const channel: InterpretationChannel = {
  id: '11111111-1111-4111-8111-111111111111',
  generation: 1,
  target: 'en',
  state: 'translating',
  error_code: '',
}
const subscription: InterpretationSubscription = {
  id: '22222222-2222-4222-8222-222222222222',
  channel_id: channel.id,
  participation_id: '33333333-3333-4333-8333-333333333333',
  revision: 2,
  active: true,
  expires_at: '2026-09-13T00:00:20Z',
  remaining_lease_seconds: 10,
}
const event: InterpretationEvent = {
  type: 'target_final',
  channel_id: channel.id,
  generation: 1,
  target: 'en',
  subscription_id: subscription.id,
  subscription_revision: 2,
  source_participation_id: '44444444-4444-4444-8444-444444444444',
  source_participant_sid: 'PA_speaker',
  audio_track_sid: 'TR_voice',
  response_id: 'response',
  item_id: 'item',
  text: 'Hello',
}
const sender = {
  identity: `interpretation-${channel.id}-worker`,
  isAgent: true,
}
const payload = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value))

describe('Shared interpretation event fences', () => {
  it('accepts only the current generation, target and subscription revision', () => {
    expect(
      decodeInterpretationEvent(payload(event), sender, channel, subscription)
    ).toEqual(event)
    for (const changed of [
      { generation: 2 },
      { target: 'zh' },
      { subscription_revision: 1 },
      { subscription_id: channel.id },
      { channel_id: subscription.id },
    ])
      expect(
        decodeInterpretationEvent(
          payload({ ...event, ...changed }),
          sender,
          channel,
          subscription
        )
      ).toBeUndefined()
  })
  it('rejects human impersonation, a different Agent and an inactive subscription', () => {
    for (const from of [
      undefined,
      { ...sender, isAgent: false },
      { ...sender, identity: 'translation-other' },
    ]) {
      expect(
        decodeInterpretationEvent(payload(event), from, channel, subscription)
      ).toBeUndefined()
    }
    expect(
      decodeInterpretationEvent(payload(event), sender, channel, {
        ...subscription,
        active: false,
      })
    ).toBeUndefined()
    expect(
      decodeInterpretationEvent(
        payload(event),
        sender,
        { ...channel, state: 'stopped' },
        subscription
      )
    ).toBeUndefined()
  })
  it('rejects malformed identity, oversized packets and non-translation payloads', () => {
    for (const changed of [
      { audio_track_sid: null },
      { source_participation_id: 'unknown' },
      { source_participant_sid: 'agent' },
      { response_id: '' },
      { text: {} },
      { stash: false },
      { type: 'source_candidate' },
      { text: 'x'.repeat(14000) },
    ])
      expect(
        decodeInterpretationEvent(
          payload({ ...event, ...changed }),
          sender,
          channel,
          subscription
        )
      ).toBeUndefined()
    expect(
      decodeInterpretationEvent(
        new Uint8Array([255]),
        sender,
        channel,
        subscription
      )
    ).toBeUndefined()
  })
  it('keeps speaker rows separate and prevents provisional overwrites of final text', () => {
    const first = updateInterpretationRows([], event)
    expect(
      updateInterpretationRows(first, {
        ...event,
        type: 'target_candidate',
        text: 'older',
      })
    ).toEqual(first)
    expect(
      updateInterpretationRows(first, {
        ...event,
        source_participation_id: subscription.id,
      })
    ).toHaveLength(2)
    let rows = first
    for (let i = 0; i < 80; i++)
      rows = updateInterpretationRows(rows, { ...event, item_id: String(i) })
    expect(rows).toHaveLength(60)
  })
  it('bounds the local deadline independently of client wall-clock skew', () => {
    expect(interpretationDeadline(subscription, 1000)).toBe(11000)
    for (const seconds of [NaN, Infinity, 21, -1, 0]) {
      expect(
        interpretationDeadline(
          { ...subscription, remaining_lease_seconds: seconds },
          1000
        )
      ).toBe(0)
    }
    expect(
      interpretationDeadline({ ...subscription, active: false }, 1000)
    ).toBe(0)
  })
})
