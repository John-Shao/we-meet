// Real native capture of this test's own static window, followed by a local
// WebRTC decode. No meeting, external peer, audio, keyboard or mouse input.
// Launch through Node so shells wait for the GUI child and the inherited
// ELECTRON_RUN_AS_NODE setting cannot turn it into a different execution mode.
if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = require('node:child_process').spawn(require('electron'), [__filename],
    { env, stdio: 'inherit', windowsHide: true })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
  return
}
const { app, BrowserWindow, desktopCapturer, session } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
let outputDirectory
const fatal = error => {
  try {
    if (outputDirectory) require('node:fs').writeFileSync(path.join(outputDirectory, 'fatal.json'),
      JSON.stringify({ passed: false, error: String(error?.message ?? error) }) + '\n')
  } finally { app.exit(1) }
}
// Unattended tests must terminate with evidence rather than an Electron error
// dialog if their launcher or stream fails.
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)

async function measure() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false,
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } } })
  const track = stream.getVideoTracks()[0]
  const sending = new RTCPeerConnection({ iceServers: [] }), receiving = new RTCPeerConnection({ iceServers: [] })
  const video = document.querySelector('video')
  let frame = 0, sampling, stopped = false
  const ice = pc => pc.iceGatheringState === 'complete' ? Promise.resolve() : new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('ICE gathering timeout')), 10000)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve() }
    })
  })
  try {
    const remoteTrack = new Promise(resolve => receiving.addEventListener('track', event => resolve(event.track), { once: true }))
    const sender = sending.addTrack(track, stream)
    const transceiver = sending.getTransceivers().find(item => item.sender === sender)
    const vp8 = RTCRtpReceiver.getCapabilities('video').codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/vp8')
    if (!vp8.length) throw Error('VP8 unavailable')
    transceiver.setCodecPreferences(vp8)
    await sending.setLocalDescription(await sending.createOffer()); await ice(sending)
    await receiving.setRemoteDescription(sending.localDescription)
    await receiving.setLocalDescription(await receiving.createAnswer()); await ice(receiving)
    await sending.setRemoteDescription(receiving.localDescription)
    const parameters = sender.getParameters()
    for (const encoding of parameters.encodings) { encoding.maxFramerate = 15; encoding.maxBitrate = 2500000 }
    await sender.setParameters(parameters)
    video.srcObject = new MediaStream([await remoteTrack]); await video.play()
    const firstFrame = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('No decoded frame')), 10000)
      frame = video.requestVideoFrameCallback(() => { clearTimeout(timeout); resolve(performance.now()) })
    })
    let lastFrame = firstFrame, rendered = 1, maxGapMs = 0, maxFrameAgeMs = 0, unavailableSamples = 0
    const gaps = []
    const onFrame = () => {
      if (stopped) return
      const now = performance.now(), gap = now - lastFrame
      lastFrame = now; rendered++; maxGapMs = Math.max(maxGapMs, gap)
      if (gaps.length < 4096) gaps.push(gap)
      frame = video.requestVideoFrameCallback(onFrame)
    }
    frame = video.requestVideoFrameCallback(onFrame)
    sampling = setInterval(() => {
      maxFrameAgeMs = Math.max(maxFrameAgeMs, performance.now() - lastFrame)
      if (document.visibilityState !== 'visible' || video.paused || video.readyState < 2 || !video.videoWidth || track.readyState !== 'live') unavailableSamples++
    }, 100)
    await new Promise(resolve => setTimeout(resolve, 60000))
    maxFrameAgeMs = Math.max(maxFrameAgeMs, performance.now() - lastFrame)
    const stats = [...(await receiving.getStats()).values()]
    const inbound = stats.find(item => item.type === 'inbound-rtp' && item.kind === 'video')
    const codec = stats.find(item => item.id === inbound?.codecId)
    const elapsedMs = performance.now() - firstFrame
    const ordered = [...gaps].sort((a, b) => a - b)
    // Snapshot the actual decoded pixels before stopping either peer. A later
    // capturePage can correctly show black after the media stream has closed.
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    context.drawImage(video, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let nonBlackPixels = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) nonBlackPixels++
    const nonBlackRatio = nonBlackPixels / (canvas.width * canvas.height)
    return { elapsedMs, rendered, maxGapMs, maxFrameAgeMs, unavailableSamples,
      snapshotPng: canvas.toDataURL('image/png'), nonBlackRatio,
      p95GapMs: ordered[Math.floor(ordered.length * .95)] ?? null,
      capture: { width: track.getSettings().width, height: track.getSettings().height,
        frameRate: track.getSettings().frameRate, contentHint: track.contentHint },
      decoded: { width: video.videoWidth, height: video.videoHeight, framesDecoded: inbound?.framesDecoded,
        framesDropped: inbound?.framesDropped, bytesReceived: inbound?.bytesReceived, codec: codec?.mimeType },
      passed: elapsedMs >= 60000 && rendered > 1 && maxGapMs < 3000 && maxFrameAgeMs < 3000 && unavailableSamples === 0 && nonBlackRatio > .5 }
  } finally {
    stopped = true; clearInterval(sampling)
    if (frame) video.cancelVideoFrameCallback(frame)
    sending.close(); receiving.close(); for (const item of stream.getTracks()) item.stop()
  }
}

async function main() {
  const root = path.resolve(__dirname, '../test-results')
  await fs.mkdir(root, { recursive: true })
  const output = await fs.mkdtemp(path.join(root, 'static-frame-'))
  outputDirectory = output
  app.setPath('userData', path.join(output, 'profile'))
  let source, receiver, exitCode = 1
  const deadline = setTimeout(() => { console.error('Static frame probe timed out'); app.exit(1) }, 100000)
  try {
    await app.whenReady()
    const partition = session.fromPartition(`static-frame-${randomUUID()}`)
    partition.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }))
    const preferences = { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    source = new BrowserWindow({ width: 640, height: 440, show: false, autoHideMenuBar: true, title: 'We-Meet static source test', webPreferences: preferences })
    receiver = new BrowserWindow({ width: 640, height: 440, show: false, autoHideMenuBar: true, title: 'We-Meet static receiver test', webPreferences: preferences })
    partition.setDisplayMediaRequestHandler(async (request, done) => {
      try {
        if (request.frame !== receiver.webContents.mainFrame || !request.videoRequested || request.audioRequested || source.isDestroyed()) return done({})
        const ownedId = source.getMediaSourceId().split(':')[1]
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
        if (source.isDestroyed() || receiver.isDestroyed() || source.getMediaSourceId().split(':')[1] !== ownedId || request.frame !== receiver.webContents.mainFrame) return done({})
        const chosen = sources.filter(item => item.id.startsWith(`window:${ownedId}:`))
        if (chosen.length !== 1) throw Error('Test-owned source missing or ambiguous')
        done({ video: chosen[0] })
      } catch { done({}) }
    })
    const sourceFile = path.join(output, 'source.html'), receiverFile = path.join(output, 'receiver.html')
    await fs.writeFile(sourceFile, '<!doctype html><meta charset="utf-8"><title>We-Meet static source test</title><body style="margin:0;background:#1b3154;color:white;font:24px sans-serif;padding:40px"><h1>静态画面测试</h1><p>此窗口内容保持不变。</p><p>仅在本机接收，约 60 秒后自动关闭。</p><div style="background:#22bba0;height:65px;width:60%"></div></body>')
    await fs.writeFile(receiverFile, '<!doctype html><meta charset="utf-8"><title>We-Meet static receiver test</title><body style="margin:0;background:#eee;font:16px sans-serif"><p>仅显示本测试创建的窗口；不操作键鼠。</p><video muted autoplay playsinline style="width:100%;height:330px;object-fit:contain"></video></body>')
    await source.loadFile(sourceFile); await receiver.loadFile(receiverFile)
    source.showInactive(); receiver.showInactive()
    const bounds = source.getBounds(); receiver.setPosition(bounds.x + 660, bounds.y)
    console.log(`Static source cadence measurement started: ${output}`)
    const { snapshotPng, ...result } = await receiver.webContents.executeJavaScript(`(${measure.toString()})()`, true)
    if (!snapshotPng.startsWith('data:image/png;base64,')) throw Error('Decoded snapshot unavailable')
    await fs.writeFile(path.join(output, 'decoded-frame.png'), Buffer.from(snapshotPng.slice('data:image/png;base64,'.length), 'base64'))
    const report = { ...result, electron: process.versions.electron, chrome: process.versions.chrome,
      scope: 'Test-owned native window capture, local VP8 WebRTC, no SFU, no remote input; does not replace independent-device full-screen acceptance',
      recordedAt: new Date().toISOString() }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report)); console.log(`Report: ${path.join(output, 'report.json')}`)
    exitCode = result.passed ? 0 : 1
  } catch (error) {
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: false, error: error.message }) + '\n')
    console.error(error.message)
  } finally {
    clearTimeout(deadline)
    if (source && !source.isDestroyed()) source.destroy()
    if (receiver && !receiver.isDestroyed()) receiver.destroy()
    app.exit(exitCode)
  }
}
main().catch(error => { console.error(error.message); app.exit(1) })
