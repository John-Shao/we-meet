import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
const require = createRequire(import.meta.url)
if (process.env.ELECTRON_OVERRIDE_DIST_PATH) throw new Error('Release builds cannot override the pinned Electron distribution')
const executable = require('electron') // Electron 44 downloads lazily on first use.
const expected = require('electron/package.json').version
const actual = readFileSync(path.join(path.dirname(executable), 'version'), 'utf8').trim().replace(/^v/, '')
if (actual !== expected) throw new Error(`Electron binary ${actual} does not match package ${expected}`)
console.log(`Verified Electron ${actual}`)
