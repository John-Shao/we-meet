// Real-device (HONOR/Android Chrome over CDP) verification of the R0a mobile read-only surface.
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const { chromium } = require(
  path.join(__dirname, '..', 'src', 'frontend', 'node_modules', 'playwright')
)

const BASE = 'https://meet.we-meet.online'
const ADB = 'C:\\Users\\shaoj\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe'
const SHOTS = path.join(__dirname, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })

const shot = (name) => {
  const buf = execFileSync(ADB, ['exec-out', 'screencap', '-p'], {
    maxBuffer: 64 * 1024 * 1024,
  })
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), buf)
  return buf.length
}

const FACTS = () => {
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const boxes = [...document.querySelectorAll('textarea')]
  return {
    href: location.href,
    innerWidth: window.innerWidth,
    readOnlyMedia: window.matchMedia('(max-width: 767px)').matches,
    textareaCount: boxes.length,
    textareasVisible: boxes.filter((b) => b.offsetParent !== null).length,
    buttons: [...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null)
      .map(txt)
      .filter(Boolean)
      .slice(0, 24),
    links: [...document.querySelectorAll('a')]
      .filter((a) => a.offsetParent !== null)
      .map((a) => ({ t: txt(a), h: a.getAttribute('href') || '' }))
      .filter((l) => l.t)
      .slice(0, 30),
    headings: [...document.querySelectorAll('h1,h2,h3')].map(txt).filter(Boolean).slice(0, 8),
    body: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    overflowX:
      document.documentElement.scrollWidth > window.innerWidth + 1
        ? document.documentElement.scrollWidth
        : 0,
  }
}

async function collect(page, name, route) {
  await page.goto(`${BASE}${route}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  })
  await page.waitForTimeout(3000)
  let facts = null
  for (let i = 0; i < 3 && !facts; i++) {
    try {
      facts = await page.evaluate(FACTS)
    } catch (e) {
      await page.waitForTimeout(2000)
    }
  }
  const bytes = shot(name)
  return { name, route, ...(facts || { evalError: true }), shotBytes: bytes }
}

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', {
    timeout: 15000,
  })
  const ctx = browser.contexts()[0]
  const existing = ctx.pages().find((p) => p.url().includes('meet.we-meet.online'))
  const owned = !existing
  const page = existing || (await ctx.newPage())
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
        const j = await r.json().catch(() => null)
        return {
          status: r.status,
          member: j && j.member ? { id: j.member.user_id, role: j.member.role } : null,
          org: j && j.org ? { id: j.org.org_id, name: j.org.name } : null,
          hasCsrf: !!(j && j.csrf_token),
        }
      })
    )
    .catch((e) => ({ error: String(e.message || e).slice(0, 160) }))

  if (!session || session.status !== 200) {
    console.log(JSON.stringify({ ok: false, reason: 'no Work session on device', session }))
    if (owned) await page.close()
    await browser.close()
    return
  }

  const tasks = await page.evaluate(async () => {
    const r = await fetch('/work/v1/tasks?limit=60', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    const j = await r.json()
    return (j.items || []).map((t) => {
      const s = t.summary || t
      return {
        id: t.task_id || t.id || s.task_id,
        state: s.display_state,
        runState: s.latest_run ? s.latest_run.state : null,
        artifact: s.latest_artifact ? s.latest_artifact.artifact_id : null,
      }
    })
  })
  const deep = tasks.find((t) => t.artifact) || tasks[0]

  const routes = [
    { name: 'm-home', route: '/work' },
    { name: 'm-new', route: '/work/new' },
    { name: 'm-items', route: '/work/items' },
    { name: 'm-archive', route: '/work/archive' },
  ]
  if (deep && deep.id) routes.push({ name: 'm-task', route: `/work/items/${deep.id}` })
  if (deep && deep.artifact)
    routes.push({
      name: 'm-artifact',
      route: `/work/items/${deep.id}/artifacts/${deep.artifact}?version=1`,
    })
  routes.push({ name: 'm-admin', route: '/admin/work' })

  const results = []
  for (const r of routes) {
    try {
      results.push(await collect(page, r.name, r.route))
    } catch (e) {
      results.push({ name: r.name, route: r.route, error: String(e.message || e).slice(0, 160) })
    }
  }

  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    device: { model: 'AMM-AN00', os: 'Android 16 (SDK 36)', physical: '1200x2664', density: 520 },
    transport: 'adb forward tcp:9222 localabstract:chrome_devtools_remote -> Playwright connectOverCDP (real device Chrome 138)',
    session,
    sampledTasks: tasks.slice(0, 4),
    deepLink: deep,
    results,
  }
  fs.writeFileSync(path.join(__dirname, 'mobile-run.json'), JSON.stringify(payload, null, 2))
  console.log(
    results
      .map(
        (r) =>
          `${r.name.padEnd(12)} w=${r.innerWidth ?? '-'} ro=${r.readOnlyMedia ?? '-'} ta=${r.textareasVisible ?? '-'} ovf=${r.overflowX ?? '-'} btn=${JSON.stringify(r.buttons ?? r.error)} links=${(r.links || []).length}`
      )
      .join('\n')
  )
  console.log('WROTE mobile-run.json')
  if (owned) await page.close()
  await browser.close()
}

main().catch((e) => {
  console.log(JSON.stringify({ fatal: String(e.message || e).slice(0, 300) }))
  process.exitCode = 1
})
