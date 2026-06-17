import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Client } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

import { MessageInput } from '../components/MessageInput'
import { MessageItem } from '../components/MessageItem'
import { useMessages } from '../hooks/useMessages'

interface Props {
  client: Client
  cid: string
  currentUserUID: string
  sendDisabled: boolean
}

export const ChatPane = ({ client, cid, currentUserUID, sendDisabled }: Props) => {
  const { t } = useTranslation('im')
  const { data: messages = [], isLoading } = useMessages(client, cid)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll on new message.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages.length])

  // Mark the latest seq read whenever we render a non-empty view.
  useEffect(() => {
    if (messages.length === 0) return
    const latest = messages[messages.length - 1]
    if (latest && latest.seq > 0) {
      void client.markRead(cid, latest.seq).catch(() => {
        // best-effort; the marker will catch up on the next render
      })
    }
  }, [client, cid, messages])

  const onSend = async (text: string) => {
    await client.sendText(cid, text)
  }

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        height: '100%',
      })}
    >
      <div
        ref={scrollRef}
        className={css({
          flex: 1,
          overflowY: 'auto',
          paddingY: '0.5rem',
        })}
      >
        {isLoading ? (
          <div className={css({ padding: '1rem', color: 'greyscale.500' })}>
            {t('chat.loading')}
          </div>
        ) : messages.length === 0 ? (
          <div className={css({ padding: '1rem', color: 'greyscale.500' })}>
            {t('chat.empty')}
          </div>
        ) : (
          messages.map((m) => (
            <MessageItem key={m.mid} message={m} isOwn={m.sender_uid === currentUserUID} />
          ))
        )}
      </div>
      <MessageInput onSend={onSend} disabled={sendDisabled} />
    </div>
  )
}
