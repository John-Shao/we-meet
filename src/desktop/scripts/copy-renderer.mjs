// Copies the built frontend (src/frontend/dist) into dist/renderer so
// electron-builder packages it. Run after `npm run build:renderer`.
import { cp, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'
import { rendererConfig } from './renderer-config.mjs'
const require = createRequire(import.meta.url)
const { DEFAULT_CONFIG, validateConfig } = require('../dist/policy.js')

const src = new URL('../../frontend/dist/', import.meta.url)
const dest = new URL('../dist/renderer/', import.meta.url)
const renderer = rendererConfig()
const builtRenderer = JSON.parse(await readFile(new URL('desktop-build.json', src), 'utf8'))
if (JSON.stringify(builtRenderer) !== JSON.stringify(renderer)) {
  throw new Error('Renderer configuration changed: rerun build:renderer before packaging')
}

if (!existsSync(src)) {
  console.error(
    'frontend/dist not found — run `npm run build:renderer` first.\n' +
      'Desktop packages the renderer and serves it through an isolated protocol handler.',
  )
  process.exit(1)
}

const resolved = path.resolve(fileURLToPath(dest))
const expected = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)), 'renderer')
if (resolved !== expected) throw new Error('Refusing to remove a path outside desktop/dist/renderer')
await rm(resolved, { recursive: true, force: true })
await cp(src, dest, { recursive: true })
const config = validateConfig({
  serviceOrigin: process.env.WEMEET_SERVICE_URL || DEFAULT_CONFIG.serviceOrigin,
  issuer: process.env.WEMEET_OIDC_ISSUER || DEFAULT_CONFIG.issuer,
  clientId: process.env.WEMEET_OIDC_CLIENT_ID || DEFAULT_CONFIG.clientId,
})
await writeFile(new URL('../dist/runtime-config.json', import.meta.url), JSON.stringify({ ...config, renderer }, null, 2) + '\n')
console.log('copied frontend/dist → dist/renderer')
