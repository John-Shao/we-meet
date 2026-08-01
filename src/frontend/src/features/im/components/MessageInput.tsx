import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiImageLine,
  RiAttachment2,
  RiFileTextLine,
  RiCloseLine,
  RiMicLine,
  RiSendPlane2Fill,
} from '@remixicon/react'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

/** Quoted-message preview shown above the input while composing a reply. */
export interface ReplyPreview {
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
  /** Send a recorded voice clip (P7-i). Omitted → no mic button. */
  onSendVoice?: (blob: Blob, durationMs: number) => Promise<void> | void
  /** Active reply context (P7-b); shows a quote bar above the input. */
  reply?: ReplyPreview | null
  onCancelReply?: () => void
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
  onSendFile,
  onSendDoc,
  onSendVoice,
  reply,
  onCancelReply,
}: Props) => {
  const { t } = useTranslation('im')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const [mention, setMention] = useState<{ at: number; query: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const attachRef = useRef<HTMLInputElement>(null)

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // allow re-picking the same file
    if (files.length === 0 || !onSendImage || uploading) return
    setUploading(true)
    try {
      // 多图:按选择顺序逐张发送(每张一条 image 消息)。
      for (const file of files) {
        await onSendImage(file)
      }
    } finally {
      setUploading(false)
    }
  }

  const onPickAttachment = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !onSendFile || uploading) return
    setUploading(true)
    try {
      await onSendFile(file)
    } finally {
      setUploading(false)
    }
  }

  // ── 语音录制(P7-i)────────────────────────────────────────────────
  const MAX_VOICE_SEC = 60
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<number>(0)
  const cancelledRef = useRef(false)

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }
  const stopStream = () => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop())
    streamRef.current = null
  }
  const pickAudioMime = (): string => {
    const cands = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg',
    ]
    if (typeof MediaRecorder === 'undefined') return ''
    return cands.find((c) => MediaRecorder.isTypeSupported(c)) || ''
  }

  const stopRecorder = () => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
  }
  const finishRecording = () => {
    cancelledRef.current = false
    stopRecorder()
  }
  const cancelRecording = () => {
    cancelledRef.current = true
    stopRecorder()
  }

  const startRecording = async () => {
    if (recording || disabled || uploading || !onSendVoice) return
    if (!navigator.mediaDevices?.getUserMedia) {
      void window.alert?.(t('voice.unsupported'))
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = pickAudioMime()
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      recorderRef.current = rec
      chunksRef.current = []
      cancelledRef.current = false
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        clearTimer()
        const durationMs = Date.now() - startRef.current
        const wasCancelled = cancelledRef.current
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || 'audio/webm',
        })
        chunksRef.current = []
        stopStream()
        setRecording(false)
        // 太短(<0.8s)或取消或空 → 丢弃不发。
        if (wasCancelled || durationMs < 800 || blob.size === 0) return
        setUploading(true)
        try {
          await onSendVoice(blob, durationMs)
        } finally {
          setUploading(false)
        }
      }
      startRef.current = Date.now()
      setRecSeconds(0)
      rec.start()
      setRecording(true)
      timerRef.current = window.setInterval(() => {
        const s = Math.floor((Date.now() - startRef.current) / 1000)
        setRecSeconds(s)
        if (s >= MAX_VOICE_SEC) finishRecording()
      }, 250)
    } catch {
      stopStream()
      setRecording(false)
      void window.alert?.(t('voice.micDenied'))
    }
  }

  // 卸载时清理:停止计时器 + 释放麦克风。
  useEffect(() => {
    return () => {
      clearTimer()
      stopStream()
      const rec = recorderRef.current
      if (rec && rec.state !== 'inactive') {
        cancelledRef.current = true
        rec.stop()
      }
    }
  }, [])

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
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        padding: '0.75rem',
        borderTop: '1px solid token(colors.greyscale.200)',
      })}
    >
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
          <button
            type="button"
            onClick={onCancelReply}
            aria-label={t('quote.cancel')}
            className={css({
              flexShrink: 0,
              display: 'flex',
              border: 'none',
              background: 'transparent',
              color: 'greyscale.500',
              cursor: 'pointer',
              _hover: { color: 'greyscale.800' },
            })}
          >
            <RiCloseLine size={16} />
          </button>
        </div>
      )}
      <div className={css({ position: 'relative', display: 'flex', gap: '0.5rem' })}>
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
      {recording && (
        <div
          className={css({
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            paddingX: '0.75rem',
            paddingY: '0.5rem',
            border: '1px solid token(colors.danger.500)',
            borderRadius: '0.5rem',
            backgroundColor: 'greyscale.000',
          })}
          data-testid="im-voice-recording"
        >
          <button
            type="button"
            onClick={cancelRecording}
            aria-label={t('voice.cancel')}
            title={t('voice.cancel')}
            className={css({
              flexShrink: 0,
              display: 'flex',
              border: 'none',
              background: 'transparent',
              color: 'greyscale.500',
              cursor: 'pointer',
              _hover: { color: 'greyscale.800' },
            })}
          >
            <RiCloseLine size={18} />
          </button>
          <span
            aria-hidden="true"
            className={css({
              flexShrink: 0,
              width: '0.5rem',
              height: '0.5rem',
              borderRadius: '999px',
              backgroundColor: 'danger.500',
              animation: 'pulse_background 1.2s ease-in-out infinite',
            })}
          />
          <span className={css({ color: 'danger.500', fontSize: '0.875rem' })}>
            {t('voice.recording')}
          </span>
          <span
            className={css({
              marginLeft: 'auto',
              color: 'greyscale.600',
              fontSize: '0.8125rem',
              fontVariantNumeric: 'tabular-nums',
            })}
          >
            {`0:${String(recSeconds).padStart(2, '0')}`} / {`0:${MAX_VOICE_SEC}`}
          </span>
          <button
            type="button"
            onClick={finishRecording}
            aria-label={t('voice.send')}
            title={t('voice.send')}
            className={css({
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '2rem',
              height: '2rem',
              border: 'none',
              borderRadius: '0.5rem',
              backgroundColor: 'primary.500',
              color: 'white',
              cursor: 'pointer',
            })}
          >
            <RiSendPlane2Fill size={16} />
          </button>
        </div>
      )}
      {!recording && (
        <>
      {onSendImage && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            onChange={onPickImage}
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
              backgroundColor: 'greyscale.000',
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
      {onSendFile && (
        <>
          <input
            ref={attachRef}
            type="file"
            onChange={onPickAttachment}
            className={css({ display: 'none' })}
            data-testid="im-file-input"
          />
          <button
            type="button"
            onClick={() => attachRef.current?.click()}
            disabled={disabled || uploading}
            aria-label={t('input.file')}
            title={t('input.file')}
            data-testid="im-file-btn"
            className={css({
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '2.375rem',
              border: '1px solid token(colors.greyscale.300)',
              borderRadius: '0.5rem',
              backgroundColor: 'greyscale.000',
              color: 'greyscale.600',
              cursor: 'pointer',
              _hover: { backgroundColor: 'greyscale.100' },
              _disabled: { opacity: 0.5, cursor: 'not-allowed' },
            })}
          >
            <RiAttachment2 size={18} />
          </button>
        </>
      )}
      {onSendDoc && (
        <button
          type="button"
          onClick={onSendDoc}
          disabled={disabled || uploading}
          aria-label={t('input.doc')}
          title={t('input.doc')}
          data-testid="im-doc-btn"
          className={css({
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '2.375rem',
            border: '1px solid token(colors.greyscale.300)',
            borderRadius: '0.5rem',
            backgroundColor: 'greyscale.000',
            color: 'greyscale.600',
            cursor: 'pointer',
            _hover: { backgroundColor: 'greyscale.100' },
            _disabled: { opacity: 0.5, cursor: 'not-allowed' },
          })}
        >
          <RiFileTextLine size={18} />
        </button>
      )}
      {onSendVoice && (
        <button
          type="button"
          onClick={() => void startRecording()}
          disabled={disabled || uploading}
          aria-label={t('input.voice')}
          title={t('input.voice')}
          data-testid="im-voice-btn"
          className={css({
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '2.375rem',
            border: '1px solid token(colors.greyscale.300)',
            borderRadius: '0.5rem',
            backgroundColor: 'greyscale.000',
            color: 'greyscale.600',
            cursor: 'pointer',
            _hover: { backgroundColor: 'greyscale.100' },
            _disabled: { opacity: 0.5, cursor: 'not-allowed' },
          })}
        >
          <RiMicLine size={18} />
        </button>
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
      <Button
        type="submit"
        variant="primary"
        size="action"
        isDisabled={disabled || sending || !text.trim()}
        data-testid="im-msg-send"
      >
        {sending ? t('input.sending') : t('input.send')}
      </Button>
        </>
      )}
      </div>
    </form>
  )
}
