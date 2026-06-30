import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RiImageLine } from '@remixicon/react'

import { css } from '@/styled-system/css'

interface Props {
  onSend: (text: string) => Promise<void> | void
  disabled?: boolean
  /** Names suggested after typing "@" (group chats). Empty/undefined disables @-mention. */
  mentionables?: string[]
  /** Send a picked image file (P7). Omitted → no image button. */
  onSendImage?: (file: File) => Promise<void> | void
}

/** Find the active "@query" segment immediately before the caret, if any. */
const activeMention = (
  text: string,
  caret: number,
): { at: number; query: string } | null => {
  let i = caret - 1
  while (i >= 0 && text[i] !== '@' && !/\s/.test(text[i])) i--
  if (i >= 0 && text[i] === '@' && (i === 0 || /\s/.test(text[i - 1]))) {
    return { at: i, query: text.slice(i + 1, caret) }
  }
  return null
}

export const MessageInput = ({
  onSend,
  disabled,
  mentionables = [],
  onSendImage,
}: Props) => {
  const { t } = useTranslation('im')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [mention, setMention] = useState<{ at: number; query: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file || !onSendImage || uploading) return
    setUploading(true)
    try {
      await onSendImage(file)
    } finally {
      setUploading(false)
    }
  }

  const recomputeMention = (value: string, caret: number) => {
    if (mentionables.length === 0) {
      setMention(null)
      return
    }
    setMention(activeMention(value, caret))
  }

  const suggestions =
    mention === null
      ? []
      : mentionables
          .filter((n) => n.toLowerCase().includes(mention.query.toLowerCase()))
          .slice(0, 8)

  const pick = (name: string) => {
    if (!mention) return
    const caret = inputRef.current?.selectionStart ?? text.length
    const before = text.slice(0, mention.at)
    const after = text.slice(caret)
    const inserted = `@${name} `
    const next = before + inserted + after
    setText(next)
    setMention(null)
    const pos = (before + inserted).length
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    })
  }

  const submit = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || sending || disabled) return
    setSending(true)
    try {
      await onSend(trimmed)
      setText('')
      setMention(null)
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
        position: 'relative',
        display: 'flex',
        gap: '0.5rem',
        padding: '0.75rem',
        borderTop: '1px solid token(colors.greyscale.200)',
      })}
    >
      {suggestions.length > 0 && (
        <ul
          className={css({
            position: 'absolute',
            bottom: '100%',
            left: '0.75rem',
            marginBottom: '0.25rem',
            minWidth: '12rem',
            maxHeight: '12rem',
            overflowY: 'auto',
            listStyle: 'none',
            margin: 0,
            padding: '0.25rem',
            backgroundColor: 'white',
            border: '1px solid token(colors.greyscale.200)',
            borderRadius: '0.5rem',
            boxShadow: '0 6px 24px rgba(0,0,0,0.15)',
            zIndex: 10,
          })}
        >
          {suggestions.map((name) => (
            <li key={name}>
              <button
                type="button"
                onMouseDown={(e) => {
                  // mousedown (not click) so the input doesn't blur first.
                  e.preventDefault()
                  pick(name)
                }}
                data-testid={`mention-opt-${name}`}
                className={css({
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  paddingX: '0.5rem',
                  paddingY: '0.375rem',
                  border: 'none',
                  background: 'transparent',
                  borderRadius: '0.375rem',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  color: 'greyscale.900',
                  _hover: { backgroundColor: 'greyscale.100' },
                })}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {onSendImage && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={onPickFile}
            className={css({ display: 'none' })}
            data-testid="im-image-input"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled || uploading}
            aria-label={t('input.image')}
            title={t('input.image')}
            data-testid="im-image-btn"
            className={css({
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '2.375rem',
              border: '1px solid token(colors.greyscale.300)',
              borderRadius: '0.5rem',
              backgroundColor: 'white',
              color: 'greyscale.600',
              cursor: 'pointer',
              _hover: { backgroundColor: 'greyscale.100' },
              _disabled: { opacity: 0.5, cursor: 'not-allowed' },
            })}
          >
            <RiImageLine size={18} />
          </button>
        </>
      )}
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          recomputeMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
        }}
        onKeyUp={(e) => {
          if (e.key === 'Escape') {
            setMention(null)
            return
          }
          const el = e.currentTarget
          recomputeMention(el.value, el.selectionStart ?? el.value.length)
        }}
        onClick={(e) => recomputeMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
        onBlur={() => setMention(null)}
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
