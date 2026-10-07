import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { createPublicKey } from 'node:crypto'
await copyFile(new URL('./extract-runtime.ps1', import.meta.url), new URL('../dist/extract-runtime.ps1', import.meta.url))
const trust = process.env.WEMEET_RUNTIME_TRUST_FILE ? JSON.parse(await readFile(process.env.WEMEET_RUNTIME_TRUST_FILE, 'utf8')) : []
if (!Array.isArray(trust) || trust.some(k => !/^[A-Za-z0-9_-]{1,80}$/.test(k.key_id) || !k.public_key?.startsWith('-----BEGIN PUBLIC KEY-----') || createPublicKey(k.public_key).asymmetricKeyType !== 'ed25519') || new Set(trust.map(k => k.key_id)).size !== trust.length) throw new Error('Invalid runtime public trust anchors')
await writeFile(new URL('../dist/runtime-trust.json', import.meta.url), JSON.stringify(trust))
