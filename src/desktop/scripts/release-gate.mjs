import { readFile } from 'node:fs/promises'
if (!process.env.CSC_LINK && !process.env.WIN_CSC_LINK) throw new Error('Formal release requires a Windows signing certificate configured through CSC_LINK or WIN_CSC_LINK')
const trust = JSON.parse(await readFile(new URL('../dist/runtime-trust.json', import.meta.url), 'utf8'))
if (!trust.length) throw new Error('Formal release requires pinned runtime update public keys (WEMEET_RUNTIME_TRUST_FILE)')
