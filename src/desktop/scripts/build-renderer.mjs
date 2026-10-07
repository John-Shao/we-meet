import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'
import { rendererConfig } from './renderer-config.mjs'
import { rendererInputHash, rendererBuildRecord } from './renderer-provenance.mjs'

// A desktop bundle must use its own origin; never bake a developer's API URL in.
const config = rendererConfig()
const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url))
const desktop = fileURLToPath(new URL('../', import.meta.url))
const directory = fileURLToPath(new URL('../../frontend/dist/', import.meta.url))
const input = await rendererInputHash(frontend, desktop, config)
rmSync(new URL('../../frontend/dist/desktop-build.json', import.meta.url), { force: true })
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: frontend,
  env: { ...process.env, VITE_API_BASE_URL: '', VITE_JUSI_IM_BASE_URL: config.imBaseUrl,
    VITE_APP_TITLE: config.appTitle }, stdio: 'inherit', shell: process.platform === 'win32',
})
if (result.status === 0) {
  const record = await rendererBuildRecord(frontend, desktop, directory, config)
  if (record.build.input_sha256 !== input) throw new Error('Renderer inputs changed during build: rerun build:renderer')
  writeFileSync(new URL('../../frontend/dist/desktop-build.json', import.meta.url), JSON.stringify(record, null, 2) + '\n')
}
process.exit(result.status ?? 1)
