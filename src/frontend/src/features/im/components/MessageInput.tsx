import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

interface Props {
  onSend: (text: string) => Promise<void> | void
  disabled?: boolean
}

export const MessageInput = ({ onSend, disabled }: Props) => {
  const { t } = useTranslation('im')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)

  const submit = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || sending || disabled) return
    setSending(true)
    try {
      await onSend(trimmed)
      setText('')
    } catch {
      // sendText already surfaces transport errors; keep the draft so the user can retry.
    } finally {
      setSending(false)
    }
  }, [text, sending, disabled, onSend])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className={css({
        display: 'flex',
        gap: '0.5rem',
        padding: '0.75rem',
        borderTop: '1px solid token(colors.greyscale.200)',
      })}
    >
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('input.placeholder')}
        disabled={disabled || sending}
        className={css({
          flex: 1,
          paddingX: '0.75rem',
          paddingY: '0.5rem',
          border: '1px solid token(colors.greyscale.300)',
          borderRadius: '0.5rem',
          fontSize: '0.9375rem',
          _focus: { outline: 'none', borderColor: 'primary.500' },
        })}
        data-testid="im-msg-input"
      />
      <button
        type="submit"
        disabled={disabled || sending || !text.trim()}
        className={css({
          paddingX: '1rem',
          paddingY: '0.5rem',
          backgroundColor: 'primary.500',
          color: 'white',
          border: 'none',
          borderRadius: '0.5rem',
          cursor: 'pointer',
          fontWeight: '500',
          _disabled: { backgroundColor: 'greyscale.300', cursor: 'not-allowed' },
        })}
        data-testid="im-msg-send"
      >
        {sending ? t('input.sending') : t('input.send')}
      </button>
    </form>
  )
}
