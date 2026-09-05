import type { Message } from '@jusi/light-im-sdk'

import type { CreateTaskPayload } from '@/features/tasks/api/ApiTask'

import { parseRichText, richTextPlain } from './richText'

const DESCRIPTION_LIMIT = 5000
const SUPPORTED_TYPES = new Set(['text', 'rich-text', 'quote'])

/** Return the complete readable message text used to seed a task description. */
export const messageTaskDescription = (message: Message): string | null => {
  if (message.recalled || !SUPPORTED_TYPES.has(message.content_type))
    return null

  let value = ''
  if (message.content_type === 'text') {
    value = message.body
  } else if (message.content_type === 'rich-text') {
    const richText = parseRichText(message.body)
    value = richText ? richText.plain || richTextPlain(richText) : ''
  } else {
    try {
      const parsed = JSON.parse(message.body) as { text?: unknown }
      value = typeof parsed.text === 'string' ? parsed.text : ''
    } catch {
      return null
    }
  }

  const description = value.trim().slice(0, DESCRIPTION_LIMIT)
  return description || null
}

export const messageTaskSource = (
  message: Message,
  snapshot: string
): NonNullable<CreateTaskPayload['source_message']> => ({
  cid: message.cid,
  mid: String(message.mid),
  seq: message.seq,
  sender_uid: message.sender_uid,
  sent_at: message.ts,
  content_type: message.content_type as 'text' | 'rich-text' | 'quote',
  snapshot,
})
