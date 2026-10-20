import { _electron as electron } from 'playwright'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const desktop = path.resolve('..', 'desktop')
const executablePath = path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'we-meet-ai-call-'))
const app = await electron.launch({
  executablePath,
  args: ['.'],
  cwd: desktop,
  env: {
    ...process.env,
    WEMEET_RENDERER_URL: 'http://127.0.0.1:4173',
    WEMEET_SERVICE_URL: 'http://127.0.0.1:4173',
    WEMEET_USER_DATA: userData,
  },
})
const main = await app.firstWindow()
await main.waitForLoadState('domcontentloaded')
await main.getByTestId('desktop-titlebar').waitFor({ timeout: 30000 })
console.log('main window ready')
await main.evaluate(() => window.weMeetDesktop.aiCall.open())
let float
for (let index = 0; index < 40; index += 1) {
  float = app.windows().find(candidate => candidate.url().includes('/ai-call-float'))
  if (float) break
  await new Promise(resolve => setTimeout(resolve, 250))
}
if (!float) throw new Error('AI call float window did not open')
await float.waitForLoadState('domcontentloaded')
console.log('float window:', float.url())
await float.getByRole('button', { name: '开始通话' }).waitFor({ timeout: 15000 })
console.log('float UI ready')
await float.screenshot({ path: 'electron-ai-call-float.png', fullPage: true })
await app.evaluate(({ app }) => app.exit(0))
try {
  fs.rmSync(userData, { recursive: true, force: true })
} catch {}
