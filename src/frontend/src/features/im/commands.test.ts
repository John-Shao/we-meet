import { describe, expect, it } from 'vitest'
import { matchCommands } from './commands'

describe('IM command registry', () => {
  it('accepts localized and English aliases', () => {
    expect(matchCommands('/日', 'group').map((item) => item.id)).toEqual(['schedule'])
    expect(matchCommands('/doc', 'direct').map((item) => item.id)).toEqual(['document'])
    expect(matchCommands('/meeting', 'group').map((item) => item.id)).toEqual(['meeting'])
  })

  it('only opens before the first space', () => {
    expect(matchCommands('普通文本', 'direct')).toEqual([])
    expect(matchCommands('/doc 参数', 'direct')).toEqual([])
  })

  it('keeps meeting out of the visual more panel', () => {
    const meeting = matchCommands('/meeting', 'group')[0]
    expect(meeting.visibleAt).toEqual(['header', 'slash'])
  })
})
