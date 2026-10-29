import { describe, expect, it } from 'vitest'

import { parseSseFrames } from './useTaskEventStream'

describe('parseSseFrames', () => {
  it('parses ids, event types, comments and multiline data', () => {
    const parsed = parseSseFrames(
      ': ping\n\n' +
        'id: e1\nevent: task.updated\ndata: {"event_id":"e1",\n' +
        'data: "type":"task.updated"}\n\n' +
        'retry: 5000\n\n' +
        'id: e2\nevent: artifact.published\ndata: {"event_id":"e2"}\n\n'
    )
    expect(parsed.frames).toHaveLength(2)
    expect(parsed.frames[0]).toEqual({
      id: 'e1',
      event: 'task.updated',
      data: '{"event_id":"e1",\n"type":"task.updated"}',
    })
    expect(parsed.frames[1]).toEqual({
      id: 'e2',
      event: 'artifact.published',
      data: '{"event_id":"e2"}',
    })
    expect(parsed.rest).toBe('')
  })

  it('keeps an incomplete trailing frame for the next chunk', () => {
    const parsed = parseSseFrames(
      'id: e1\ndata: {"event_id":"e1"}\n\nid: e2\ndata:'
    )
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.rest).toBe('id: e2\ndata:')
  })
})
