import http from 'node:http'
import { chromium } from 'playwright'

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body><button id="share">share</button></body></html>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
    '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture',
  ],
})
const page = await browser.newPage()
await page.goto(`http://127.0.0.1:${port}/`)
const result = await page.evaluate(async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    const track = stream.getVideoTracks()[0]
    return {
      ok: true,
      label: track?.label,
      settings: track?.getSettings(),
      state: track?.readyState,
    }
  } catch (error) {
    return { ok: false, name: error.name, message: error.message }
  }
})
console.log(result)
await browser.close()
server.close()
