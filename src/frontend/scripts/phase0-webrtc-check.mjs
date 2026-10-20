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
  ],
})
const page = await browser.newPage()
await page.goto(`http://127.0.0.1:${port}/`)

const offer = await page.evaluate(async ({ withAudio, withVideo, withPreVideo, withData }) => {
  const pc = new RTCPeerConnection()
  const channel = withData ? pc.createDataChannel('oai-events', { ordered: true }) : null
  window.__phase0 = { pc, channel }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: withAudio,
    video: withVideo,
  })
  const videoTrack = withVideo ? stream.getVideoTracks()[0] : null
  window.__phase0.videoTrack = videoTrack
  // Qwen expects audio before video; keep video silent until session.created.
  if (videoTrack) videoTrack.enabled = false
  if (withAudio) pc.addTrack(stream.getAudioTracks()[0], stream)
  if (withVideo) pc.addTrack(videoTrack, stream)
  if (withPreVideo && !withVideo) pc.addTransceiver('video', { direction: 'sendrecv' })
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
}, { withAudio, withVideo, withPreVideo, withData })

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
  if (!channel) {
    await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !['connected', 'failed', 'disconnected'].includes(pc.connectionState)) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return { channel: 'none', ice: pc.iceConnectionState, connection: pc.connectionState, events }
  }
  channel.addEventListener('message', (event) => {
    if (events.length < 8) events.push(String(event.data).slice(0, 500))
  })
  const videoTrack = window.__phase0.videoTrack
  channel.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(String(event.data))
      if (parsed?.type === 'session.created' && videoTrack && !videoTrack.enabled) {
        videoTrack.enabled = true
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
      if (events.length < 8) events.push(String(message.data).slice(0, 500))
    })
  })
  await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
  sendUpdate()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (channel.readyState === 'open' && events.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return {
    channel: channel.readyState,
    ice: pc.iceConnectionState,
    connection: pc.connectionState,
    events,
  }
}, answer)

console.log('channel:', result.channel, 'ice:', result.ice, 'connection:', result.connection)
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
