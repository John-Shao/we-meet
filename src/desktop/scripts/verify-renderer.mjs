import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { rendererConfig } from './renderer-config.mjs'
import { verifyRenderer } from './renderer-provenance.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url))
const config = rendererConfig()
const record = await verifyRenderer(frontend, root, fileURLToPath(new URL('../dist/renderer/', import.meta.url)), config)
const require = createRequire(import.meta.url)
const { DEFAULT_CONFIG, validateConfig } = require('../dist/policy.js')
const expected = validateConfig({ serviceOrigin: process.env.WEMEET_SERVICE_URL || DEFAULT_CONFIG.serviceOrigin, issuer: process.env.WEMEET_OIDC_ISSUER || DEFAULT_CONFIG.issuer, clientId: process.env.WEMEET_OIDC_CLIENT_ID || DEFAULT_CONFIG.clientId })
const runtime = JSON.parse(await readFile(new URL('../dist/runtime-config.json', import.meta.url), 'utf8'))
if (JSON.stringify(runtime) !== JSON.stringify({ ...expected, renderer: config })) throw new Error('Desktop runtime configuration changed: rerun copy:renderer')
console.log(`Renderer source, configuration and ${record.build.output_files} production assets verified`)
