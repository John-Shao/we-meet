import { describe, expect, it } from 'vitest'
import { matchCommands } from './commands'

describe('IM command registry', () => {
  it('accepts localized and English aliases', () => {
    expect(matchCommands('/日程', 'group').map((item) => item.id)).toEqual([
      'schedule',
    ])
    expect(matchCommands('/doc', 'direct').map((item) => item.id)).toEqual([
      'document',
    ])
    expect(matchCommands('/meeting', 'direct').map((item) => item.id)).toEqual([
      'video-call',
    ])
    expect(matchCommands('/meeting', 'group').map((item) => item.id)).toEqual([
      'video-meeting',
    ])
    expect(matchCommands('/voice', 'direct').map((item) => item.id)).toEqual([
      'voice-call',
    ])
    expect(matchCommands('/voice', 'group').map((item) => item.id)).toEqual([
      'voice-meeting',
    ])
  })

  it('only opens before the first space', () => {
    expect(matchCommands('普通文本', 'direct')).toEqual([])
    expect(matchCommands('/doc 参数', 'direct')).toEqual([])
  })

  it('keeps calls out of the visual more panel', () => {
    const voice = matchCommands('/voice', 'group')[0]
    const video = matchCommands('/meeting', 'group')[0]
    expect(voice.visibleAt).toEqual(['header', 'slash'])
    expect(video.visibleAt).toEqual(['header', 'slash'])
  })

  it('uses conversation-specific call labels and canonical hints', () => {
    const directCommands = matchCommands('/', 'direct')
    const groupCommands = matchCommands('/', 'group')

    const directVoice = directCommands.find((item) => item.id === 'voice-call')
    const groupVoice = groupCommands.find((item) => item.id === 'voice-meeting')
    const directVideo = directCommands.find((item) => item.id === 'video-call')
    const groupVideo = groupCommands.find((item) => item.id === 'video-meeting')

    expect(directVoice?.names.zh).toBe('语音通话')
    expect(groupVoice?.names.zh).toBe('语音会议')
    expect(directVideo?.names.zh).toBe('视频通话')
    expect(groupVideo?.names.zh).toBe('视频会议')
    expect(directVoice?.shortcut).toBe('voice')
    expect(groupVoice?.shortcut).toBe('voice')
    expect(directVideo?.shortcut).toBe('meeting')
    expect(groupVideo?.shortcut).toBe('meeting')
  })
})
