// Post-release real-device re-check of the three admin findings (F1/F2/F3).
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { chromium } = require(
  path.join(__dirname, '..', 'src', 'frontend', 'node_modules', 'playwright')
)
const ADB = 'C:\\Users\\shaoj\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe'
const BASE = 'https://meet.we-meet.online'
const SHOTS = path.join(__dirname, 'post-release')
fs.mkdirSync(SHOTS, { recursive: true })

const shot = (name) => {
  const buf = execFileSync(ADB, ['exec-out', 'screencap', '-p'], {
    maxBuffer: 64 * 1024 * 1024,
  })
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), buf)
  return buf.length
}

const CHECK = () => {
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const visible = (el) => el.offsetParent !== null
  const buttons = [...document.querySelectorAll('button')].filter(visible).map(txt)
  const rows = [...document.querySelectorAll('tbody tr')].filter(visible)
  const firstRowCells = rows.length
    ? [...rows[0].querySelectorAll('td')].map((td) => {
        const range = document.createRange()
        range.selectNodeContents(td)
        const rect = range.getBoundingClientRect()
        return { text: txt(td), left: rect.left, right: rect.right }
      })
    : []
  const gaps = []
  for (let i = 1; i < firstRowCells.length; i++) {
    gaps.push(Math.round((firstRowCells[i].left - firstRowCells[i - 1].right) * 10) / 10)
  }
  const body = txt(document.body)
  return {
    href: location.href,
    innerWidth: window.innerWidth,
    readOnlyMedia: window.matchMedia('(max-width: 767px)').matches,
    createExportButtons: buttons.filter((b) => b.includes('创建导出')).length,
    mobileNoticeShown: body.includes('审计导出请在更宽的屏幕发起'),
    periodLabelShown: body.includes('配额期间'),
    periodValue: (body.match(/配额期间\s*(\d{4}-\d{2})/) || [])[1] || null,
    seatRowCount: rows.length,
    firstRowCellTexts: firstRowCells.map((c) => c.text),
    firstRowGaps: gaps,
    overflowX:
      document.documentElement.scrollWidth > window.innerWidth + 1
        ? document.documentElement.scrollWidth
        : 0,
    bundle: [...document.querySelectorAll('script[src]')]
      .map((s) => s.getAttribute('src'))
      .filter((s) => s && s.includes('index-'))
      .slice(0, 3),
  }
}

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 15000 })
  const ctx = browser.contexts()[0]
  let page = ctx.pages().find((p) => p.url().includes('meet.we-meet.online'))
  if (!page) page = await ctx.newPage()
  await page.bringToFront()
  const session = await page
    .goto(`${BASE}/work`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    .then(() => page.waitForTimeout(2500))
    .then(() =>
      page.evaluate(async () => {
        const r = await fetch('/work/v1/bootstrap', {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
        return { status: r.status }
      })
    )
    .catch((e) => ({ error: String(e.message || e).slice(0, 120) }))
  if (session.status !== 200) {
    console.log(JSON.stringify({ ok: false, reason: 'device session lost', session }))
    await browser.close()
    return
  }
  await page.goto(`${BASE}/admin/work`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(3500)
  let out = null
  for (let i = 0; i < 3 && !out; i++) {
    try {
      out = await page.evaluate(CHECK)
    } catch (e) {
      await page.waitForTimeout(2000)
    }
  }
  const bytes = shot('admin-after')
  const verdict =
    out &&
    out.readOnlyMedia === true &&
    out.createExportButtons === 0 &&
    out.mobileNoticeShown === true &&
    out.periodLabelShown === true &&
    !!out.periodValue &&
    out.overflowX === 0 &&
    out.firstRowGaps.length === 3 &&
    out.firstRowGaps.every((g) => g >= 4)
  console.log(
    JSON.stringify({ ok: true, pass: !!verdict, session, shotBytes: bytes, checks: out }, null, 1)
  )
  await browser.close()
}

main().catch((e) => {
  console.log(JSON.stringify({ fatal: String(e.message || e).slice(0, 300) }))
  process.exitCode = 1
})
