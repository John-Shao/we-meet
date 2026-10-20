import { useEffect, useRef, useState } from 'react'
import { fetchApi } from '@/api/fetchApi'

type CallStatus = 'idle' | 'connecting' | 'active' | 'sharing' | 'error' | 'ended'
type Row = { id: string; role: 'user' | 'assistant'; text: string }

type AgentProfile = { code: string; display_name?: string }
type AgentConfig = { profiles: AgentProfile[] }
type CallAnswer = {
  sdp: string
  voice?: string
  instructions?: string
  session_lease?: { id: string }
}
type PhotoAnswer = { answer: string }

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

export function AiCallRoute() {
  const [status, setStatus] = useState<CallStatus>('idle')
  const [error, setError] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [sharing, setSharing] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [snapshot, setSnapshot] = useState('')
  const [readResult, setReadResult] = useState('')
  const [elapsed, setElapsed] = useState(0)

  const audioRef = useRef<HTMLAudioElement>(null)
  const screenRef = useRef<HTMLVideoElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const micRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const videoSenderRef = useRef<RTCRtpSender | null>(null)
  const startedAtRef = useRef<number | undefined>(undefined)
  const sessionIdRef = useRef('')
  const voiceRef = useRef('Tina')
  const instructionsRef = useRef('你是一个友好、简洁的 AI 助手。')
  const seenCallsRef = useRef(new Set<string>())
  const timerRef = useRef<number | null>(null)

  const appendRow = (role: Row['role'], text: string) => {
    if (!text) return
    setRows(previous => [...previous, { id: crypto.randomUUID(), role, text }])
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
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime', language: 'zh' },
      turn_detection: { type: 'server_vad', threshold: 0.0, silence_duration_ms: 400 },
    }
    if (withReadScreen) session.tools = [READ_SCREEN_TOOL]
    channel.send(JSON.stringify({ type: 'session.update', session }))
  }

  const captureScreen = async (question: string): Promise<string> => {
    const video = screenRef.current
    if (!video || !video.videoWidth || !video.videoHeight) throw new Error('屏幕画面尚未准备好')
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight))
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
      body: JSON.stringify({ session_id: sessionIdRef.current, question, image }),
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
      const args = JSON.parse(String(event.arguments ?? '{}')) as { question?: string }
      if (args.question) question = args.question
    } catch {}
    let output: string
    try {
      const answer = await captureScreen(question)
      setReadResult(answer)
      appendRow('assistant', answer)
      output = JSON.stringify({ success: true, answer })
    } catch (reason) {
      output = JSON.stringify({
        success: false,
        error: reason instanceof Error ? reason.message : '读屏失败',
      })
    }
    const channel = channelRef.current
    if (channel?.readyState !== 'open') return
    channel.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    }))
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
      appendRow('user', String(payload.transcript ?? ''))
      return
    }
    if (type === 'response.audio_transcript.delta') {
      const delta = String(payload.delta ?? '')
      if (!delta) return
      setRows(previous => {
        const last = previous[previous.length - 1]
        if (last?.role === 'assistant' && last.id.startsWith('assistant-')) {
          return [...previous.slice(0, -1), { ...last, text: last.text + delta }]
        }
        return [...previous, {
          id: `assistant-${String(payload.response_id ?? crypto.randomUUID())}`,
          role: 'assistant',
          text: delta,
        }]
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
    cameraStreamRef.current?.getTracks().forEach(track => track.stop())
    cameraStreamRef.current = null
    void videoSenderRef.current?.replaceTrack(null)
    setCameraOn(false)
  }

  const cleanup = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    timerRef.current = null
    screenStreamRef.current?.getTracks().forEach(track => track.stop())
    screenStreamRef.current = null
    stopCamera()
    micRef.current?.getTracks().forEach(track => track.stop())
    micRef.current = null
    channelRef.current?.close()
    channelRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    videoSenderRef.current = null
    if (audioRef.current) audioRef.current.srcObject = null
    setSharing(false)
  }

  const stop = () => {
    cleanup()
    setStatus('ended')
  }

  useEffect(() => () => {
    cleanup()
    const bridge = window.weMeetDesktop?.aiCall
    if (bridge) void bridge.reportStatus({ state: 'ended' }).catch(() => {})
  }, [])

  useEffect(() => {
    const bridge = window.weMeetDesktop?.aiCall
    if (!bridge) return
    if ((status === 'active' || status === 'sharing') && !startedAtRef.current)
      startedAtRef.current = Date.now()
    void bridge.reportStatus({
      state: status,
      startedAt: startedAtRef.current,
      sharing,
    }).catch(() => {})
  }, [status, sharing])

  const start = async () => {
    if (status === 'connecting' || status === 'active' || status === 'sharing') return
    setError('')
    setRows([])
    setSnapshot('')
    setReadResult('')
    setCameraOn(false)
    startedAtRef.current = undefined
    seenCallsRef.current.clear()
    setStatus('connecting')
    try {
      const config = await fetchApi<AgentConfig>('rooms/ai-agent-config/')
      const profile = config.profiles?.[0]
      if (!profile) throw new Error('没有可用的 AI 通话配置')

      const pc = new RTCPeerConnection()
      pcRef.current = pc
      let resolveUpdated: (() => void) | null = null
      const updated = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('session.updated 超时')), 20_000)
        resolveUpdated = () => {
          window.clearTimeout(timeout)
          resolve()
        }
      })
      const channel = pc.createDataChannel('oai-events', { ordered: true })
      channelRef.current = channel
      const attachChannel = (target: RTCDataChannel) => {
        target.addEventListener('message', event => {
          handleEvent(event)
          try {
            const parsed = JSON.parse(event.data) as { type?: string }
            if (parsed.type === 'session.updated') resolveUpdated?.()
          } catch {}
        })
      }
      attachChannel(channel)
      pc.addEventListener('datachannel', event => attachChannel(event.channel))
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      micRef.current = mic
      pc.addTrack(mic.getAudioTracks()[0], mic)
      const transceiver = pc.addTransceiver('video', { direction: 'sendrecv' })
      videoSenderRef.current = transceiver.sender
      pc.ontrack = remote => {
        if (audioRef.current) {
          audioRef.current.srcObject = remote.streams[0]
          void audioRef.current.play().catch(() => {})
        }
      }

      const opened = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('DataChannel 打开超时')), 15_000)
        channel.onopen = () => {
          window.clearTimeout(timeout)
          sendSessionUpdate(false)
          resolve()
        }
      })
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await new Promise<void>(resolve => {
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
      setStatus('active')
      setElapsed(0)
      timerRef.current = window.setInterval(() => setElapsed(value => value + 1), 1000)
    } catch (reason) {
      cleanup()
      setStatus('error')
      setError(reason instanceof Error ? reason.message : '连接失败')
    }
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
        },
      })
      const track = stream.getVideoTracks()[0]
      if (!track) throw new Error('没有摄像头视频轨')
      cameraStreamRef.current = stream
      await videoSenderRef.current?.replaceTrack(track)
      setCameraOn(true)
      track.onended = () => stopCamera()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法打开摄像头')
    }
  }

  const share = async () => {
    if (!pcRef.current || status !== 'active') return
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
      setError(reason instanceof Error ? reason.message : '无法共享屏幕')
    }
  }

  const stopShare = () => {
    const stream = screenStreamRef.current
    screenStreamRef.current = null
    stream?.getTracks().forEach(track => track.stop())
    void videoSenderRef.current?.replaceTrack(null)
    setSharing(false)
    setStatus(current => (current === 'sharing' ? 'active' : current))
    sendSessionUpdate(false)
  }

  const askReadScreen = () => {
    const channel = channelRef.current
    if (!sharing || channel?.readyState !== 'open') return
    channel.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '请调用 read_screen 读取当前共享屏幕上的标题或主要文字，并简短告诉我。',
        }],
      },
    }))
    channel.send(JSON.stringify({ type: 'response.create' }))
  }

  return (
    <div style={{ padding: 24, maxWidth: 980, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, margin: '0 0 8px' }}>AI 打电话</h1>
      <p style={{ color: '#666', marginTop: 0 }}>PC WebRTC 原型：语音 + 屏幕共享 + 读屏</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '16px 0' }}>
        <strong>{STATUS_LABEL[status]}</strong>
        {sharing && <span>· 正在共享屏幕</span>}
        {(status === 'active' || status === 'sharing') && <span>{elapsed}s</span>}
        {status === 'idle' || status === 'ended' || status === 'error'
          ? <button onClick={start}>开始通话</button>
          : <button onClick={stop}>挂断</button>}
        {status === 'active' && <button onClick={toggleCamera}>{cameraOn ? '关闭摄像头' : '开启摄像头'}</button>}
        {status === 'active' && <button onClick={share}>共享屏幕</button>}
        {status === 'sharing' && <button onClick={stopShare}>停止共享</button>}
        {status === 'sharing' && <button onClick={askReadScreen}>让 AI 读屏</button>}
      </div>
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      <audio ref={audioRef} autoPlay />
      <video ref={screenRef} autoPlay muted playsInline style={{ display: 'none' }} />
      {snapshot && (
        <img
          src={snapshot}
          alt="屏幕读取截图"
          style={{ maxWidth: 320, border: '1px solid #ddd', borderRadius: 8 }}
        />
      )}
      {readResult && <p data-testid="read-screen-result">读屏：{readResult}</p>}
      <div style={{ marginTop: 16, borderTop: '1px solid #eee', paddingTop: 12 }}>
        {rows.map(row => (
          <p key={row.id} style={{ margin: '8px 0' }}>
            <strong>{row.role === 'user' ? '你' : 'AI'}：</strong>{row.text}
          </p>
        ))}
      </div>
    </div>
  )
}
