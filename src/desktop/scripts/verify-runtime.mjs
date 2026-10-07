import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { ManagedRuntime } = require('../dist/managed-runtime.js')
const descriptor = JSON.parse(await readFile(new URL('../dist/bundled-runtime.json', import.meta.url), 'utf8'))
const runtime = new ManagedRuntime(fileURLToPath(new URL('../.agent-runtime/', import.meta.url)), fileURLToPath(new URL('../.runtime-package-check/', import.meta.url)), descriptor)
await runtime.verify(fileURLToPath(new URL(`../.agent-runtime/${descriptor.version}/`, import.meta.url)), descriptor)
console.log('Bundled runtime inventory and hashes verified')
