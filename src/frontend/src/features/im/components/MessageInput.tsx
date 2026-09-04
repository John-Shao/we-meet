import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiImageLine,
  RiAttachment2,
  RiFileTextLine,
  RiCloseLine,
  RiEmotionHappyLine,
  RiAddLine,
  RiCalendarScheduleLine,
} from '@remixicon/react'

import { Button, IconButton } from '@/primitives'
import { css } from '@/styled-system/css'
import { EmojiPicker } from './EmojiPicker'
import { CHAT_IMAGE_ALLOWED_TYPES } from '../api/uploadChatImage'
import type { CustomEmoji, RecentEmoji } from '../api/inputSync'
import { matchCommands, type ImCommandId } from '../commands'

/** Quoted-message preview shown above the input while composing a reply. */
export interface ReplyPreview {
  mid: string
  sender: string
  snippet: string
}

interface Props {
  onSend: (text: string) => Promise<void> | void
  disabled?: boolean
  /** Names suggested after typing "@" (group chats). Empty/undefined disables @-mention. */
  mentionables?: string[]
  /** Send a picked image file (P7). Omitted → no image button. */
  onSendImage?: (file: File) => Promise<void> | void
  /** Send a picked arbitrary file (P7-b). Omitted → no file button. */
  onSendFile?: (file: File) => Promise<void> | void
  /** Open the "share document" picker. Omitted → no doc button. */
  onSendDoc?: () => void
  /** Active reply context (P7-b); shows a quote bar above the input. */
  reply?: ReplyPreview | null
  onCancelReply?: () => void
  initialText?: string
  onDraftChange?: (text: string) => void
  recentEmojis?: RecentEmoji[]
  customEmojis?: CustomEmoji[]
  onRecentEmoji?: (emoji: RecentEmoji) => void
  onSendCustomEmoji?: (emoji: CustomEmoji) => Promise<void> | void
  conversationType?: 'direct' | 'group'
  onCommand?: (command: ImCommandId) => void
}

/** Find the active "@query" segment immediately before the caret, if any. */
const activeMention = (
  text: string,
  caret: number
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
  onSendFile,
  onSendDoc,
  reply,
  onCancelReply,
  initialText = '',
  onDraftChange,
  recentEmojis = [],
  customEmojis = [],
  onRecentEmoji,
  onSendCustomEmoji,
  conversationType = 'direct',
  onCommand,
}: Props) => {
  const { t, i18n } = useTranslation('im')
  const [text, setText] = useState(initialText)
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(true)
  const [mention, setMention] = useState<{ at: number; query: string } | null>(
    null
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const attachRef = useRef<HTMLInputElement>(null)
  const emojiRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const commandMenuRef = useRef<HTMLUListElement>(null)
  const dragDepthRef = useRef(0)

  useEffect(() => {
    setText(initialText)
  }, [initialText])

  useEffect(() => {
    setCommandMenuDismissed(true)
  }, [conversationType])

  const sendFiles = async (files: File[]) => {
    if (files.length === 0 || uploading) return
    setUploading(true)
    try {
      for (const file of files) {
        if (
          CHAT_IMAGE_ALLOWED_TYPES.includes(file.type as never) &&
          onSendImage
        ) {
          await onSendImage(file)
        } else if (onSendFile) {
          await onSendFile(file)
        }
      }
    } finally {
      setUploading(false)
    }
  }

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // allow re-picking the same file
    if (!onSendImage) return
    await sendFiles(files)
  }

  const onPickAttachment = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !onSendFile) return
    await sendFiles([file])
  }

  // Close the composer emoji panel on outside click.
  useEffect(() => {
    if (!showEmojiPicker) return
    const close = (event: MouseEvent) => {
      if (!emojiRef.current?.contains(event.target as Node)) {
        setShowEmojiPicker(false)
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [showEmojiPicker])

  // The desktop "+" menu behaves like a popover: outside click and Escape
  // both dismiss it, while interactions inside (including file inputs) remain intact.
  useEffect(() => {
    if (!showMore) return
    const closeOnOutside = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setShowMore(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowMore(false)
    }
    window.addEventListener('mousedown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [showMore])

  const insertEmoji = (emoji: string) => {
    const input = inputRef.current
    const start = input?.selectionStart ?? text.length
    const end = input?.selectionEnd ?? start
    const next = text.slice(0, start) + emoji + text.slice(end)
    setText(next)
    onDraftChange?.(next)
    onRecentEmoji?.({ kind: 'unicode', value: emoji })
    setShowEmojiPicker(false)
    requestAnimationFrame(() => {
      const caret = start + emoji.length
      input?.focus()
      input?.setSelectionRange(caret, caret)
    })
  }

  const commands = matchCommands(text, conversationType)
  const commandMenuOpen = commands.length > 0 && !commandMenuDismissed

  useEffect(() => {
    if (!commandMenuOpen) return
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        !commandMenuRef.current?.contains(target) &&
        !inputRef.current?.contains(target)
      ) {
        setCommandMenuDismissed(true)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCommandMenuDismissed(true)
    }
    window.addEventListener('mousedown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [commandMenuOpen])

  const executeCommand = (id: ImCommandId) => {
    setShowMore(false)
    setCommandMenuDismissed(true)
    setText('')
    onDraftChange?.('')
    setCommandIndex(0)
    onCommand?.(id)
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
    if (!trimmed || sending || disabled || commandMenuOpen) return
    setSending(true)
    try {
      await onSend(trimmed)
      setText('')
      onDraftChange?.('')
      setMention(null)
    } catch {
      // sendText already surfaces transport errors; keep the draft so the user can retry.
    } finally {
      setSending(false)
    }
  }, [text, sending, disabled, commandMenuOpen, onSend, onDraftChange])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className={css({
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        padding: '0.75rem',
        borderTop: '1px solid token(colors.greyscale.200)',
      })}
      onPaste={(event) => {
        if (disabled || uploading || !onSendImage) return
        const screenshots = Array.from(event.clipboardData.files).filter(
          (file) => CHAT_IMAGE_ALLOWED_TYPES.includes(file.type as never)
        )
        if (screenshots.length === 0) return
        event.preventDefault()
        void sendFiles(screenshots)
      }}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepthRef.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        dragDepthRef.current = 0
        setDragging(false)
        if (disabled || uploading) return
        void sendFiles(Array.from(event.dataTransfer.files))
      }}
    >
      {dragging && (
        <div
          className={css({
            position: 'absolute',
            inset: 0,
            zIndex: 'popover',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px dashed token(colors.primary.500)',
            borderRadius: '0.5rem',
            backgroundColor: 'greyscale.000',
            color: 'primary.700',
            fontWeight: '600',
            pointerEvents: 'none',
          })}
          data-testid="im-drop-overlay"
        >
          {t('input.dropHint')}
        </div>
      )}
      {reply && (
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            paddingX: '0.625rem',
            paddingY: '0.375rem',
            backgroundColor: 'greyscale.100',
            borderRadius: '0.5rem',
            fontSize: '0.8125rem',
            color: 'greyscale.600',
          })}
          data-testid="im-reply-bar"
        >
          <span
            className={css({
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            })}
          >
            <span className={css({ fontWeight: '600' })}>
              {t('quote.replyTo', { name: reply.sender })}
            </span>{' '}
            {reply.snippet}
          </span>
          <IconButton
            label={t('quote.cancel')}
            size="icon24"
            onPress={onCancelReply}
            className={css({ flexShrink: 0 })}
          >
            <RiCloseLine size={16} aria-hidden="true" />
          </IconButton>
        </div>
      )}
      <div
        className={css({
          position: 'relative',
          display: 'flex',
          gap: '0.5rem',
        })}
      >
        {commandMenuOpen && (
          <ul
            ref={commandMenuRef}
            className={css({
              position: 'absolute',
              bottom: '100%',
              left: '0.75rem',
              marginBottom: '0.25rem',
              minWidth: '14rem',
              listStyle: 'none',
              margin: 0,
              padding: '0.25rem',
              backgroundColor: 'greyscale.000',
              border: '1px solid token(colors.greyscale.200)',
              borderRadius: '0.5rem',
              boxShadow: 'overlay',
              zIndex: 'docked',
            })}
            data-testid="im-command-menu"
          >
            {commands.map((command, index) => {
              const Icon = command.icon
              return (
                <li key={command.id}>
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault()
                      executeCommand(command.id)
                    }}
                    className={css({
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      width: '100%',
                      padding: '0.5rem',
                      border: 'none',
                      borderRadius: '0.375rem',
                      backgroundColor:
                        index === commandIndex
                          ? 'greyscale.100'
                          : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                    })}
                  >
                    <Icon size={18} />
                    <span>
                      {command.names[
                        i18n.language.split(
                          '-'
                        )[0] as keyof typeof command.names
                      ] ?? command.names.en}
                    </span>
                    <span
                      className={css({
                        marginLeft: 'auto',
                        color: 'greyscale.500',
                        fontSize: '0.75rem',
                      })}
                    >
                      /{command.shortcut}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
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
              backgroundColor: 'greyscale.000',
              border: '1px solid token(colors.greyscale.200)',
              borderRadius: '0.5rem',
              boxShadow: 'overlay',
              zIndex: 'docked',
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
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            onChange={onPickImage}
            className={css({ display: 'none' })}
            data-testid="im-image-input"
          />
        )}
        {onSendFile && (
          <input
            ref={attachRef}
            type="file"
            onChange={onPickAttachment}
            className={css({ display: 'none' })}
            data-testid="im-file-input"
          />
        )}
        <div
          ref={moreRef}
          className={css({ position: 'relative', flexShrink: 0 })}
        >
          <IconButton
            label={t('input.more', { defaultValue: '更多' })}
            size="icon32"
            variant="secondary"
            onPress={() => {
              setShowEmojiPicker(false)
              setShowMore((open) => !open)
            }}
            aria-expanded={showMore}
            aria-haspopup="menu"
            data-testid="im-more-btn"
          >
            <RiAddLine size={20} aria-hidden="true" />
          </IconButton>
          {showMore && (
            <div
              role="menu"
              aria-label={t('input.more', { defaultValue: '更多' })}
              data-testid="im-more-menu"
              className={css({
                position: 'absolute',
                bottom: 'calc(100% + 0.5rem)',
                left: 0,
                display: 'flex',
                flexDirection: 'column',
                minWidth: '11rem',
                padding: '0.375rem',
                zIndex: 'popover',
                border: '1px solid token(colors.greyscale.200)',
                borderRadius: '0.625rem',
                backgroundColor: 'greyscale.000',
                boxShadow: 'overlay',
              })}
            >
              {onSendImage && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowMore(false)
                    fileRef.current?.click()
                  }}
                  disabled={disabled || uploading}
                  aria-label={t('input.image')}
                  title={t('input.image')}
                  data-testid="im-image-btn"
                  className={css({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    width: '100%',
                    paddingX: '0.75rem',
                    paddingY: '0.625rem',
                    border: 'none',
                    borderRadius: '0.375rem',
                    backgroundColor: 'transparent',
                    color: 'greyscale.600',
                    cursor: 'pointer',
                    _hover: { backgroundColor: 'greyscale.100' },
                    _disabled: { opacity: 0.5, cursor: 'not-allowed' },
                  })}
                >
                  <RiImageLine size={18} />
                  <span>{t('input.image')}</span>
                </button>
              )}
              {onSendFile && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowMore(false)
                    attachRef.current?.click()
                  }}
                  disabled={disabled || uploading}
                  aria-label={t('input.file')}
                  title={t('input.file')}
                  data-testid="im-file-btn"
                  className={css({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    width: '100%',
                    paddingX: '0.75rem',
                    paddingY: '0.625rem',
                    border: 'none',
                    borderRadius: '0.375rem',
                    backgroundColor: 'transparent',
                    color: 'greyscale.600',
                    cursor: 'pointer',
                    _hover: { backgroundColor: 'greyscale.100' },
                    _disabled: { opacity: 0.5, cursor: 'not-allowed' },
                  })}
                >
                  <RiAttachment2 size={18} />
                  <span>{t('input.file')}</span>
                </button>
              )}
              {onSendDoc && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowMore(false)
                    onSendDoc()
                  }}
                  disabled={disabled || uploading}
                  aria-label={t('input.doc')}
                  title={t('input.doc')}
                  data-testid="im-doc-btn"
                  className={css({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    width: '100%',
                    paddingX: '0.75rem',
                    paddingY: '0.625rem',
                    border: 'none',
                    borderRadius: '0.375rem',
                    backgroundColor: 'transparent',
                    color: 'greyscale.600',
                    cursor: 'pointer',
                    _hover: { backgroundColor: 'greyscale.100' },
                    _disabled: { opacity: 0.5, cursor: 'not-allowed' },
                  })}
                >
                  <RiFileTextLine size={18} />
                  <span>{t('input.doc')}</span>
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setShowMore(false)
                  executeCommand('schedule')
                }}
                aria-label={t('input.schedule')}
                title={t('input.schedule')}
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  width: '100%',
                  paddingX: '0.75rem',
                  paddingY: '0.625rem',
                  border: 'none',
                  borderRadius: '0.375rem',
                  backgroundColor: 'transparent',
                  color: 'greyscale.600',
                  cursor: 'pointer',
                  _hover: { backgroundColor: 'greyscale.100' },
                })}
              >
                <RiCalendarScheduleLine size={18} />
                <span>{t('input.schedule')}</span>
              </button>
            </div>
          )}
        </div>
        <div
          ref={emojiRef}
          className={css({ position: 'relative', flexShrink: 0 })}
        >
          <IconButton
            label={t('input.emoji')}
            size="icon32"
            variant="secondary"
            onPress={() => {
              setShowMore(false)
              setShowEmojiPicker((open) => !open)
            }}
            isDisabled={disabled || sending}
            aria-expanded={showEmojiPicker}
            data-testid="im-emoji-btn"
          >
            <RiEmotionHappyLine size={18} aria-hidden="true" />
          </IconButton>
          {showEmojiPicker && (
            <div
              className={css({
                position: 'absolute',
                bottom: 'calc(100% + 0.5rem)',
                left: 0,
                zIndex: 'popover',
                padding: '0.25rem',
                border: '1px solid token(colors.greyscale.200)',
                borderRadius: '0.5rem',
                backgroundColor: 'greyscale.000',
                boxShadow: 'overlay',
              })}
            >
              <EmojiPicker
                onPick={insertEmoji}
                recent={recentEmojis}
                custom={customEmojis}
                onPickCustom={async (emoji) => {
                  setShowEmojiPicker(false)
                  onRecentEmoji?.({
                    kind: 'custom',
                    id: emoji.id,
                    key: emoji.key,
                    name: emoji.name,
                  })
                  await onSendCustomEmoji?.(emoji)
                }}
              />
            </div>
          )}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            onDraftChange?.(e.target.value)
            setCommandIndex(0)
            setCommandMenuDismissed(false)
            recomputeMention(
              e.target.value,
              e.target.selectionStart ?? e.target.value.length
            )
          }}
          onKeyDown={(e) => {
            if (!commandMenuOpen) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCommandIndex((value) => (value + 1) % commands.length)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCommandIndex(
                (value) => (value - 1 + commands.length) % commands.length
              )
            } else if (e.key === 'Enter') {
              e.preventDefault()
              executeCommand(
                commands[Math.min(commandIndex, commands.length - 1)].id
              )
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setCommandMenuDismissed(true)
            }
          }}
          onKeyUp={(e) => {
            if (e.key === 'Escape') {
              setMention(null)
              return
            }
            const el = e.currentTarget
            recomputeMention(el.value, el.selectionStart ?? el.value.length)
          }}
          onFocus={() => setCommandMenuDismissed(false)}
          onClick={(e) => {
            setCommandMenuDismissed(false)
            recomputeMention(
              e.currentTarget.value,
              e.currentTarget.selectionStart ?? 0
            )
          }}
          onBlur={() => {
            setMention(null)
            setCommandMenuDismissed(true)
          }}
          placeholder={t('input.placeholder')}
          disabled={disabled || sending}
          className={css({
            flex: 1,
            paddingX: '0.75rem',
            paddingY: '0.5rem',
            border: '1px solid token(colors.greyscale.300)',
            borderRadius: '0.5rem',
            fontSize: '0.9375rem',
          })}
          data-testid="im-msg-input"
        />
        <Button
          type="submit"
          variant="primary"
          size="action"
          isDisabled={disabled || sending || !text.trim() || commandMenuOpen}
          data-testid="im-msg-send"
        >
          {sending ? t('input.sending') : t('input.send')}
        </Button>
      </div>
    </form>
  )
}
