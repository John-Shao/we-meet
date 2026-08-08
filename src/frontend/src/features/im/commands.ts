import {
  RiCalendarScheduleLine,
  RiFileTextLine,
  RiVidiconLine,
} from '@remixicon/react'

export type ImCommandId = 'schedule' | 'document' | 'meeting'

export interface ImCommand {
  id: ImCommandId
  names: { zh: string; en: string }
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
      command.aliases.some((alias) => alias.toLocaleLowerCase().startsWith(query))
  )
}
