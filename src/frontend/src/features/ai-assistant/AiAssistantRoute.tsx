import { useRef, useState } from 'react'
import { fetchApi } from '@/api/fetchApi'

type Status = 'idle' | 'connecting' | 'active' | 'error'
type Row = { id: string; role: 'user' | 'assistant'; text: string }
type AgentProfile = { code: string }
type AgentConfig = { profiles: AgentProfile[] }
type CallAnswer = { sdp: string; voice?: string; instructions?: string }

export function AiAssistantRoute() {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [draft, setDraft] = useState('')

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const serverChannelRef = useRef<RTCDataChannel | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const responseRef = useRef<{ id: string; text: string } | null>(null)
  const voiceRef = useRef('Tina')
  const instructionsRef = useRef('你是一个友好、简洁的 AI 助手。')

  const append = (role: Row['role'], text: string) => {
    if (!text) return
    setRows(previous => [...previous, { id: crypto.randomUUID(), role, text }])
  }

  const cleanup = () => {
    channelRef.current?.close()
    serverChannelRef.current?.close()
    channelRef.current = null
    serverChannelRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    void audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
  }

  const send = () => {
    const text = draft.trim()
    const channel = channelRef.current
    if (!text || !channel || channel.readyState !== 'open') return
    channel.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    }))
    channel.send(JSON.stringify({ type: 'response.create' }))
    append('user', text)
    setDraft('')
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
      if (response?.id) responseRef.current = { id: response.id, text: '' }
      return
    }
    if (type === 'response.text.delta' || type === 'response.audio_transcript.delta') {
      const delta = String(payload.delta ?? '')
      if (!delta) return
      const current = responseRef.current
      if (!current) {
        append('assistant', delta)
        return
      }
      current.text += delta
      setRows(previous => {
        const index = previous.findIndex(row => row.id === `assistant-${current.id}`)
        if (index >= 0) {
          const next = previous.slice()
          next[index] = { ...next[index], text: current.text }
          return next
        }
        return [...previous, { id: `assistant-${current.id}`, role: 'assistant', text: current.text }]
      })
    }
  }

  const attach = (channel: RTCDataChannel) => {
    channel.addEventListener('message', handleEvent)
    if (channel.label === 'txt') serverChannelRef.current = channel
  }

  const start = async () => {
    if (status === 'connecting' || status === 'active') return
    setStatus('connecting')
    setError('')
    setRows([])
    try {
      const config = await fetchApi<AgentConfig>('rooms/ai-agent-config/')
      const profile = config.profiles?.[0]
      if (!profile) throw new Error('没有可用的 AI 对话配置')

      const audioContext = new AudioContext()
      audioContextRef.current = audioContext
      await audioContext.resume()
      const destination = audioContext.createMediaStreamDestination()
      const oscillator = audioContext.createOscillator()
      const gain = audioContext.createGain()
      gain.gain.value = 0
      oscillator.connect(gain).connect(destination)
      oscillator.start()

      const pc = new RTCPeerConnection()
      pcRef.current = pc
      const channel = pc.createDataChannel('oai-events', { ordered: true })
      channelRef.current = channel
      attach(channel)
      pc.addEventListener('datachannel', event => attach(event.channel))
      pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream)

      let resolveUpdated: (() => void) | null = null
      const updated = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('AI 对话连接超时')), 20_000)
        resolveUpdated = () => {
          window.clearTimeout(timer)
          resolve()
        }
      })
      const opened = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('AI 对话通道打开超时')), 15_000)
        channel.onopen = () => {
          window.clearTimeout(timer)
          resolve()
        }
      })
      pc.addEventListener('datachannel', event => {
        event.channel.addEventListener('message', payload => {
          try {
            if ((JSON.parse(payload.data) as { type?: string }).type === 'session.updated')
              resolveUpdated?.()
          } catch {}
        })
      })

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await new Promise<void>(resolve => {
        if (pc.iceGatheringState === 'complete') return resolve()
        const timer = window.setTimeout(resolve, 5_000)
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') {
            window.clearTimeout(timer)
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
          photo_qa: false,
          sdp,
        }),
      })
      voiceRef.current = answer.voice || 'Tina'
      instructionsRef.current = answer.instructions || instructionsRef.current
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      await opened
      sendSessionUpdate()
      await updated
      setStatus('active')
    } catch (reason) {
      cleanup()
      setStatus('error')
      setError(reason instanceof Error ? reason.message : 'AI 对话连接失败')
    }
  }

  const sendSessionUpdate = () => {
    const channel = channelRef.current
    if (!channel || channel.readyState !== 'open') return
    channel.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm',
        output_audio_format: 'pcm',
        voice: voiceRef.current,
        instructions: instructionsRef.current,
        input_audio_transcription: { model: 'qwen3-asr-flash-realtime', language: 'zh' },
        turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 },
      },
    }))
  }

  const openCall = () => {
    const bridge = window.weMeetDesktop?.aiCall
    if (bridge) void bridge.open().catch(() => {})
  }

  return (
    <div style={{ padding: 24, maxWidth: 840, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>AI 助手</h1>
        <button type="button" onClick={openCall} disabled={!window.weMeetDesktop?.aiCall}>
          AI 打电话
        </button>
      </div>
      <p style={{ color: '#666' }}>文字对话；需要共享屏幕或语音时打开通话浮窗。</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '16px 0' }}>
        <strong>
          {status === 'idle' ? '未开始' : status === 'connecting' ? '正在连接' : status === 'active' ? '对话中' : '连接失败'}
        </strong>
        {(status === 'idle' || status === 'error') && <button onClick={start}>开始对话</button>}
        {status === 'active' && <button onClick={() => { cleanup(); setStatus('idle') }}>结束对话</button>}
      </div>
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      <div style={{ minHeight: 240, border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
        {rows.length === 0 && <p style={{ color: '#999' }}>开始对话后输入问题。</p>}
        {rows.map(row => (
          <p key={row.id} style={{ margin: '8px 0' }}>
            <strong>{row.role === 'user' ? '你' : 'AI'}：</strong>{row.text}
          </p>
        ))}
      </div>
      <form
        onSubmit={event => {
          event.preventDefault()
          send()
        }}
        style={{ display: 'flex', gap: 8, marginTop: 12 }}
      >
        <input
          aria-label="输入 AI 消息"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          disabled={status !== 'active'}
          placeholder={status === 'active' ? '输入问题' : '开始对话后可输入'}
          style={{ flex: 1, padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6 }}
        />
        <button type="submit" disabled={status !== 'active' || !draft.trim()}>发送</button>
      </form>
    </div>
  )
}
