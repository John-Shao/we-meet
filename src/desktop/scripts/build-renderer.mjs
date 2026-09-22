import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { rendererConfig } from './renderer-config.mjs'

// A desktop bundle must use its own origin; never bake a developer's API URL in.
const config = rendererConfig()
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: fileURLToPath(new URL('../../frontend/', import.meta.url)),
  env: { ...process.env, VITE_API_BASE_URL: '', VITE_JUSI_IM_BASE_URL: config.imBaseUrl,
    VITE_APP_TITLE: config.appTitle }, stdio: 'inherit', shell: process.platform === 'win32',
})
if (result.status === 0) writeFileSync(new URL('../../frontend/dist/desktop-build.json', import.meta.url), JSON.stringify(config, null, 2))
process.exit(result.status ?? 1)
