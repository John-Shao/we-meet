import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  RiArrowUpLine,
  RiChat3Line,
  RiLoader4Line,
  RiPhoneLine,
  RiRefreshLine,
  RiRobot2Line,
  RiShieldCheckLine,
  RiSparkling2Line,
  RiStopCircleLine,
  RiWifiOffLine,
} from '@remixicon/react'
import { fetchApi } from '@/api/fetchApi'
import { Screen } from '@/layout/Screen'
import { css } from '@/styled-system/css'

type Status = 'idle' | 'connecting' | 'active' | 'error' | 'ended'
type Row = {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
}
type AgentProfile = { code: string }
type AgentConfig = { profiles: AgentProfile[] }
type CallAnswer = { sdp: string; voice?: string; instructions?: string }

const PROMPTS = [
  '帮我把下面这段内容总结成 3 个要点。',
  '根据会议内容，列出可以立即执行的行动项。',
  '把这段话改写得更简洁、更专业。',
]

const STATUS_TEXT: Record<Status, string> = {
  idle: '未连接',
  connecting: '正在连接',
  active: '已连接',
  error: '连接失败',
  ended: '已结束',
}

const nowLabel = (value: number) =>
  new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })

const page = css({
  flex: 1,
  minHeight: 0,
  width: '100%',
  backgroundColor: 'surface.canvas',
  color: 'text.primary',
})

const pageInner = css({
  width: '100%',
  maxWidth: '1120px',
  height: '100%',
  minHeight: 0,
  margin: '0 auto',
  paddingX: '1.75rem',
  paddingY: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  '@media (max-width: 720px)': {
    paddingX: '0.75rem',
    paddingY: '0.75rem',
  },
})

const header = css({
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '1rem',
  flexWrap: 'wrap',
})

const identity = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.75rem',
  minWidth: 0,
})

const brandMark = css({
  width: '42px',
  height: '42px',
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  borderRadius: '12px',
  backgroundColor: 'brand.50',
  color: 'brand.700',
  border: '1px solid token(colors.brand.100)',
})

const eyebrow = css({
  color: 'brand.700',
  fontSize: '0.6875rem',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  lineHeight: '1rem',
})

const title = css({
  margin: '0.125rem 0 0.25rem',
  fontSize: '1.5rem',
  lineHeight: '2rem',
  fontWeight: 700,
  letterSpacing: '-0.01em',
})

const subtitle = css({
  margin: 0,
  color: 'text.secondary',
  fontSize: '0.8125rem',
  lineHeight: '1.5',
  maxWidth: '34rem',
})

const headerActions = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  flexWrap: 'wrap',
  paddingTop: '0.25rem',
})

const statusPill = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  minHeight: '2rem',
  paddingX: '0.625rem',
  borderRadius: '999px',
  backgroundColor: 'greyscale.100',
  color: 'text.secondary',
  fontSize: '0.75rem',
  fontWeight: 600,
  whiteSpace: 'nowrap',
})

const statusDot = css({
  width: '0.375rem',
  height: '0.375rem',
  borderRadius: '999px',
  backgroundColor: 'currentColor',
})

const statusVariants: Record<Status, string> = {
  idle: css({ backgroundColor: 'greyscale.100', color: 'text.secondary' }),
  connecting: css({
    backgroundColor: 'status.warning.container',
    color: 'status.warning.container-text',
  }),
  active: css({
    backgroundColor: 'status.success.container',
    color: 'status.success.container-text',
  }),
  error: css({
    backgroundColor: 'status.danger.container',
    color: 'status.danger.container-text',
  }),
  ended: css({ backgroundColor: 'greyscale.100', color: 'text.secondary' }),
}

const buttonBase = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
  minHeight: '2.25rem',
  paddingX: '0.875rem',
  borderRadius: '9px',
  border: '1px solid transparent',
  fontSize: '0.8125rem',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  _disabled: { cursor: 'not-allowed', opacity: 0.55 },
})

const primaryButton = css({
  backgroundColor: 'action.primary.bg',
  color: 'action.primary.text',
  _hover: { backgroundColor: 'action.primary.hover' },
})

const secondaryButton = css({
  backgroundColor: 'surface.default',
  color: 'text.primary',
  borderColor: 'border.default',
  _hover: { backgroundColor: 'greyscale.50' },
})

const ghostButton = css({
  backgroundColor: 'transparent',
  color: 'text.secondary',
  borderColor: 'border.subtle',
  _hover: { backgroundColor: 'greyscale.50', color: 'text.primary' },
})

const chatCard = css({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  backgroundColor: 'surface.default',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: '18px',
  boxShadow: '0 1px 3px rgba(16, 24, 40, 0.04)',
})

const chatHeader = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  minHeight: '3.25rem',
  paddingX: '1.125rem',
  borderBottom: '1px solid token(colors.border.subtle)',
  backgroundColor: 'surface.default',
})

const chatIdentity = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minWidth: 0,
})

const miniAvatar = css({
  width: '1.75rem',
  height: '1.75rem',
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
  borderRadius: '8px',
  backgroundColor: 'brand.50',
  color: 'brand.700',
  border: '1px solid token(colors.brand.100)',
})

const chatName = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.0625rem',
  minWidth: 0,
})

const chatTitle = css({
  fontSize: '0.8125rem',
  fontWeight: 600,
  color: 'text.primary',
  lineHeight: '1.15rem',
})

const chatMeta = css({
  fontSize: '0.6875rem',
  color: 'text.secondary',
  lineHeight: '1rem',
})

const privacyNote = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  color: 'text.secondary',
  fontSize: '0.6875rem',
  whiteSpace: 'nowrap',
  '@media (max-width: 560px)': { display: 'none' },
})

const transcript = css({
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  paddingX: 'clamp(1rem, 4vw, 2.5rem)',
  paddingY: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.125rem',
  scrollBehavior: 'smooth',
})

const emptyState = css({
  margin: 'auto',
  width: '100%',
  maxWidth: '40rem',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  gap: '0.75rem',
  paddingY: '1.5rem',
})

const emptyIcon = css({
  width: '3.5rem',
  height: '3.5rem',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '16px',
  backgroundColor: 'brand.50',
  color: 'brand.700',
  border: '1px solid token(colors.brand.100)',
})

const emptyTitle = css({
  margin: 0,
  fontSize: '1.25rem',
  lineHeight: '1.75rem',
  fontWeight: 700,
})

const emptyCopy = css({
  margin: 0,
  maxWidth: '32rem',
  color: 'text.secondary',
  fontSize: '0.8125rem',
  lineHeight: '1.6',
})

const promptGrid = css({
  width: '100%',
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '0.625rem',
  marginTop: '0.75rem',
  '@media (max-width: 760px)': { gridTemplateColumns: '1fr' },
})

const promptCard = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.5rem',
  minHeight: '4.5rem',
  padding: '0.75rem',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: '12px',
  backgroundColor: 'surface.default',
  color: 'text.secondary',
  fontSize: '0.75rem',
  lineHeight: '1.45',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: {
    borderColor: 'border.focus',
    backgroundColor: 'greyscale.50',
    color: 'text.primary',
  },
  _disabled: { opacity: 0.55, cursor: 'not-allowed' },
})

const promptIcon = css({
  flexShrink: 0,
  color: 'brand.600',
  marginTop: '0.0625rem',
})

const messageRow = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.625rem',
  width: '100%',
})

const userRow = css({ justifyContent: 'flex-end' })
const assistantRow = css({ justifyContent: 'flex-start' })

const messageAvatar = css({
  width: '1.75rem',
  height: '1.75rem',
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  borderRadius: '8px',
  backgroundColor: 'brand.50',
  color: 'brand.700',
  border: '1px solid token(colors.brand.100)',
  marginTop: '0.125rem',
})

const messageBody = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  maxWidth: 'min(78%, 46rem)',
  minWidth: 0,
  '@media (max-width: 720px)': { maxWidth: '86%' },
})

const userBody = css({ alignItems: 'flex-end' })

const bubble = css({
  paddingX: '0.875rem',
  paddingY: '0.625rem',
  borderRadius: '14px',
  fontSize: '0.875rem',
  lineHeight: '1.6',
  wordBreak: 'break-word',
})

const userBubble = css({
  backgroundColor: 'action.primary.bg',
  color: 'action.primary.text',
  borderTopRightRadius: '5px',
  whiteSpace: 'pre-wrap',
})

const assistantBubble = css({
  backgroundColor: 'surface.muted',
  color: 'text.primary',
  borderTopLeftRadius: '5px',
  border: '1px solid token(colors.border.subtle)',
})

const markdown = css({
  fontSize: '0.875rem',
  lineHeight: '1.65',
  '& p': { margin: '0 0 0.5rem' },
  '& p:last-child': { marginBottom: 0 },
  '& ul, & ol': { margin: '0.25rem 0 0.5rem 1.25rem', padding: 0 },
  '& li': { marginBottom: '0.25rem' },
  '& strong': { fontWeight: 600 },
  '& a': { color: 'text.link', textDecoration: 'underline' },
  '& code': {
    padding: '0.0625rem 0.25rem',
    borderRadius: '4px',
    backgroundColor: 'greyscale.100',
    fontSize: '0.875em',
  },
  '& pre': {
    margin: '0.375rem 0',
    padding: '0.625rem',
    borderRadius: '8px',
    backgroundColor: 'greyscale.100',
    overflowX: 'auto',
  },
  '& pre code': { padding: 0, backgroundColor: 'transparent' },
  '& blockquote': {
    margin: '0.375rem 0',
    paddingLeft: '0.625rem',
    borderLeft: '3px solid token(colors.border.default)',
    color: 'text.secondary',
  },
})

const messageMeta = css({
  color: 'text.disabled',
  fontSize: '0.6875rem',
  lineHeight: '1rem',
  paddingX: '0.125rem',
})

const typing = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  paddingX: '0.875rem',
  paddingY: '0.75rem',
})

const typingDot = css({
  width: '0.375rem',
  height: '0.375rem',
  borderRadius: '999px',
  backgroundColor: 'text.disabled',
  animation: 'blink 1.2s infinite',
})

const streamingMarkdown = css({
  '& > *:last-child::after': {
    content: '""',
    display: 'inline-block',
    width: '0.5ch',
    height: '1em',
    marginLeft: '0.125rem',
    verticalAlign: 'text-bottom',
    borderLeft: '2px solid token(colors.text.secondary)',
    animation: 'blink 1s steps(2) infinite',
  },
})

const composerArea = css({
  borderTop: '1px solid token(colors.border.subtle)',
  paddingX: '1.125rem',
  paddingTop: '0.75rem',
  paddingBottom: '0.75rem',
  backgroundColor: 'surface.default',
})

const notice = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.625rem',
  padding: '0.5rem 0.75rem',
  borderRadius: '9px',
  backgroundColor: 'status.danger.container',
  color: 'status.danger.container-text',
  fontSize: '0.75rem',
  lineHeight: '1.45',
})

const noticeCopy = css({ flex: 1, minWidth: 0 })

const noticeButton = css({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  minHeight: '1.75rem',
  paddingX: '0.5rem',
  border: '1px solid currentColor',
  borderRadius: '6px',
  backgroundColor: 'transparent',
  color: 'inherit',
  fontSize: '0.6875rem',
  fontWeight: 600,
  cursor: 'pointer',
})

const composer = css({
  display: 'flex',
  alignItems: 'flex-end',
  gap: '0.5rem',
  padding: '0.375rem',
  border: '1px solid token(colors.border.default)',
  borderRadius: '14px',
  backgroundColor: 'surface.default',
  transition: 'border-color 120ms ease, box-shadow 120ms ease',
  _focusWithin: {
    borderColor: 'border.focus',
    boxShadow: '0 0 0 3px token(colors.brand.100)',
  },
})

const textarea = css({
  flex: 1,
  minWidth: 0,
  minHeight: '2.25rem',
  maxHeight: '10rem',
  paddingX: '0.625rem',
  paddingY: '0.5rem',
  border: 0,
  outline: 'none',
  resize: 'none',
  backgroundColor: 'transparent',
  color: 'text.primary',
  fontFamily: 'inherit',
  fontSize: '0.875rem',
  lineHeight: '1.5',
  _placeholder: { color: 'text.disabled' },
  _disabled: { cursor: 'not-allowed' },
})

const sendButton = css({
  width: '2.5rem',
  height: '2.5rem',
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  border: 0,
  borderRadius: '10px',
  backgroundColor: 'action.primary.bg',
  color: 'action.primary.text',
  cursor: 'pointer',
  _hover: { backgroundColor: 'action.primary.hover' },
  _disabled: {
    backgroundColor: 'greyscale.100',
    color: 'text.disabled',
    cursor: 'not-allowed',
  },
})

const stopButton = css({
  height: '2.5rem',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  paddingX: '0.75rem',
  border: '1px solid token(colors.border.default)',
  borderRadius: '10px',
  backgroundColor: 'surface.default',
  color: 'text.secondary',
  fontSize: '0.75rem',
  fontWeight: 600,
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.50', color: 'text.primary' },
})

const composerFooter = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  marginTop: '0.375rem',
  color: 'text.disabled',
  fontSize: '0.6875rem',
  lineHeight: '1rem',
})

const kbd = css({
  padding: '0 0.25rem',
  borderRadius: '3px',
  backgroundColor: 'greyscale.100',
  color: 'text.secondary',
  fontFamily: 'inherit',
  fontSize: '0.625rem',
})

const srOnly = css({
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
})

export function AiAssistantRoute() {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [draft, setDraft] = useState('')
  const [awaiting, setAwaiting] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const responsesRef = useRef(new Map<string, { text: string }>())
  const deltaKindRef = useRef(new Map<string, 'text' | 'transcript'>())
  const sessionUpdatedRef = useRef<(() => void) | null>(null)
  const runIdRef = useRef(0)
  const voiceRef = useRef('Tina')
  const instructionsRef = useRef('你是一个友好、简洁的 AI 助手。')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const cleanup = () => {
    sessionUpdatedRef.current = null
    channelRef.current?.close()
    channelRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    void audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    responsesRef.current.clear()
    deltaKindRef.current.clear()
    setAwaiting(false)
    setStreamingId(null)
  }

  const cleanupRef = useRef(cleanup)
  cleanupRef.current = cleanup

  useEffect(() => {
    return () => {
      runIdRef.current += 1
      cleanupRef.current()
    }
  }, [])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [draft])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows, awaiting])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const appendUserRow = (text: string) => {
    setRows((previous) => [
      ...previous,
      {
        id: `user-${crypto.randomUUID()}`,
        role: 'user',
        text,
        createdAt: Date.now(),
      },
    ])
  }

  const sendText = (raw?: string) => {
    if (awaiting) return
    const text = (raw ?? draft).trim()
    const channel = channelRef.current
    if (!text || !channel || channel.readyState !== 'open') return
    appendUserRow(text)
    setDraft('')
    setAwaiting(true)
    setStreamingId(null)
    stickToBottomRef.current = true
    channel.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      })
    )
    channel.send(JSON.stringify({ type: 'response.create' }))
  }

  const handleEvent = (event: MessageEvent<string>) => {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>
    } catch {
      return
    }
    const type = String(payload.type ?? '')
    if (type === 'response.created') {
      const response = payload.response as { id?: string } | undefined
      if (!response?.id) return
      responsesRef.current.set(response.id, { text: '' })
      deltaKindRef.current.delete(response.id)
      setAwaiting(true)
      setStreamingId(response.id)
      return
    }
    if (
      type === 'response.text.delta' ||
      type === 'response.audio_transcript.delta'
    ) {
      const delta = String(payload.delta ?? '')
      if (!delta) return
      const responseId = String(payload.response_id ?? '')
      if (!responseId) return
      const kind = type === 'response.text.delta' ? 'text' : 'transcript'
      const previousKind = deltaKindRef.current.get(responseId)
      if (!previousKind) deltaKindRef.current.set(responseId, kind)
      else if (previousKind !== kind) return
      const current = responsesRef.current.get(responseId) ?? { text: '' }
      current.text += delta
      responsesRef.current.set(responseId, current)
      setRows((previous) => {
        const rowId = `assistant-${responseId}`
        const index = previous.findIndex((row) => row.id === rowId)
        if (index >= 0) {
          const next = previous.slice()
          next[index] = { ...next[index], text: current.text }
          return next
        }
        return [
          ...previous,
          {
            id: rowId,
            role: 'assistant',
            text: current.text,
            createdAt: Date.now(),
          },
        ]
      })
      return
    }
    if (type === 'response.done' || type === 'response.failed') {
      const response = payload.response as { id?: string } | undefined
      const responseId = String(response?.id ?? '')
      const text = responsesRef.current.get(responseId)?.text ?? ''
      setAwaiting(false)
      setStreamingId((current) => (current === responseId ? null : current))
      if (!text && type === 'response.failed') {
        const detail = (payload.error as { message?: string } | undefined)
          ?.message
        setError(detail || 'AI 没有返回内容，请重试。')
      }
      return
    }
    if (type === 'error') {
      const detail = (payload.error as { message?: string } | undefined)
        ?.message
      setError(detail || 'AI 服务返回错误，请重试。')
      setAwaiting(false)
      setStreamingId(null)
    }
  }

  const sendSessionUpdate = () => {
    const channel = channelRef.current
    if (!channel || channel.readyState !== 'open') return
    channel.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          input_audio_format: 'pcm',
          output_audio_format: 'pcm',
          voice: voiceRef.current,
          instructions: instructionsRef.current,
          input_audio_transcription: {
            model: 'qwen3-asr-flash-realtime',
            language: 'zh',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            silence_duration_ms: 800,
          },
        },
      })
    )
  }

  const attachChannel = (channel: RTCDataChannel) => {
    channel.addEventListener('message', (event) => {
      handleEvent(event)
      try {
        if (
          (JSON.parse(event.data) as { type?: string }).type ===
          'session.updated'
        )
          sessionUpdatedRef.current?.()
      } catch {
        // Non-JSON frames are ignored; the main handler already skipped them.
      }
    })
  }

  const stop = () => {
    runIdRef.current += 1
    cleanup()
    setError('')
    setStatus('ended')
  }

  const cancelStart = () => {
    runIdRef.current += 1
    cleanup()
    setError('')
    setStatus('idle')
  }

  const start = async (initialText?: string) => {
    if (status === 'connecting' || status === 'active') return
    const runId = ++runIdRef.current
    cleanup()
    setStatus('connecting')
    setError('')
    setRows([])
    setDraft('')
    responsesRef.current.clear()
    deltaKindRef.current.clear()
    stickToBottomRef.current = true
    try {
      const config = await fetchApi<AgentConfig>('rooms/ai-agent-config/')
      if (runId !== runIdRef.current) return
      const profile = config.profiles?.[0]
      if (!profile) throw new Error('没有可用的 AI 对话配置')

      const audioContext = new AudioContext()
      audioContextRef.current = audioContext
      await audioContext.resume()
      if (runId !== runIdRef.current) return
      const destination = audioContext.createMediaStreamDestination()
      const oscillator = audioContext.createOscillator()
      const gain = audioContext.createGain()
      gain.gain.value = 0
      oscillator.connect(gain).connect(destination)
      oscillator.start()

      const pc = new RTCPeerConnection()
      pcRef.current = pc
      pc.addEventListener('connectionstatechange', () => {
        if (pcRef.current !== pc) return
        if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected'
        ) {
          setError('连接已断开，请重新连接。')
          setStatus('error')
          setAwaiting(false)
          setStreamingId(null)
        }
      })
      const channel = pc.createDataChannel('oai-events', { ordered: true })
      channelRef.current = channel
      attachChannel(channel)
      pc.addEventListener('datachannel', (event) =>
        attachChannel(event.channel)
      )
      pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream)

      const updated = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error('AI 对话连接超时')),
          20_000
        )
        sessionUpdatedRef.current = () => {
          window.clearTimeout(timer)
          resolve()
        }
      })
      void updated.catch(() => {
        // Handled by the start() flow; avoid an unhandled rejection on cancel/error.
      })
      const opened = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error('AI 对话通道打开超时')),
          15_000
        )
        channel.onopen = () => {
          window.clearTimeout(timer)
          resolve()
        }
      })

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve()
        const timer = window.setTimeout(resolve, 5_000)
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') {
            window.clearTimeout(timer)
            resolve()
          }
        })
      })
      if (runId !== runIdRef.current) return
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('无法生成 SDP')
      const answer = await fetchApi<CallAnswer>('ai-call/session/', {
        method: 'POST',
        body: JSON.stringify({
          profile_code: profile.code,
          transport: 'webrtc',
          photo_qa: false,
          sdp,
        }),
      })
      if (runId !== runIdRef.current) return
      voiceRef.current = answer.voice || 'Tina'
      instructionsRef.current = answer.instructions || instructionsRef.current
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      await opened
      if (runId !== runIdRef.current) return
      sendSessionUpdate()
      await updated
      if (runId !== runIdRef.current) return
      setStatus('active')
      inputRef.current?.focus()
      if (initialText) sendText(initialText)
    } catch (reason) {
      if (runId !== runIdRef.current) return
      cleanup()
      setStatus('error')
      setError(reason instanceof Error ? reason.message : 'AI 对话连接失败')
    }
  }

  const stopResponse = () => {
    const channel = channelRef.current
    if (channel?.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'response.cancel' }))
    }
    setAwaiting(false)
    setStreamingId(null)
  }

  const openCall = () => {
    const bridge = window.weMeetDesktop?.aiCall
    if (bridge) {
      void bridge.open().catch(() => window.location.assign('/ai-call'))
      return
    }
    window.location.assign('/ai-call')
  }

  const handlePrompt = (prompt: string) => {
    if (status === 'active') {
      sendText(prompt)
      return
    }
    if (status === 'connecting') return
    setDraft(prompt)
    inputRef.current?.focus()
    void start(prompt)
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    if (awaiting) return
    sendText()
  }

  const canChat = status === 'active'
  const statusText = STATUS_TEXT[status]
  const liveStatus = awaiting
    ? `${statusText}，AI 正在回复`
    : `${statusText}${error ? `，${error}` : ''}`

  return (
    <Screen footer={false}>
      <div className={page} aria-labelledby="ai-assistant-title">
        <div className={pageInner}>
          <header className={header}>
            <div className={identity}>
              <span className={brandMark} aria-hidden="true">
                <RiRobot2Line size={22} />
              </span>
              <div>
                <div className={eyebrow}>AI 对话</div>
                <h1 id="ai-assistant-title" className={title}>
                  AI 助手
                </h1>
                <p className={subtitle}>
                  文字对话，随时提问。需要语音或共享屏幕时，可直接发起 AI 通话。
                </p>
              </div>
            </div>
            <div className={headerActions}>
              <span className={`${statusPill} ${statusVariants[status]}`}>
                <span className={statusDot} aria-hidden="true" />
                {status === 'connecting' && (
                  <RiLoader4Line
                    size={12}
                    aria-hidden="true"
                    className={css({ animation: 'blink 1.4s infinite' })}
                  />
                )}
                {statusText}
              </span>
              <button
                type="button"
                className={`${buttonBase} ${ghostButton}`}
                onClick={openCall}
                title="打开 AI 通话，可使用语音、摄像头和屏幕共享"
              >
                <RiPhoneLine size={15} aria-hidden="true" />
                AI 通话
              </button>
              {status === 'connecting' && (
                <button
                  type="button"
                  className={`${buttonBase} ${secondaryButton}`}
                  onClick={cancelStart}
                >
                  取消
                </button>
              )}
              {status === 'active' && (
                <button
                  type="button"
                  className={`${buttonBase} ${secondaryButton}`}
                  onClick={stop}
                >
                  结束对话
                </button>
              )}
              {(status === 'ended' || status === 'idle') && rows.length > 0 && (
                <button
                  type="button"
                  className={`${buttonBase} ${primaryButton}`}
                  onClick={() => void start()}
                >
                  <RiRefreshLine size={15} aria-hidden="true" />
                  新对话
                </button>
              )}
            </div>
          </header>

          <section className={chatCard} aria-label="AI 助手对话">
            <div className={chatHeader}>
              <div className={chatIdentity}>
                <span className={miniAvatar} aria-hidden="true">
                  <RiChat3Line size={15} />
                </span>
                <span className={chatName}>
                  <span className={chatTitle}>当前对话</span>
                  <span className={chatMeta}>
                    {status === 'active'
                      ? '已建立实时连接，回复会逐字显示'
                      : status === 'connecting'
                        ? '正在建立实时连接…'
                        : status === 'error'
                          ? '连接中断，可重新开始'
                          : '尚未开始，点击下方按钮建立连接'}
                  </span>
                </span>
              </div>
              <span className={privacyNote}>
                <RiShieldCheckLine size={13} aria-hidden="true" />
                本次对话不保存
              </span>
            </div>

            <div
              ref={scrollRef}
              className={transcript}
              onScroll={onScroll}
              aria-label="对话记录"
            >
              {rows.length === 0 && !awaiting && (
                <div className={emptyState}>
                  <span className={emptyIcon} aria-hidden="true">
                    <RiSparkling2Line size={26} />
                  </span>
                  <h2 className={emptyTitle}>今天想聊什么？</h2>
                  <p className={emptyCopy}>
                    {status === 'idle' || status === 'ended'
                      ? '开始后，你可以直接输入问题。AI 会结合上下文连续回答，也可以随时切换到语音通话。'
                      : status === 'connecting'
                        ? '正在连接 AI 助手，连接成功后即可开始输入。'
                        : status === 'active'
                          ? '连接已建立。输入问题，或从下面选一个开始。'
                          : '连接未建立。请重试，或稍后再试。'}
                  </p>
                  {(status === 'idle' || status === 'ended') && (
                    <button
                      type="button"
                      className={`${buttonBase} ${primaryButton}`}
                      onClick={() => void start()}
                      style={{ marginTop: '0.25rem' }}
                    >
                      <RiSparkling2Line size={15} aria-hidden="true" />
                      开始对话
                    </button>
                  )}
                  {status === 'error' && (
                    <button
                      type="button"
                      className={`${buttonBase} ${secondaryButton}`}
                      onClick={() => void start()}
                    >
                      <RiRefreshLine size={15} aria-hidden="true" />
                      重新连接
                    </button>
                  )}
                  <div className={promptGrid}>
                    {PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        className={promptCard}
                        onClick={() => handlePrompt(prompt)}
                        disabled={status === 'connecting'}
                      >
                        <RiSparkling2Line
                          size={14}
                          aria-hidden="true"
                          className={promptIcon}
                        />
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {rows.map((row) => {
                const isUser = row.role === 'user'
                const isStreaming =
                  !isUser && row.id === `assistant-${streamingId}`
                return (
                  <div
                    key={row.id}
                    className={`${messageRow} ${isUser ? userRow : assistantRow}`}
                  >
                    {!isUser && (
                      <span className={messageAvatar} aria-hidden="true">
                        <RiRobot2Line size={15} />
                      </span>
                    )}
                    <div className={`${messageBody} ${isUser ? userBody : ''}`}>
                      <div
                        className={`${bubble} ${isUser ? userBubble : assistantBubble}`}
                      >
                        {isUser ? (
                          row.text
                        ) : (
                          <div
                            className={`${markdown} ${isStreaming ? streamingMarkdown : ''}`}
                          >
                            <ReactMarkdown
                              components={{
                                a: ({ children, ...props }) => (
                                  <a
                                    {...props}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {children}
                                  </a>
                                ),
                              }}
                            >
                              {row.text}
                            </ReactMarkdown>
                          </div>
                        )}
                      </div>
                      <span className={messageMeta}>
                        {isUser ? '你' : 'AI 助手'} · {nowLabel(row.createdAt)}
                      </span>
                    </div>
                  </div>
                )
              })}

              {awaiting && !streamingId && (
                <div className={`${messageRow} ${assistantRow}`}>
                  <span className={messageAvatar} aria-hidden="true">
                    <RiRobot2Line size={15} />
                  </span>
                  <div className={`${bubble} ${assistantBubble} ${typing}`}>
                    <span
                      className={typingDot}
                      style={{ animationDelay: '0ms' }}
                    />
                    <span
                      className={typingDot}
                      style={{ animationDelay: '160ms' }}
                    />
                    <span
                      className={typingDot}
                      style={{ animationDelay: '320ms' }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className={composerArea}>
              {error && (
                <div className={notice} role="alert">
                  <RiWifiOffLine size={15} aria-hidden="true" />
                  <span className={noticeCopy}>{error}</span>
                  <button
                    type="button"
                    className={noticeButton}
                    onClick={() => void start()}
                  >
                    <RiRefreshLine size={12} aria-hidden="true" />
                    重试
                  </button>
                </div>
              )}
              <div className={composer}>
                <textarea
                  ref={inputRef}
                  className={textarea}
                  rows={1}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  disabled={!canChat}
                  placeholder={
                    canChat
                      ? '输入问题…'
                      : status === 'connecting'
                        ? '正在连接 AI 助手…'
                        : '开始对话后可输入'
                  }
                  aria-label="输入消息"
                  aria-describedby="ai-assistant-composer-hint"
                  maxLength={2000}
                />
                {awaiting ? (
                  <button
                    type="button"
                    className={stopButton}
                    onClick={stopResponse}
                    aria-label="停止生成"
                  >
                    <RiStopCircleLine size={16} aria-hidden="true" />
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    className={sendButton}
                    onClick={() => sendText()}
                    disabled={!canChat || !draft.trim()}
                    aria-label="发送消息"
                    title="发送消息"
                  >
                    <RiArrowUpLine size={18} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div id="ai-assistant-composer-hint" className={composerFooter}>
                <span>
                  <kbd className={kbd}>Enter</kbd> 发送 ·{' '}
                  <kbd className={kbd}>Shift</kbd> +{' '}
                  <kbd className={kbd}>Enter</kbd> 换行
                </span>
                <span>AI 生成内容可能有误，请核对重要信息</span>
              </div>
            </div>
          </section>
        </div>
        <p className={srOnly} role="status" aria-live="polite">
          {liveStatus}
        </p>
      </div>
    </Screen>
  )
}
