import {
  RiCalendarScheduleLine,
  RiFileTextLine,
  RiPhoneLine,
  RiVidiconLine,
} from '@remixicon/react'

export type ImCommandId =
  | 'schedule'
  | 'document'
  | 'voice-call'
  | 'voice-meeting'
  | 'meeting'

export interface ImCommand {
  id: ImCommandId
  names: { zh: string; en: string; de?: string; fr?: string; nl?: string }
  aliases: string[]
  icon: typeof RiCalendarScheduleLine
  conversations: Array<'direct' | 'group'>
  action: ImCommandId
  visibleAt: Array<'more' | 'header' | 'slash'>
}

export const IM_COMMANDS: ImCommand[] = [
  {
    id: 'schedule',
    names: { zh: '日程', en: 'Schedule' },
    aliases: ['日程', 'schedule'],
    icon: RiCalendarScheduleLine,
    conversations: ['direct', 'group'],
    action: 'schedule',
    visibleAt: ['more', 'slash'],
  },
  {
    id: 'document',
    names: { zh: '文档', en: 'Document' },
    aliases: ['文档', 'doc'],
    icon: RiFileTextLine,
    conversations: ['direct', 'group'],
    action: 'document',
    visibleAt: ['more', 'slash'],
  },
  {
    id: 'voice-call',
    names: {
      zh: '语音通话',
      en: 'Voice call',
      de: 'Sprachanruf',
      fr: 'Appel vocal',
      nl: 'Spraakoproep',
    },
    aliases: [
      '语音通话',
      'voice',
      'call',
      'Sprachanruf',
      'Appel vocal',
      'Spraakoproep',
    ],
    icon: RiPhoneLine,
    conversations: ['direct'],
    action: 'voice-call',
    visibleAt: ['header', 'slash'],
  },
  {
    id: 'voice-meeting',
    names: {
      zh: '语音会议',
      en: 'Voice meeting',
      de: 'Audiokonferenz',
      fr: 'Réunion audio',
      nl: 'Audiovergadering',
    },
    aliases: [
      '语音会议',
      'voice',
      'call',
      'Audiokonferenz',
      'Réunion audio',
      'Audiovergadering',
    ],
    icon: RiPhoneLine,
    conversations: ['group'],
    action: 'voice-meeting',
    visibleAt: ['header', 'slash'],
  },
  {
    id: 'meeting',
    names: { zh: '会议', en: 'Meeting' },
    aliases: ['会议', 'meeting'],
    icon: RiVidiconLine,
    conversations: ['direct', 'group'],
    action: 'meeting',
    visibleAt: ['header', 'slash'],
  },
]

export const matchCommands = (text: string, type: 'direct' | 'group') => {
  if (!text.startsWith('/') || /\s/.test(text)) return []
  const query = text.slice(1).toLocaleLowerCase()
  return IM_COMMANDS.filter(
    (command) =>
      command.conversations.includes(type) &&
      command.aliases.some((alias) =>
        alias.toLocaleLowerCase().startsWith(query)
      )
  )
}
