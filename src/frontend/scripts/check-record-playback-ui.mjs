// Local fixture-only visual and interaction checks; no account or production writes.
// Start Vite on port 3191, then run: node scripts/check-record-playback-ui.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3191'
const output = 'test-results/record-playback'
await mkdir(output, { recursive: true })
function wave(seconds) {
  const pcm = 16000 * 2 * seconds
  const buffer = Buffer.alloc(44 + pcm)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + pcm, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(pcm, 40)
  return buffer
}
const wholeAudio = wave(25)
const chunks = [wave(10), wave(10), wave(5)]
let kind = 'audio'
let videoBytes
const browser = await chromium.launch({ headless: true })
const errors = []
let page
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  })
  await context.route('**/record-player-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root" style="height:100dvh;display:flex;flex-direction:column;font-family:Arial,sans-serif"></div></html>',
    })
  )
  await context.route('**/api/v1.0/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (/\/audio\/chunk-\d\/$/.test(path)) {
      return route.fulfill({
        contentType: 'audio/wav',
        body: chunks[Number(path.match(/chunk-(\d)/)[1])],
      })
    }
    if (path.endsWith('/audio/'))
      return route.fulfill({
        json: {
          manifest: null,
          next_after_sequence: null,
          results: chunks.map((chunk, index) => ({
            id: `chunk-${index}`,
            sequence: index + 1,
            start_ms: index * 10000,
            duration_ms: index === 2 ? 5000 : 10000,
            stored: true,
            byte_size: chunk.length,
            checksum: createHash('sha256').update(chunk).digest('hex'),
          })),
        },
      })
    if (path.endsWith('/capture-sessions/capture/'))
      return route.fulfill({
        json: {
          id: 'capture',
          record_id: 'capture-record',
          status: 'stopped',
          media_status: 'saved',
        },
      })
    if (path.endsWith('/media/'))
      return route.fulfill({
        json: {
          url: `${origin}/fixtures/${kind}`,
          expires_in: 3600,
          media_type: kind,
          name: kind === 'video' ? 'review.webm' : 'review.wav',
          content_type: kind === 'video' ? 'video/webm' : 'audio/wav',
          size: wholeAudio.length,
        },
      })
    if (path.includes('original-segments'))
      return route.fulfill({
        json: {
          results: Array.from({ length: 12 }, (_, index) => ({
            id: `segment-${index}`,
            speaker_label: index % 2 ? '李明' : '王晓',
            start_ms: index * 2000,
            end_ms: index * 2000 + 2000,
            text: [
              '本周先完成播放器与文字记录页面的体验优化。',
              '音频和视频使用统一的控制栏，播放操作集中在左侧。',
              '移动端需要保留足够的阅读空间，并支持随时回到播放位置。',
            ][index % 3],
          })),
          next_cursor: null,
        },
      })
    if (/\/meeting-records\/[^/]+\/$/.test(path))
      return route.fulfill({
        json: {
          id: kind === 'capture' ? 'capture-record' : 'record',
          title: '产品体验评审 · 播放器优化',
          source_type: kind === 'capture' ? 'audio_recording' : 'upload',
          capture_id: kind === 'capture' ? 'capture' : null,
          origin_at: '2026-09-23T01:06:00Z',
          revision: 1,
          capabilities: {
            read_transcript: true,
            read_summary: false,
            play_media: true,
          },
        },
      })
    return route.fulfill({ json: { results: [], next_cursor: null } })
  })
  await context.route('**/fixtures/*', (route) => {
    const bytes = kind === 'video' ? videoBytes : wholeAudio
    const range = /bytes=(\d+)-(\d*)/.exec(
      route.request().headers().range ?? ''
    )
    const start = range ? Number(range[1]) : 0
    const end = range?.[2]
      ? Math.min(Number(range[2]), bytes.length - 1)
      : bytes.length - 1
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: kind === 'video' ? 'video/webm' : 'audio/wav',
      headers: {
        'accept-ranges': 'bytes',
        ...(range
          ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` }
          : {}),
      },
      body: bytes.subarray(start, end + 1),
    })
  })
  page = await context.newPage()
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  await page.goto(`${origin}/record-player-harness`)
  // A small, genuine video stream exercises paused frames and full screen without external media.
  videoBytes = Buffer.from(
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 360
      const drawing = canvas.getContext('2d')
      drawing.fillStyle = '#1e3a7a'
      drawing.fillRect(0, 0, 640, 360)
      drawing.fillStyle = '#fff'
      drawing.font = '28px sans-serif'
      drawing.fillText('Meeting playback preview', 120, 185)
      const stream = canvas.captureStream(10)
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' })
      const pieces = []
      const done = new Promise((resolve) => {
        recorder.onstop = resolve
      })
      recorder.ondataavailable = (event) => pieces.push(event.data)
      recorder.start()
      const frames = setInterval(() => {
        drawing.fillRect(0, 0, 1, 1)
      }, 100)
      await new Promise((resolve) => setTimeout(resolve, 1200))
      clearInterval(frames)
      recorder.stop()
      await done
      stream.getTracks().forEach((track) => track.stop())
      return Array.from(new Uint8Array(await new Blob(pieces).arrayBuffer()))
    })
  )
  const mount = async () => {
    await page.evaluate(async (capture) => {
      const runtime = (await import('/@react-refresh')).default
      runtime.injectIntoGlobalHook(window)
      window.$RefreshReg$ = () => {}
      window.$RefreshSig$ = () => (type) => type
      window.__vite_plugin_react_preamble_installed__ = true
      await import('/src/styles/index.css')
      await import('/src/i18n/init.ts')
      const React = (await import('/node_modules/.vite/deps/react.js')).default
      const { createRoot } = (
        await import('/node_modules/.vite/deps/react-dom_client.js')
      ).default
      const { QueryClient, QueryClientProvider } =
        await import('/node_modules/.vite/deps/@tanstack_react-query.js')
      const { RecordWorkspace } =
        await import('/src/features/meetings/routes/MeetingRecordWorkspace.tsx')
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      if (!window.playerRoot)
        window.playerRoot = createRoot(document.getElementById('root'))
      window.playerRoot.render(
        React.createElement(
          React.Suspense,
          { fallback: null },
          React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(RecordWorkspace, {
              key: `${capture}-${Date.now()}`,
              recordId: capture ? 'capture-record' : 'record',
              viewerId: 'fixture-reader',
            })
          )
        )
      )
    }, kind === 'capture')
    await page
      .getByRole('button', { name: '播放', exact: true })
      .waitFor()
      .catch(async (error) => {
        console.error(await page.locator('body').innerText())
        await page.screenshot({ path: `${output}/failure.png`, fullPage: true })
        throw error
      })
  }
  await mount()
  const controls = page.locator('[data-record-playback-controls]')
  const checkControlOrder = async () => {
    const speed = await controls.getByRole('combobox').boundingBox()
    const time = await controls.locator('[data-playback-time]').boundingBox()
    assert.ok(
      speed.x + speed.width <= time.x + 2,
      'time follows speed in every media mode'
    )
    assert.ok(
      Math.abs(speed.y + speed.height / 2 - time.y - time.height / 2) < 2,
      'speed and time share a row in every media mode'
    )
  }
  const checkAudioAtTop = async () => {
    await checkControlOrder()
    const title = await page.getByRole('heading', { level: 1 }).boundingBox()
    const player = await controls.boundingBox()
    const tabs = await page.getByRole('tablist').boundingBox()
    assert.ok(
      title.y + title.height <= player.y,
      'audio player follows the title'
    )
    assert.ok(
      player.y + player.height <= tabs.y,
      'audio player stays above the tabs'
    )
  }
  const slider = controls.getByRole('slider', { name: '音频位置' })
  await expect(slider).toBeEnabled()
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  await slider.fill('6000')
  await expect(page.locator('[data-segment-id="segment-3"]')).toHaveAttribute(
    'aria-current',
    'true'
  )
  await page.locator('[data-segment-id="segment-3"]').hover()
  await page.mouse.wheel(0, 180)
  const follow = page.getByRole('button', { name: '跟随', exact: true })
  await expect(follow).toHaveCount(0)
  const returnToPlayback = page.getByRole('button', {
    name: '回到播放位置',
    exact: true,
  })
  await expect(returnToPlayback).toBeVisible()
  await page.waitForTimeout(4500)
  await expect(returnToPlayback).toBeVisible()
  await returnToPlayback.click()
  await expect(returnToPlayback).toHaveCount(0)
  await expect(page.locator('audio')).not.toHaveAttribute('controls')
  for (const [width, theme] of [
    [1280, 'light'],
    [390, 'light'],
    [320, 'dark'],
  ]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
    }, theme)
    await expect(follow).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
      )
      .toBe(true)
    const playBox = await controls
      .getByRole('button', { name: '播放', exact: true })
      .boundingBox()
    await checkAudioAtTop()
    const barBox = await controls.boundingBox()
    assert.ok(playBox.x - barBox.x < 20, 'transport starts at the left')
    const trackBox = await slider.boundingBox()
    assert.ok(
      Math.abs(trackBox.width - barBox.width) < 1,
      'timeline fills the content pane'
    )
    if (width >= 560) {
      assert.ok(barBox.height <= 80, 'desktop controls stay compact')
      const timeBox = await controls
        .locator('[data-playback-time]')
        .boundingBox()
      assert.ok(
        Math.abs(
          timeBox.y + timeBox.height / 2 - playBox.y - playBox.height / 2
        ) < 1,
        'time aligns with transport controls'
      )
    }
    assert.ok(barBox.y + barBox.height <= 900, 'controls stay visible')
    const targets = await controls
      .locator('button,select')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect()
          return {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            height: r.height,
          }
        })
      )
    targets.forEach((target, index) => {
      assert.ok(target.height >= 44, 'touch targets retain their height')
      for (const other of targets.slice(0, index))
        assert.ok(
          target.left >= other.right - 1 ||
            other.left >= target.right - 1 ||
            target.top >= other.bottom - 1 ||
            other.top >= target.bottom - 1,
          'controls do not overlap'
        )
    })
    await page.screenshot({
      path: `${output}/audio-${width}-${theme}.png`,
      fullPage: true,
    })
  }
  const checkVolume = async (element) => {
    await page.getByRole('button', { name: '静音', exact: true }).focus()
    const volume = page.getByRole('slider', { name: '播放音量' })
    await volume.fill('0.35')
    await expect
      .poll(() => element.evaluate((media) => media.volume))
      .toBe(0.35)
    await page.getByRole('button', { name: '静音', exact: true }).click()
    await expect.poll(() => element.evaluate((media) => media.muted)).toBe(true)
    await page.getByRole('button', { name: '取消静音', exact: true }).click()
    await expect
      .poll(() => element.evaluate((media) => media.muted))
      .toBe(false)
    await expect
      .poll(() => element.evaluate((media) => media.volume))
      .toBe(0.35)
    await slider.focus()
    await page.mouse.move(0, 0)
    await expect(volume).toBeHidden()
  }
  await checkVolume(page.locator('audio'))
  kind = 'capture'
  await mount()
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  await expect(slider).toBeEnabled()
  await checkVolume(page.locator('audio'))
  await page.screenshot({
    path: `${output}/capture-320-dark.png`,
    fullPage: true,
  })
  await checkAudioAtTop()
  kind = 'video'
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await mount()
  const video = page.locator('video')
  await video.waitFor()
  const surface = page.locator('[data-video-expanded=true]')
  const checkVideoControlLayout = async () => {
    await checkControlOrder()
    const time = surface.locator('[data-playback-time]')
    await expect(time).toHaveCount(1)
    const clock = await time.boundingBox()
    const full = await surface
      .getByRole('button', { name: '全屏', exact: true })
      .boundingBox()
    await expect(
      surface.getByRole('button', { name: '跟随', exact: true })
    ).toHaveCount(0)
    const speed = surface.getByRole('combobox')
    const track = await speed.boundingBox()
    const play = await surface
      .getByRole('button', { name: '播放', exact: true })
      .boundingBox()
    const collapse = await surface
      .locator('[data-video-header] button[aria-expanded]')
      .boundingBox()
    assert.ok(track.x + track.width <= clock.x + 2, 'time follows speed')
    assert.ok(
      Math.abs(track.y + track.height / 2 - clock.y - clock.height / 2) < 2,
      'speed and time share a row'
    )
    assert.ok(full.y + full.height < play.y, 'fullscreen stays above transport')
    const header = await surface.locator('[data-video-header]').boundingBox()
    assert.ok(
      Math.abs(full.x + full.width - header.x - header.width) < 2,
      'fullscreen aligns with the right edge'
    )
    assert.ok(
      collapse.x + collapse.width <= full.x,
      'fullscreen is at the top right'
    )
    assert.ok(
      Math.abs(full.y + full.height / 2 - collapse.y - collapse.height / 2) < 2,
      'fullscreen and collapse share the top row'
    )
  }
  await checkVideoControlLayout()
  const paneBox = await page.locator('[role=tablist]').boundingBox()
  const videoBox = await video.boundingBox()
  const divider = page.getByRole('separator', { name: '调整视频与内容宽度' })
  await expect(divider).toHaveAttribute('aria-valuenow', '50')
  assert.ok(
    Math.abs(videoBox.width - paneBox.width) <= 1,
    'video and tabs start at equal widths'
  )
  await video.evaluate((element) => {
    window.fixtureVideo = element
  })
  const handleBox = await divider.boundingBox()
  const dragX = handleBox.x + handleBox.width / 2
  const dragY = handleBox.y + 100
  await page.mouse.move(dragX, dragY)
  await page.mouse.down()
  await page.mouse.move(dragX + 120, dragY, { steps: 8 })
  await page.mouse.up()
  assert.ok(
    (await video.boundingBox()).width > videoBox.width + 100,
    'dragging increases video width'
  )
  assert.equal(
    await video.evaluate((element) => element === window.fixtureVideo),
    true
  )
  await page.screenshot({ path: `${output}/video-resized.png`, fullPage: true })
  await divider.dblclick()
  await expect(divider).toHaveAttribute('aria-valuenow', '50')
  await divider.press('ArrowLeft')
  await expect(divider).toHaveAttribute('aria-valuenow', '48')
  await divider.press('Home')
  assert.ok(
    (await video.boundingBox()).width >= 319,
    'video retains its minimum width'
  )
  await divider.press('End')
  await checkVideoControlLayout()
  assert.ok(
    (await page.locator('[role=tablist]').boundingBox()).width >= 319,
    'text retains its minimum width'
  )
  await divider.press('Enter')
  await expect(divider).toHaveAttribute('aria-valuenow', '50')
  assert.ok(
    videoBox.x + videoBox.width <= paneBox.x,
    'desktop video sits beside the text'
  )
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    ),
    true
  )
  await video.evaluate((element) => {
    element.loop = true
  })
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.getByRole('tab', { name: '文字记录', exact: true }).click()
  await expect(surface).toHaveAttribute('data-controls-visible', 'false')
  await expect(page.locator('[data-video-controls]')).toHaveCSS('opacity', '0')
  await video.hover()
  await expect(page.locator('[data-video-controls]')).toHaveCSS('opacity', '1')
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  await video.evaluate((element) => {
    window.fixtureVideo = element
  })
  await page.getByRole('button', { name: '收起视频' }).click()
  await expect(video).toBeHidden()
  await expect(divider).toBeHidden()
  await checkControlOrder()
  await page.screenshot({
    path: `${output}/video-collapsed.png`,
    fullPage: true,
  })
  await page.getByRole('button', { name: '展开视频' }).click()
  assert.equal(
    await video.evaluate((element) => element === window.fixtureVideo),
    true
  )
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await page.getByRole('button', { name: '退出全屏', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), true)
  await checkVolume(video)
  await page.screenshot({ path: `${output}/video-fullscreen.png` })
  await page.getByRole('button', { name: '退出全屏', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => !document.fullscreenElement))
    .toBe(true)
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true)
  // Headless Escape does not perform the browser chrome's native exit action.
  // Exiting through the DOM API exercises the same fullscreenchange event.
  await page.evaluate(() => document.exitFullscreen())
  await expect
    .poll(() => page.evaluate(() => !document.fullscreenElement))
    .toBe(true)
  assert.equal(
    await video.evaluate((element) => element === window.fixtureVideo),
    true
  )
  await page.screenshot({ path: `${output}/video-inline.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(divider).toBeHidden()
  const mobileVideo = await video.boundingBox()
  const mobileText = await page.locator('[role=tablist]').boundingBox()
  assert.ok(
    mobileVideo.y + mobileVideo.height <= mobileText.y,
    'mobile video sits above the text'
  )
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    ),
    true
  )
  await page.screenshot({ path: `${output}/video-mobile.png`, fullPage: true })
  await checkVideoControlLayout()
  assert.deepEqual(errors, [])
  console.log(
    `Playback UI passed: real audio, verified capture chunks, shared controls, 320/390/1280px, light/dark, follow, video collapse and full screen. Screenshots: ${output}`
  )
} catch (error) {
  if (page) {
    console.error(
      await page.evaluate(() => ({
        media: [...document.querySelectorAll('audio,video')].map((media) => ({
          time: media.currentTime,
          duration: media.duration,
          paused: media.paused,
        })),
        slider: document.querySelector('input[type=range]')?.value,
        active: [...document.querySelectorAll('[aria-current=true]')].map(
          (row) => row.getAttribute('data-segment-id')
        ),
      }))
    )
    await page.screenshot({ path: `${output}/failure.png`, fullPage: true })
  }
  throw error
} finally {
  await browser.close()
}
