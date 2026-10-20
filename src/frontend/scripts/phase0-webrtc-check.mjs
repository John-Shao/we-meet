import http from 'node:http'
import process from 'node:process'
import { chromium } from 'playwright'

const token = process.env.WE_MEET_ACCESS_TOKEN
const base = process.env.WE_MEET_BASE_URL || 'https://meet.we-meet.online'
const profileCode = process.env.WE_MEET_PROFILE_CODE || 'qwen-omni-realtime'
const mode = process.env.WE_MEET_MODE || 'avd'
const withAudio = mode.includes('a')
const withVideo = mode.includes('v')
const withPreVideo = mode.includes('p')
const withData = mode.includes('d')
const replaceVideo = process.env.WE_MEET_REPLACE === '1'
const useDisplay = process.env.WE_MEET_DISPLAY === '1'

if (!token) {
  console.error('WE_MEET_ACCESS_TOKEN is required')
  process.exit(2)
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body>phase0</body></html>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    ...(useDisplay ? [
      '--auto-select-desktop-capture-source=Entire screen',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
    ] : []),
  ],
})
const page = await browser.newPage()
await page.goto(`http://127.0.0.1:${port}/`)

const offer = await page.evaluate(async ({ withAudio, withVideo, withPreVideo, withData, useDisplay }) => {
  const pc = new RTCPeerConnection()
  const channel = withData ? pc.createDataChannel('oai-events', { ordered: true }) : null
  window.__phase0 = { pc, channel }
  let displayTrack = null
  if (useDisplay) {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    displayTrack = display.getVideoTracks()[0]
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: withAudio,
    video: withVideo,
  })
  const videoTrack = withVideo ? stream.getVideoTracks()[0] : null
  window.__phase0.videoTrack = videoTrack
  window.__phase0.displayTrack = displayTrack
  // Qwen expects audio before video; keep video silent until session.created.
  if (videoTrack) videoTrack.enabled = false
  if (withAudio) pc.addTrack(stream.getAudioTracks()[0], stream)
  if (withVideo) pc.addTrack(videoTrack, stream)
  if ((withPreVideo && !withVideo) || useDisplay) pc.addTransceiver('video', { direction: 'sendrecv' })
  const description = await pc.createOffer()
  await pc.setLocalDescription(description)
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const timer = setTimeout(resolve, 5000)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  return { sdp: pc.localDescription.sdp, ice: pc.iceGatheringState }
}, { withAudio, withVideo, withPreVideo, withData, useDisplay })

const mlines = offer.sdp.split(/\r?\n/).filter((line) => line.startsWith('m='))
console.log('mode:', mode, 'offer m-lines:', mlines.join(' | '), 'ice:', offer.ice)
const expected = [
  withAudio ? 'm=audio ' : null,
  withVideo ? 'm=video ' : null,
  withData ? 'm=application ' : null,
].filter(Boolean)
if (expected.some((prefix) => !mlines.some((line) => line.startsWith(prefix)))) {
  throw new Error(`offer is missing expected m-line: ${expected.join(', ')}`)
}

const response = await fetch(`${base}/api/v1.0/ai-call/session/`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    profile_code: profileCode,
    transport: 'webrtc',
    photo_qa: true,
    sdp: offer.sdp,
  }),
})
const body = await response.text()
console.log('session status:', response.status)
if (!response.ok) {
  console.log('session error:', body.slice(0, 1000))
  await browser.close()
  server.close()
  process.exit(1)
}
const answer = JSON.parse(body)
console.log('answer keys:', Object.keys(answer).join(','), 'has SDP:', Boolean(answer.sdp))

const result = await page.evaluate(async (payload) => {
  const { pc, channel } = window.__phase0
  const events = []
  let negotiation = 0
  pc.addEventListener('negotiationneeded', () => { negotiation += 1 })
  if (!channel) {
    await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !['connected', 'failed', 'disconnected'].includes(pc.connectionState)) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return { channel: 'none', ice: pc.iceConnectionState, connection: pc.connectionState, events, negotiation }
  }
  channel.addEventListener('message', (event) => {
    if (events.length < 12) events.push(String(event.data).slice(0, 500))
  })
  const videoTrack = window.__phase0.videoTrack
  let videoEnabled = false
  channel.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(String(event.data))
      if (parsed?.type === 'session.updated' && videoTrack && !videoEnabled) {
        videoEnabled = true
        // Audio must be flowing before the first video frame reaches the model.
        setTimeout(() => { videoTrack.enabled = true }, 800)
      }
    } catch {}
  })
  let updateSent = false
  const sendUpdate = () => {
    if (updateSent || channel.readyState !== 'open') return
    updateSent = true
    channel.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm',
        output_audio_format: 'pcm',
        voice: payload.voice || 'Tina',
        instructions: payload.instructions || 'You are a helpful assistant.',
        input_audio_transcription: { model: 'qwen3-asr-flash-realtime', language: 'zh' },
        turn_detection: { type: 'server_vad', threshold: 0.0, silence_duration_ms: 400 },
      },
    }))
  }
  channel.addEventListener('open', sendUpdate)
  if (channel.readyState === 'open') sendUpdate()
  pc.addEventListener('datachannel', (event) => {
    event.channel.addEventListener('message', (message) => {
      if (events.length < 12) events.push(String(message.data).slice(0, 500))
    })
  })
  await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
  sendUpdate()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (channel.readyState === 'open' && events.some((event) => event.includes('"session.updated"'))) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  let replaced = false
  let displayLabel = null
  let stopped = false
  if (payload.useDisplay) {
    const displayTrack = window.__phase0.displayTrack
    const sender = pc.getSenders().find((candidate) => candidate.track === null)
    if (sender && displayTrack) {
      displayLabel = displayTrack.label
      await sender.replaceTrack(displayTrack)
      replaced = true
      await new Promise((resolve) => setTimeout(resolve, 2500))
      displayTrack.stop()
      await sender.replaceTrack(null)
      stopped = true
    }
  } else if (payload.replaceVideo) {
    const sender = pc.getSenders().find((candidate) => candidate.track === null)
    if (sender) {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 360
      const context = canvas.getContext('2d')
      context.fillStyle = '#f2f2f2'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#111'
      context.font = '32px sans-serif'
      context.fillText('Phase 0 screen frame', 30, 80)
      const stream = canvas.captureStream(2)
      await sender.replaceTrack(stream.getVideoTracks()[0])
      replaced = true
      await new Promise((resolve) => setTimeout(resolve, 2500))
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1200))
  return {
    channel: channel.readyState,
    ice: pc.iceConnectionState,
    connection: pc.connectionState,
    videoEnabled,
    replaced,
    displayLabel,
    stopped,
    negotiation,
    events,
  }
}, { ...answer, replaceVideo, useDisplay })

console.log('channel:', result.channel, 'ice:', result.ice, 'connection:', result.connection)
console.log('videoEnabled:', result.videoEnabled, 'replaced:', result.replaced, 'negotiation:', result.negotiation)
console.log('displayLabel:', result.displayLabel, 'stopped:', result.stopped)
console.log('server events:', result.events.length)
for (const event of result.events) console.log('event:', event)

const image = process.env.WE_MEET_TEST_IMAGE
if (image && answer.session_lease?.id) {
  const photo = await fetch(`${base}/api/v1.0/ai-call/photo/`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: answer.session_lease.id,
      question: 'What is in this image?',
      image,
    }),
  })
  const photoBody = await photo.text()
  console.log('photo status:', photo.status, 'body:', photoBody.slice(0, 300))
}

await browser.close()
server.close()
if (result.connection === 'failed' || result.channel === 'closed') process.exit(1)
