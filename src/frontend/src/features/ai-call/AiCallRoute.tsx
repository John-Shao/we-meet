import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  RiChat3Line,
  RiCloseLine,
  RiComputerLine,
  RiDeleteBin6Line,
  RiHistoryLine,
  RiLock2Line,
  RiMicLine,
  RiMicOffLine,
  RiPhoneLine,
  RiSettings3Line,
  RiVideoLine,
  RiVideoOffLine,
} from '@remixicon/react'
import { Screen } from '@/layout/Screen'
import { fetchApi } from '@/api/fetchApi'
import {
  deleteRemoteCallHistory,
  pullAiCallHistory,
  pushAiCallHistory,
  type SyncRecord,
} from './sync'
import './AiCallRoute.css'

type CallStatus =
  | 'idle'
  | 'connecting'
  | 'active'
  | 'sharing'
  | 'error'
  | 'ended'
type Row = {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt?: number
}

type AgentProfile = { code: string; display_name?: string }
type AgentConfig = { profiles: AgentProfile[] }
type CallAnswer = {
  sdp: string
  voice?: string
  instructions?: string
  session_lease?: { id: string }
}
type PhotoAnswer = { answer: string }
type HistoryRecord = {
  id: string
  startedAt: number
  seconds: number
  rows: Row[]
  remoteId?: string
  title?: string
  summary?: string
  todos?: { text: string; done?: boolean }[]
}
const HISTORY_KEY = 'we-meet:ai-call-history'
const loadHistory = (): HistoryRecord[] => {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(HISTORY_KEY) ?? '[]'
    ) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((value): value is HistoryRecord => {
        if (!value || typeof value !== 'object') return false
        const record = value as Partial<HistoryRecord>
        return (
          typeof record.id === 'string' &&
          typeof record.startedAt === 'number' &&
          Number.isFinite(record.startedAt) &&
          typeof record.seconds === 'number' &&
          Number.isFinite(record.seconds) &&
          Array.isArray(record.rows)
        )
      })
      .slice(0, 20)
  } catch {
    return []
  }
}

const READ_SCREEN_TOOL = {
  type: 'function',
  name: 'read_screen',
  description:
    'Capture one frame of the screen the user is sharing and answer a question about its text or details.',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string' } },
    required: ['question'],
  },
}

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: '未开始',
  connecting: '正在连接',
  active: '通话中',
  sharing: '共享中',
  error: '连接失败',
  ended: '已结束',
}

const NETWORK_LABEL = {
  good: '网络良好',
  weak: '网络不稳定',
  poor: '网络较差',
  offline: '连接已断开',
} as const

const formatDuration = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

const mediaErrorMessage = (reason: unknown, fallback: string) => {
  if (!(reason instanceof Error)) return fallback
  if (reason.name === 'NotAllowedError')
    return '权限被拒绝，请在浏览器设置中允许后重试。'
  if (reason.name === 'NotFoundError')
    return '没有找到可用的设备，请检查设备连接。'
  if (reason.name === 'NotReadableError')
    return '设备被其他应用占用，请关闭后重试。'
  return reason.message || fallback
}

export function AiCallRoute({ compact = false }: { compact?: boolean } = {}) {
  const [status, setStatus] = useState<CallStatus>('idle')
  const [error, setError] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [sharing, setSharing] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [remoteAudioReady, setRemoteAudioReady] = useState(false)
  const [micMuted, setMicMuted] = useState(false)
  const [tab, setTab] = useState<'chat' | 'history'>('chat')
  const [historyQuery, setHistoryQuery] = useState('')
  const [readQuestion, setReadQuestion] = useState('')
  const [readRequestedAt, setReadRequestedAt] = useState(0)
  const [snapshot, setSnapshot] = useState('')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
  const [micDeviceId, setMicDeviceId] = useState(
    () => localStorage.getItem('we-meet:ai-call-mic') ?? ''
  )
  const [cameraDeviceId, setCameraDeviceId] = useState(
    () => localStorage.getItem('we-meet:ai-call-camera') ?? ''
  )
  const [networkQuality, setNetworkQuality] = useState<
    'good' | 'weak' | 'poor' | 'offline'
  >('good')
  const [reconnecting, setReconnecting] = useState(false)
  const [readResult, setReadResult] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [history, setHistory] = useState<HistoryRecord[]>(loadHistory)
  const [expandedHistory, setExpandedHistory] = useState('')
  const [draft, setDraft] = useState('')

  const persistHistory = (next: HistoryRecord[]) => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
    } catch {
      // Best-effort path: this failure must not block the call flow.
    }
  }

  const refreshDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices())
    } catch {
      // Best-effort path: this failure must not block the call flow.
    }
  }

  useEffect(() => {
    void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    return () =>
      navigator.mediaDevices?.removeEventListener?.(
        'devicechange',
        refreshDevices
      )
  }, [])

  useEffect(() => {
    if (!deviceMenuOpen) return
    const close = (event: MouseEvent) => {
      if (!devicePickerRef.current?.contains(event.target as Node))
        setDeviceMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [deviceMenuOpen])

  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    const frame = window.requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [rows, readResult, tab])

  useEffect(() => {
    let active = true
    void pullAiCallHistory()
      .then((records) => {
        if (!active) return
        setHistory((previous) => {
          const merged = new Map<string, HistoryRecord>()
          for (const record of records as HistoryRecord[])
            merged.set(record.id, record)
          for (const record of previous) {
            if (!merged.has(record.id)) merged.set(record.id, record)
          }
          const next = [...merged.values()]
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, 20)
          persistHistory(next)
          return next
        })
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const audioRef = useRef<HTMLAudioElement>(null)
  const screenRef = useRef<HTMLVideoElement>(null)
  const cameraRef = useRef<HTMLVideoElement>(null)
  const devicePickerRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const micRef = useRef<MediaStream | null>(null)
  const audioSenderRef = useRef<RTCRtpSender | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const videoSenderRef = useRef<RTCRtpSender | null>(null)
  const startedAtRef = useRef<number | undefined>(undefined)
  const sessionIdRef = useRef('')
  const voiceRef = useRef('Tina')
  const instructionsRef = useRef('你是一个友好、简洁的 AI 助手。')
  const seenCallsRef = useRef(new Set<string>())
  const timerRef = useRef<number | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const rowsRef = useRef<Row[]>(rows)
  const elapsedRef = useRef(elapsed)
  const readQuestionRef = useRef(readQuestion)
  const readResultRef = useRef(readResult)
  rowsRef.current = rows
  elapsedRef.current = elapsed
  readQuestionRef.current = readQuestion
  readResultRef.current = readResult

  useEffect(() => {
    if (status !== 'active' && status !== 'sharing') return
    let cancelled = false
    const poll = async () => {
      const pc = pcRef.current
      if (!pc || cancelled) return
      if (
        pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected'
      ) {
        setNetworkQuality('offline')
        return
      }
      try {
        let received = 0
        let lost = 0
        let jitter = 0
        const stats = await pc.getStats()
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            received += Number(report.packetsReceived ?? 0)
            lost += Number(report.packetsLost ?? 0)
            jitter = Math.max(jitter, Number(report.jitter ?? 0))
          }
        })
        if (received === 0) {
          setNetworkQuality('good')
          return
        }
        const loss = lost / (received + lost)
        setNetworkQuality(
          loss > 0.05 || jitter > 0.12
            ? 'poor'
            : loss > 0.02 || jitter > 0.05
              ? 'weak'
              : 'good'
        )
      } catch {
        // Best-effort path: this failure must not block the call flow.
      }
    }
    void poll()
    const timer = window.setInterval(poll, 4000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [status])

  const reconnect = () => {
    reconnectAttemptsRef.current = 0
    setReconnecting(true)
    cleanup()
    setStatus('idle')
    setError('')
    window.setTimeout(() => void start(true), 0)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
        return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') {
        if (deviceMenuOpen) {
          setDeviceMenuOpen(false)
        } else if (status === 'active' || status === 'sharing') {
          stop()
        }
        return
      }
      if (status !== 'active' && status !== 'sharing') return
      if (event.key.toLowerCase() === 'm') {
        event.preventDefault()
        toggleMic()
      } else if (event.key.toLowerCase() === 'c' && status === 'active') {
        event.preventDefault()
        void toggleCamera()
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (sharing) stopShare()
        else void share()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // The handlers are intentionally re-bound only when the interaction state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, sharing, deviceMenuOpen, micMuted, cameraOn])

  const appendRow = (role: Row['role'], text: string) => {
    if (!text) return
    setRows((previous) => [
      ...previous,
      { id: crypto.randomUUID(), role, text, createdAt: Date.now() },
    ])
  }

  const sendSessionUpdate = (withReadScreen: boolean) => {
    const channel = channelRef.current
    if (!channel || channel.readyState !== 'open') return
    const session: Record<string, unknown> = {
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
        threshold: 0.0,
        silence_duration_ms: 400,
      },
    }
    if (withReadScreen) session.tools = [READ_SCREEN_TOOL]
    channel.send(JSON.stringify({ type: 'session.update', session }))
  }

  const captureScreen = async (question: string): Promise<string> => {
    const video = screenRef.current
    if (!video || !video.videoWidth || !video.videoHeight)
      throw new Error('屏幕画面尚未准备好')
    const canvas = document.createElement('canvas')
    const scale = Math.min(
      1,
      1920 / Math.max(video.videoWidth, video.videoHeight)
    )
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法读取屏幕画面')
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
    setSnapshot(dataUrl)
    const image = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const result = await fetchApi<PhotoAnswer>('ai-call/photo/', {
      method: 'POST',
      body: JSON.stringify({
        session_id: sessionIdRef.current,
        question,
        image,
      }),
    })
    return result.answer
  }

  const handleTool = async (event: Record<string, unknown>) => {
    const callId = String(event.call_id ?? '')
    const name = String(event.name ?? '')
    if (!callId || seenCallsRef.current.has(callId)) return
    seenCallsRef.current.add(callId)
    if (name !== 'read_screen') return
    let question = '请读取当前屏幕上的内容。'
    try {
      const args = JSON.parse(String(event.arguments ?? '{}')) as {
        question?: string
      }
      if (args.question) question = args.question
    } catch {
      // Best-effort path: this failure must not block the call flow.
    }
    let output: string
    try {
      const answer = await captureScreen(question)
      setReadQuestion(question)
      setReadResult(answer)
      output = JSON.stringify({ success: true, answer })
    } catch (reason) {
      output = JSON.stringify({
        success: false,
        error: reason instanceof Error ? reason.message : '读屏失败',
      })
    }
    const channel = channelRef.current
    if (channel?.readyState !== 'open') return
    channel.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output },
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
    if (type === 'conversation.item.input_audio_transcription.completed') {
      setReadRequestedAt(0)
      appendRow('user', String(payload.transcript ?? ''))
      return
    }
    if (type === 'response.audio_transcript.delta') {
      const delta = String(payload.delta ?? '')
      if (!delta) return
      setRows((previous) => {
        const last = previous[previous.length - 1]
        if (last?.role === 'assistant' && last.id.startsWith('assistant-')) {
          return [
            ...previous.slice(0, -1),
            { ...last, text: last.text + delta },
          ]
        }
        return [
          ...previous,
          {
            id: `assistant-${String(payload.response_id ?? crypto.randomUUID())}`,
            role: 'assistant',
            text: delta,
            createdAt: Date.now(),
          },
        ]
      })
      return
    }
    if (type === 'response.function_call_arguments.done') {
      void handleTool(payload)
      return
    }
    if (type === 'response.output_item.done') {
      const item = payload.item as Record<string, unknown> | undefined
      if (item?.type === 'function_call') void handleTool(item)
    }
  }

  const stopCamera = () => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
    cameraStreamRef.current = null
    if (cameraRef.current) cameraRef.current.srcObject = null
    void videoSenderRef.current?.replaceTrack(null)
    setCameraOn(false)
  }

  const cleanup = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    timerRef.current = null
    if (reconnectTimerRef.current !== null)
      window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = null
    screenStreamRef.current?.getTracks().forEach((track) => track.stop())
    screenStreamRef.current = null
    stopCamera()
    micRef.current?.getTracks().forEach((track) => track.stop())
    micRef.current = null
    audioSenderRef.current = null
    channelRef.current?.close()
    channelRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    videoSenderRef.current = null
    if (audioRef.current) audioRef.current.srcObject = null
    if (cameraRef.current) cameraRef.current.srcObject = null
    setRemoteAudioReady(false)
    setSharing(false)
    setNetworkQuality('good')
  }

  const buildHistoryRecord = (): HistoryRecord | null => {
    if (!sessionIdRef.current || !startedAtRef.current) return null
    const rows = rowsRef.current
    const firstUserText = rows.find((row) => row.role === 'user')?.text.trim()
    const title =
      firstUserText ||
      (readQuestionRef.current
        ? `读取屏幕：${readQuestionRef.current}`
        : 'AI 通话')
    const summary = readResultRef.current.trim()
    return {
      id: crypto.randomUUID(),
      startedAt: startedAtRef.current,
      seconds: elapsedRef.current,
      rows,
      title,
      ...(summary ? { summary } : {}),
    }
  }

  const saveHistory = () => {
    const record = buildHistoryRecord()
    if (!record) return
    sessionIdRef.current = ''
    setHistory((previous) => {
      const next = [record, ...previous].slice(0, 20)
      persistHistory(next)
      return next
    })
    void pushAiCallHistory(record satisfies SyncRecord)
      .then((remoteId) => {
        if (!remoteId) return
        setHistory((previous) => {
          const next = previous.map((item) =>
            item.id === record.id ? { ...item, remoteId } : item
          )
          persistHistory(next)
          return next
        })
      })
      .catch(() => {})
  }

  const stop = () => {
    saveHistory()
    cleanup()
    setReconnecting(false)
    setStatus('ended')
  }

  useEffect(
    () => () => {
      const record = buildHistoryRecord()
      if (record) {
        try {
          localStorage.setItem(
            HISTORY_KEY,
            JSON.stringify([record, ...loadHistory()].slice(0, 20))
          )
        } catch {
          // Best-effort path: this failure must not block the call flow.
        }
      }
      cleanup()
      const bridge = window.weMeetDesktop?.aiCall
      if (bridge) void bridge.reportStatus({ state: 'ended' }).catch(() => {})
    },
    // This cleanup runs once on unmount; the refs it reads are intentionally stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  useEffect(() => {
    const persist = () => {
      const record = buildHistoryRecord()
      if (!record) return
      try {
        localStorage.setItem(
          HISTORY_KEY,
          JSON.stringify([record, ...loadHistory()].slice(0, 20))
        )
      } catch {
        // Best-effort path: this failure must not block the call flow.
      }
      sessionIdRef.current = ''
    }
    window.addEventListener('beforeunload', persist)
    return () => window.removeEventListener('beforeunload', persist)
  }, [])

  useEffect(() => {
    const bridge = window.weMeetDesktop?.aiCall
    if (!bridge) return
    if ((status === 'active' || status === 'sharing') && !startedAtRef.current)
      startedAtRef.current = Date.now()
    void bridge
      .reportStatus({
        state: status,
        startedAt: startedAtRef.current,
        sharing,
      })
      .catch(() => {})
  }, [status, sharing])

  const start = async (force = false) => {
    if (
      !force &&
      (status === 'connecting' || status === 'active' || status === 'sharing')
    )
      return
    setNetworkQuality('good')
    setError('')
    setRows([])
    setSnapshot('')
    setReadResult('')
    setReadQuestion('')
    setReadRequestedAt(0)
    setCameraOn(false)
    setMicMuted(false)
    setTab('chat')
    startedAtRef.current = undefined
    seenCallsRef.current.clear()
    setStatus('connecting')
    try {
      const config = await fetchApi<AgentConfig>('rooms/ai-agent-config/')
      const profile = config.profiles?.[0]
      if (!profile) throw new Error('没有可用的 AI 通话配置')

      const pc = new RTCPeerConnection()
      pcRef.current = pc
      pc.addEventListener('connectionstatechange', () => {
        if (pcRef.current !== pc) return
        if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected'
        ) {
          setNetworkQuality('offline')
          if (
            reconnectTimerRef.current === null &&
            reconnectAttemptsRef.current < 3
          ) {
            setReconnecting(true)
            reconnectTimerRef.current = window.setTimeout(() => {
              reconnectTimerRef.current = null
              reconnectAttemptsRef.current += 1
              cleanup()
              setStatus('idle')
              setError('')
              window.setTimeout(() => void start(true), 0)
            }, 2000)
          }
        } else if (pc.connectionState === 'connected') {
          reconnectAttemptsRef.current = 0
          setReconnecting(false)
          setNetworkQuality('good')
        }
      })
      let resolveUpdated: (() => void) | null = null
      const updated = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error('session.updated 超时')),
          20_000
        )
        resolveUpdated = () => {
          window.clearTimeout(timeout)
          resolve()
        }
      })
      const channel = pc.createDataChannel('oai-events', { ordered: true })
      channelRef.current = channel
      const attachChannel = (target: RTCDataChannel) => {
        target.addEventListener('message', (event) => {
          handleEvent(event)
          try {
            const parsed = JSON.parse(event.data) as { type?: string }
            if (parsed.type === 'session.updated') resolveUpdated?.()
          } catch {
            // Best-effort path: this failure must not block the call flow.
          }
        })
      }
      attachChannel(channel)
      pc.addEventListener('datachannel', (event) =>
        attachChannel(event.channel)
      )
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(micDeviceId ? { deviceId: { exact: micDeviceId } } : {}),
      }
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      })
      micRef.current = mic
      audioSenderRef.current = pc.addTrack(mic.getAudioTracks()[0], mic)
      void refreshDevices()
      const transceiver = pc.addTransceiver('video', { direction: 'sendrecv' })
      videoSenderRef.current = transceiver.sender
      pc.ontrack = (remote) => {
        if (audioRef.current) {
          audioRef.current.srcObject = remote.streams[0]
          void audioRef.current.play().catch(() => {})
        }
        setRemoteAudioReady(remote.streams[0].getAudioTracks().length > 0)
      }

      const opened = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error('DataChannel 打开超时')),
          15_000
        )
        channel.onopen = () => {
          window.clearTimeout(timeout)
          sendSessionUpdate(false)
          resolve()
        }
      })
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve()
        const timeout = window.setTimeout(resolve, 5_000)
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') {
            window.clearTimeout(timeout)
            resolve()
          }
        })
      })
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('无法生成 SDP')
      const answer = await fetchApi<CallAnswer>('ai-call/session/', {
        method: 'POST',
        body: JSON.stringify({
          profile_code: profile.code,
          transport: 'webrtc',
          photo_qa: true,
          sdp,
        }),
      })
      sessionIdRef.current = answer.session_lease?.id ?? ''
      if (!sessionIdRef.current) throw new Error('服务端没有返回通话租约')
      voiceRef.current = answer.voice || 'Tina'
      instructionsRef.current = `${answer.instructions?.trim() || '你是一个友好、简洁的 AI 助手。'} 用户共享屏幕时，如需读取屏幕上的文字或细节，请调用 read_screen，不要猜测屏幕内容。`
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      await opened
      await updated
      startedAtRef.current = Date.now()
      setStatus('active')
      setReconnecting(false)
      setElapsed(0)
      timerRef.current = window.setInterval(
        () => setElapsed((value) => value + 1),
        1000
      )
    } catch (reason) {
      cleanup()
      setStatus('error')
      setReconnecting(false)
      setError(reason instanceof Error ? reason.message : '连接失败')
    }
  }

  const toggleMic = () => {
    const track = micRef.current?.getAudioTracks()[0]
    if (!track) return
    const next = !micMuted
    track.enabled = !next
    setMicMuted(next)
  }

  const toggleCamera = async () => {
    if (status !== 'active') return
    if (cameraOn) {
      stopCamera()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          frameRate: { ideal: 15, max: 30 },
          width: { ideal: 640 },
          height: { ideal: 480 },
          ...(cameraDeviceId ? { deviceId: { exact: cameraDeviceId } } : {}),
        },
      })
      const track = stream.getVideoTracks()[0]
      if (!track) throw new Error('没有摄像头视频轨')
      void refreshDevices()
      cameraStreamRef.current = stream
      if (cameraRef.current) {
        cameraRef.current.srcObject = stream
        await cameraRef.current.play().catch(() => {})
      }
      await videoSenderRef.current?.replaceTrack(track)
      setCameraOn(true)
      track.onended = () => stopCamera()
    } catch (reason) {
      setError(mediaErrorMessage(reason, '无法打开摄像头'))
    }
  }

  const switchMic = async (deviceId: string) => {
    setMicDeviceId(deviceId)
    localStorage.setItem('we-meet:ai-call-mic', deviceId)
    if (
      !audioSenderRef.current ||
      (status !== 'active' && status !== 'sharing')
    )
      return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      })
      const track = stream.getAudioTracks()[0]
      if (!track) throw new Error('没有麦克风音频轨')
      track.enabled = !micMuted
      await audioSenderRef.current.replaceTrack(track)
      micRef.current?.getTracks().forEach((old) => old.stop())
      micRef.current = stream
      void refreshDevices()
    } catch (reason) {
      setError(mediaErrorMessage(reason, '无法切换麦克风'))
    }
  }

  const switchCamera = async (deviceId: string) => {
    setCameraDeviceId(deviceId)
    localStorage.setItem('we-meet:ai-call-camera', deviceId)
    if (!cameraOn) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          frameRate: { ideal: 15, max: 30 },
          width: { ideal: 640 },
          height: { ideal: 480 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      })
      const track = stream.getVideoTracks()[0]
      if (!track) throw new Error('没有摄像头视频轨')
      await videoSenderRef.current?.replaceTrack(track)
      cameraStreamRef.current?.getTracks().forEach((old) => old.stop())
      cameraStreamRef.current = stream
      if (cameraRef.current) {
        cameraRef.current.srcObject = stream
        await cameraRef.current.play().catch(() => {})
      }
      track.onended = () => stopCamera()
      void refreshDevices()
    } catch (reason) {
      setError(mediaErrorMessage(reason, '无法切换摄像头'))
    }
  }

  const share = async () => {
    if (!pcRef.current || status !== 'active') return
    setError('')
    if (cameraOn) stopCamera()
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15, max: 30 },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions)
      const track = stream.getVideoTracks()[0]
      if (!track) throw new Error('没有屏幕视频轨')
      screenStreamRef.current = stream
      if (screenRef.current) {
        screenRef.current.srcObject = stream
        await screenRef.current.play().catch(() => {})
      }
      await videoSenderRef.current?.replaceTrack(track)
      setSharing(true)
      sendSessionUpdate(true)
      setStatus('sharing')
      track.onended = () => stopShare()
    } catch (reason) {
      setError(
        reason instanceof Error &&
          (reason.name === 'NotAllowedError' || reason.name === 'AbortError')
          ? '已取消共享，或屏幕共享权限被拒绝。'
          : mediaErrorMessage(reason, '无法共享屏幕')
      )
    }
  }

  const stopShare = () => {
    const stream = screenStreamRef.current
    screenStreamRef.current = null
    stream?.getTracks().forEach((track) => track.stop())
    void videoSenderRef.current?.replaceTrack(null)
    setSharing(false)
    setStatus((current) => (current === 'sharing' ? 'active' : current))
    sendSessionUpdate(false)
  }

  const askReadScreen = () => {
    const channel = channelRef.current
    if (!sharing || channel?.readyState !== 'open') return
    setReadResult('')
    setReadQuestion('')
    setReadRequestedAt(Date.now())
    channel.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '请调用 read_screen 读取当前共享屏幕上的标题或主要文字，并简短告诉我。',
            },
          ],
        },
      })
    )
    channel.send(JSON.stringify({ type: 'response.create' }))
  }

  const sendText = () => {
    const text = draft.trim()
    const channel = channelRef.current
    if (!text || channel?.readyState !== 'open') return
    setReadRequestedAt(0)
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
    appendRow('user', text)
    setDraft('')
  }

  const removeHistory = (id: string) => {
    const record = history.find((item) => item.id === id)
    if (record?.remoteId) {
      void deleteRemoteCallHistory(record.remoteId).catch(() => {})
    }
    setHistory((previous) => {
      const next = previous.filter((item) => item.id !== id)
      persistHistory(next)
      return next
    })
    setExpandedHistory((current) => (current === id ? '' : current))
  }

  const mediaState = JSON.stringify({
    audio:
      micRef.current?.getAudioTracks().map((track) => track.readyState) ?? [],
    audioEnabled: micRef.current?.getAudioTracks()[0]?.enabled ?? false,
    micMuted,
    camera:
      cameraStreamRef.current
        ?.getVideoTracks()
        .map((track) => track.readyState) ?? [],
    screen:
      screenStreamRef.current
        ?.getVideoTracks()
        .map((track) => track.readyState) ?? [],
    screenSurface:
      screenStreamRef.current?.getVideoTracks()[0]?.getSettings()
        .displaySurface ?? '',
    sender: videoSenderRef.current?.track?.kind ?? '',
    senderState: videoSenderRef.current?.track?.readyState ?? '',
    remoteAudio: remoteAudioReady,
    connection: pcRef.current?.connectionState ?? '',
    channel: channelRef.current?.readyState ?? '',
    networkQuality,
  })

  const visibleRows = rows.filter(
    (row) =>
      !(
        readResult &&
        readRequestedAt &&
        row.role === 'assistant' &&
        (row.createdAt ?? 0) >= readRequestedAt
      )
  )

  const normalizedQuery = historyQuery.trim().toLowerCase()
  const filteredHistory = history.filter((record) => {
    if (!normalizedQuery) return true
    return `${record.title ?? ''} ${record.summary ?? ''} ${record.rows.map((row) => row.text).join(' ')}`
      .toLowerCase()
      .includes(normalizedQuery)
  })
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const historyGroups = new Map<string, HistoryRecord[]>()
  for (const record of filteredHistory) {
    const group =
      record.startedAt >= todayStart.getTime()
        ? '今天'
        : record.startedAt >= todayStart.getTime() - 86400000
          ? '昨天'
          : '更早'
    const list = historyGroups.get(group) ?? []
    list.push(record)
    historyGroups.set(group, list)
  }

  return (
    <Screen footer={false}>
      <div className={`ai-call ${compact ? 'ai-call--compact' : ''}`}>
        <header className="ai-call-header">
          {!compact && (
            <div>
              <span className="eyebrow">AI 通话</span>
              <h1>和 AI 说说话</h1>
              <p className="ai-call-subtitle">
                语音、摄像头或共享屏幕，都可以成为对话的一部分。
              </p>
              <p className="shortcut-hint">
                快捷键：M 静音 · C 摄像头 · S 共享 · Esc 挂断
              </p>
            </div>
          )}
          <div className="ai-call-header-status">
            <div
              ref={devicePickerRef}
              className={`device-picker ${deviceMenuOpen ? 'is-open' : ''}`}
            >
              <button
                type="button"
                className="device-button"
                aria-label="选择设备"
                aria-expanded={deviceMenuOpen}
                onClick={() => setDeviceMenuOpen((open) => !open)}
              >
                <RiSettings3Line size={16} aria-hidden="true" />
                设备
              </button>
              {deviceMenuOpen && (
                <div
                  className="device-menu"
                  role="dialog"
                  aria-label="设备设置"
                >
                  <label>
                    <span>麦克风</span>
                    <select
                      value={micDeviceId}
                      onChange={(event) => void switchMic(event.target.value)}
                    >
                      <option value="">系统默认</option>
                      {devices
                        .filter((device) => device.kind === 'audioinput')
                        .map((device, index) => (
                          <option
                            key={device.deviceId || index}
                            value={device.deviceId}
                          >
                            {device.label || `麦克风 ${index + 1}`}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    <span>摄像头</span>
                    <select
                      value={cameraDeviceId}
                      onChange={(event) =>
                        void switchCamera(event.target.value)
                      }
                    >
                      <option value="">系统默认</option>
                      {devices
                        .filter((device) => device.kind === 'videoinput')
                        .map((device, index) => (
                          <option
                            key={device.deviceId || index}
                            value={device.deviceId}
                          >
                            {device.label || `摄像头 ${index + 1}`}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
            <span
              className={`status-pill status-pill--${status}`}
              role="status"
              aria-live="polite"
            >
              {STATUS_LABEL[status]}
            </span>
            {(status === 'active' || status === 'sharing') && (
              <span
                className="call-timer"
                aria-label={`通话时长 ${formatDuration(elapsed)}`}
              >
                {formatDuration(elapsed)}
              </span>
            )}
          </div>
        </header>

        {error && status !== 'error' && (
          <p className="ai-call-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => setError('')}
            >
              <RiCloseLine size={14} aria-hidden="true" />
            </button>
          </p>
        )}

        <main className="ai-call-layout">
          <section className="call-stage" aria-label="通话画面">
            <div className="stage-media">
              <div className={`ai-orb ai-orb--${status}`} aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <video
                ref={screenRef}
                autoPlay
                muted
                playsInline
                data-testid="screen-preview"
                className={`stage-video stage-video--screen ${sharing ? 'is-visible' : ''}`}
              />
              <video
                ref={cameraRef}
                autoPlay
                muted
                playsInline
                data-testid="camera-preview"
                className={`stage-video stage-video--camera ${cameraOn && !sharing ? 'is-visible' : ''}`}
              />
              {!sharing && !cameraOn && (
                <div className="stage-empty">
                  <span className="stage-empty-icon" aria-hidden="true">
                    AI
                  </span>
                  <strong>
                    {status === 'idle'
                      ? '准备开始一段对话'
                      : status === 'active' || status === 'sharing'
                        ? 'AI 正在聆听'
                        : status === 'ended'
                          ? '本次通话已结束'
                          : STATUS_LABEL[status]}
                  </strong>
                  <p>
                    {status === 'idle'
                      ? '开始后你可以直接说话；需要看屏幕时再共享。'
                      : status === 'connecting'
                        ? '正在连接语音通道…'
                        : status === 'error'
                          ? error || '连接失败，请重试。'
                          : status === 'ended'
                            ? '记录已保存，可以重新开始一段对话。'
                            : '语音通道已连接。'}
                  </p>
                </div>
              )}
            </div>
            {(status === 'active' || status === 'sharing') && (
            <div className="stage-meta">
              <span
                className={`stage-live-dot ${status === 'active' || status === 'sharing' ? 'is-live' : ''}`}
              />
              <span>
                {sharing
                  ? '正在共享屏幕'
                  : cameraOn
                    ? '摄像头已开启'
                    : status === 'active'
                      ? 'AI 正在聆听'
                      : '未在通话'}
              </span>
              {(status === 'active' || status === 'sharing') && (
                <span
                  className={`network-quality network-quality--${networkQuality}`}
                >
                  {reconnecting ? '正在重连…' : NETWORK_LABEL[networkQuality]}
                </span>
              )}
              {networkQuality === 'offline' &&
                !reconnecting &&
                (status === 'active' || status === 'sharing') && (
                  <button
                    type="button"
                    className="stage-reconnect"
                    onClick={reconnect}
                  >
                    重新连接
                  </button>
                )}
              {sharing && (
                <span
                  className="stage-privacy"
                  title="AI 只能看到你正在共享的窗口或屏幕"
                >
                  <RiLock2Line size={12} aria-hidden="true" />
                  仅共享画面可见
                </span>
              )}
              {sharing && (
                <button
                  type="button"
                  className="stage-read-button"
                  onClick={askReadScreen}
                >
                  读取当前屏幕
                </button>
              )}
            </div>
            )}
            {(status === 'idle' ||
              status === 'ended' ||
              status === 'error') && (
              <button
                type="button"
                className="primary-action"
                onClick={() => void start()}
              >
                开始通话
              </button>
            )}
            {status === 'connecting' && (
              <button type="button" className="stage-cancel" onClick={stop}>
                取消连接
              </button>
            )}
          </section>

          <aside className="ai-call-panel" aria-label="对话与记录">
            <div className="panel-tabs" role="tablist" aria-label="通话内容">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'chat'}
                className={tab === 'chat' ? 'is-active' : ''}
                onClick={() => setTab('chat')}
              >
                <RiChat3Line size={16} aria-hidden="true" />
                对话
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'history'}
                className={tab === 'history' ? 'is-active' : ''}
                onClick={() => setTab('history')}
              >
                <RiHistoryLine size={16} aria-hidden="true" />
                通话记录
              </button>
            </div>

            {tab === 'chat' ? (
              <div className="panel-chat">
                <div
                  ref={transcriptRef}
                  className="transcript"
                  role="log"
                  aria-live="polite"
                  aria-label="通话对话"
                >
                  {visibleRows.length === 0 && !readResult && (
                    <div className="panel-empty">
                      <strong>
                        {status === 'active' || status === 'sharing'
                          ? '还没有对话内容'
                          : '开始后，对话会显示在这里'}
                      </strong>
                      <p>
                        {status === 'active' || status === 'sharing'
                          ? '说话或输入文字，内容会实时显示在这里。'
                          : '你可以说话，也可以输入文字。'}
                      </p>
                    </div>
                  )}
                  {visibleRows.map((row) => (
                    <div
                      key={row.id}
                      className={`transcript-row transcript-row--${row.role}`}
                    >
                      <span className="transcript-role">
                        {row.role === 'user' ? '你' : 'AI'}
                      </span>
                      <div className="transcript-bubble">
                        {row.role === 'assistant' ? (
                          <ReactMarkdown
                            components={{
                              a: ({ children, ...props }) => (
                                <a {...props} target="_blank" rel="noreferrer">
                                  {children}
                                </a>
                              ),
                            }}
                          >
                            {row.text}
                          </ReactMarkdown>
                        ) : (
                          row.text
                        )}
                      </div>
                    </div>
                  ))}
                  {readResult && (
                    <section
                      className="read-card"
                      data-testid="read-screen-result"
                    >
                      <div className="read-card-head">
                        <strong>屏幕读取</strong>
                        <span>刚刚</span>
                      </div>
                      {snapshot && <img src={snapshot} alt="屏幕读取截图" />}
                      {readQuestion && (
                        <p className="read-question">问题：{readQuestion}</p>
                      )}
                      <div className="read-answer">
                        <ReactMarkdown
                          components={{
                            a: ({ children, ...props }) => (
                              <a {...props} target="_blank" rel="noreferrer">
                                {children}
                              </a>
                            ),
                          }}
                        >
                          {readResult}
                        </ReactMarkdown>
                      </div>
                    </section>
                  )}
                </div>
                <form
                  className="composer"
                  onSubmit={(event) => {
                    event.preventDefault()
                    sendText()
                  }}
                >
                  <input
                    aria-label="输入消息"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={
                      status === 'active' || status === 'sharing'
                        ? '输入文字，或直接说话'
                        : '通话开始后可输入文字'
                    }
                    disabled={status !== 'active' && status !== 'sharing'}
                  />
                  <button
                    type="submit"
                    disabled={
                      !draft.trim() ||
                      (status !== 'active' && status !== 'sharing')
                    }
                  >
                    发送
                  </button>
                </form>
              </div>
            ) : (
              <div className="panel-history" data-testid="ai-call-history">
                <div className="history-toolbar">
                  <input
                    aria-label="搜索通话记录"
                    value={historyQuery}
                    onChange={(event) => setHistoryQuery(event.target.value)}
                    placeholder="搜索标题或对话内容"
                  />
                  <span>
                    {filteredHistory.length}/{history.length}
                  </span>
                </div>
                {history.length === 0 && (
                  <div className="panel-empty">
                    <strong>还没有通话记录</strong>
                    <p>完成一次 AI 通话后会出现在这里。</p>
                  </div>
                )}
                {history.length > 0 && filteredHistory.length === 0 && (
                  <div className="panel-empty">
                    <strong>没有匹配的通话</strong>
                    <p>换一个关键词试试。</p>
                  </div>
                )}
                {[...historyGroups.entries()].map(([group, records]) => (
                  <section key={group} className="history-group">
                    <h3>{group}</h3>
                    {records.map((record) => {
                      const first =
                        record.rows.find((row) => row.role === 'user')?.text ??
                        record.rows[0]?.text ??
                        ''
                      const title =
                        record.title?.trim() || first.trim() || 'AI 通话'
                      const duration = `${String(Math.floor(record.seconds / 60)).padStart(2, '0')}:${String(record.seconds % 60).padStart(2, '0')}`
                      return (
                        <article key={record.id} className="history-card">
                          <button
                            type="button"
                            className="history-main"
                            onClick={() =>
                              setExpandedHistory((current) =>
                                current === record.id ? '' : record.id
                              )
                            }
                            aria-expanded={expandedHistory === record.id}
                          >
                            <span className="history-title">
                              {title.length > 42
                                ? `${title.slice(0, 42)}…`
                                : title}
                            </span>
                            <span className="history-meta">
                              {new Date(record.startedAt).toLocaleString()} ·{' '}
                              {duration}
                            </span>
                            <span className="history-badges">
                              <span className="history-status">
                                {record.rows.length ? '已完成' : '无对话内容'}
                              </span>
                              {record.summary && (
                                <span className="history-badge">摘要</span>
                              )}
                              {!!record.todos?.length && (
                                <span className="history-badge">
                                  待办 {record.todos.length}
                                </span>
                              )}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="icon-button history-delete"
                            aria-label="删除通话记录"
                            onClick={() => removeHistory(record.id)}
                          >
                            <RiDeleteBin6Line size={16} aria-hidden="true" />
                          </button>
                          {expandedHistory === record.id && (
                            <div className="history-detail">
                              {record.summary && (
                                <p className="history-summary">
                                  {record.summary}
                                </p>
                              )}
                              {!!record.todos?.length && (
                                <ul className="history-todos">
                                  {record.todos.map((todo, index) => (
                                    <li
                                      key={`${todo.text}-${index}`}
                                      className={todo.done ? 'is-done' : ''}
                                    >
                                      {todo.done ? '✓' : '○'} {todo.text}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {record.rows.map((row) => (
                                <p key={row.id}>
                                  <strong>
                                    {row.role === 'user' ? '你' : 'AI'}：
                                  </strong>
                                  {row.text}
                                </p>
                              ))}
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </section>
                ))}
              </div>
            )}
          </aside>
        </main>

        {(status === 'active' || status === 'sharing') && (
          <footer className="control-dock" aria-label="通话控制">
            <button
              type="button"
              className={`control-button ${micMuted ? 'is-off' : ''}`}
              aria-pressed={!micMuted}
              aria-label={micMuted ? '取消静音' : '静音'}
              onClick={toggleMic}
              disabled={status !== 'active' && status !== 'sharing'}
            >
              {micMuted ? (
                <RiMicOffLine size={20} aria-hidden="true" />
              ) : (
                <RiMicLine size={20} aria-hidden="true" />
              )}
              <span>{micMuted ? '取消静音' : '静音'}</span>
            </button>
            <button
              type="button"
              className={`control-button ${cameraOn ? 'is-on' : ''}`}
              aria-pressed={cameraOn}
              onClick={toggleCamera}
              disabled={status !== 'active'}
            >
              {cameraOn ? (
                <RiVideoLine size={20} aria-hidden="true" />
              ) : (
                <RiVideoOffLine size={20} aria-hidden="true" />
              )}
              <span>{cameraOn ? '关闭摄像头' : '开启摄像头'}</span>
            </button>
            <button
              type="button"
              className={`control-button ${sharing ? 'is-on' : ''}`}
              aria-pressed={sharing}
              onClick={sharing ? stopShare : share}
              disabled={status !== 'active' && status !== 'sharing'}
            >
              <RiComputerLine size={20} aria-hidden="true" />
              <span>{sharing ? '停止共享' : '共享屏幕'}</span>
            </button>
            {(status === 'active' || status === 'sharing') && (
              <button type="button" className="end-button" onClick={stop}>
                <RiPhoneLine size={20} aria-hidden="true" />
                <span>挂断</span>
              </button>
            )}
          </footer>
        )}

        <pre data-testid="media-state" className="visually-hidden">
          {mediaState}
        </pre>
        {/* The live transcript above is the captions equivalent for this remote AI audio. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio
          ref={audioRef}
          autoPlay
          data-testid="remote-audio"
          className="visually-hidden"
        />
      </div>
    </Screen>
  )
}
