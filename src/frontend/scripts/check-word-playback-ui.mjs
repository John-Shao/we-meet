// Local fixture QA; never calls ASR or reads account recordings.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3191'
const output = 'test-results/word-playback'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const [width, theme] of [
    [390, 'light'],
    [1280, 'dark'],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      reducedMotion: 'reduce',
    })
    await context.route('**/api/v1.0/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      })
    )
    const page = await context.newPage()
    await page.goto(origin)
    await page.evaluate(
      async ({ theme }) => {
        const runtime = (await import('/@react-refresh')).default
        runtime.injectIntoGlobalHook(window)
        window.$RefreshReg$ = () => {}
        window.$RefreshSig$ = () => (type) => type
        window.__vite_plugin_react_preamble_installed__ = true
        await import('/src/styles/index.css')
        await import('/src/i18n/init.ts')
        const React = (await import('/node_modules/.vite/deps/react.js'))
          .default
        const { createRoot } = (
          await import('/node_modules/.vite/deps/react-dom_client.js')
        ).default
        const { TranscriptSegment } =
          await import('/src/features/meetings/components/TranscriptSegment.tsx')
        const { usePlaybackFollow, useTranscriptFollow } =
          await import('/src/features/meetings/transcriptSync.ts')
        document.documentElement.dataset.theme = theme
        const root = document.createElement('div')
        document.body.replaceChildren(root)
        const text =
          '我们，Hello 我们。' + '会议记录需要准确的播放定位。'.repeat(240)
        const tokens = [
          { start_offset: 0, end_offset: 2, start_ms: 0, end_ms: 400 },
          { start_offset: 3, end_offset: 8, start_ms: 500, end_ms: 900 },
          { start_offset: 9, end_offset: 11, start_ms: 900, end_ms: 1500 },
        ]
        // Build from the actual source string, so punctuation remains outside words.
        let offset = 12,
          clock = 1500
        for (const part of text.slice(12).split('。').filter(Boolean)) {
          tokens.push({
            start_offset: offset,
            end_offset: offset + part.length,
            start_ms: clock,
            end_ms: clock + 600,
          })
          offset += part.length + 1
          clock += 700
        }
        const hash = [
          ...new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(text)
            )
          ),
        ]
          .map((x) => x.toString(16).padStart(2, '0'))
          .join('')
        const alignment = {
          status: 'available',
          version: 1,
          alignment_revision: 1,
          time_basis: 'segment_source',
          offset_unit: 'utf16',
          text_sha256: hash,
          tokens,
        }
        window.wordSeeks = []
        function Harness() {
          const [position, setPosition] = React.useState(600)
          const [edited, setEdited] = React.useState(false)
          const container = React.useRef(null)
          const follow = usePlaybackFollow([])
          window.wordFixture = {
            setPosition,
            setEdited,
            resume: follow.resumeFollowing,
          }
          useTranscriptFollow({
            containerRef: container,
            activeId: 'sample',
            follow: { ...follow, positionMs: position },
          })
          return React.createElement(
            'main',
            { style: { padding: 24 } },
            React.createElement('h1', {}, '字词级播放跟踪'),
            React.createElement(
              'div',
              {
                ref: container,
                id: 'transcript',
                style: { height: 520, overflowY: 'auto', padding: '0 16px' },
              },
              React.createElement(TranscriptSegment, {
                segmentId: 'sample',
                speaker: '说话人 1',
                active: true,
                text: edited ? '已修订的原文' : text,
                playbackAlignment: alignment,
                positionMs: position,
                time: '00:00',
                highlight: 'Hello',
                onSeek: () => {},
                onWordSeek: (ms) => {
                  window.wordSeeks.push(ms)
                  setPosition(ms)
                  follow.resumeFollowing()
                },
              })
            )
          )
        }
        createRoot(root).render(React.createElement(Harness))
      },
      { theme }
    )
    const active = page.locator('[data-playing-word]')
    await expect(active).toHaveText('Hello')
    await page.screenshot({ path: `${output}/${width}-${theme}.png` })
    await page.locator('[data-word-index="2"]').click()
    assert.deepEqual(await page.evaluate(() => window.wordSeeks), [900])
    await expect(active).toHaveText('我们')
    await page.evaluate(() => window.wordFixture.setPosition(450))
    await expect(active).toHaveCount(0)
    await page.evaluate(() => window.wordFixture.setPosition(150000))
    await expect(active).toHaveCount(1)
    await expect
      .poll(() => page.locator('#transcript').evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0)
    await page.locator('#transcript').dispatchEvent('wheel')
    const scrollTop = await page
      .locator('#transcript')
      .evaluate((el) => el.scrollTop)
    await page.evaluate(() => window.wordFixture.setPosition(600))
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator('#transcript').evaluate((el) => el.scrollTop),
      scrollTop
    )
    await page.evaluate(() => window.wordFixture.resume())
    await expect
      .poll(() => page.locator('#transcript').evaluate((el) => el.scrollTop))
      .toBeLessThan(scrollTop)
    await page.evaluate(() => window.wordFixture.setEdited(true))
    await expect(page.locator('[data-word-index]')).toHaveCount(0)
    await expect(page.locator('article p')).toHaveText('已修订的原文')
    await context.close()
  }
  console.log(
    'Word playback: highlight, seek, silence, long-paragraph follow, manual-scroll suppression and correction fallback passed at 390/1280px.'
  )
} finally {
  await browser.close()
}
