#!/usr/bin/env node
/**
 * Regenerates the shipped R0b browser client from work-r0b-browser-openapi.yaml.
 *
 * Same shape as gen-work-api.mjs for R0a: the contract asset renders the runtime, this
 * script copies it verbatim next to its schema types and renders the strict-TypeScript
 * declarations from the same operation table. The asset's generate-client.mjs owns
 * operation parsing and the CSRF single-source guard, so both artifacts come from one
 * renderer.
 *
 *   r0b-client.mjs        - the generated runtime, copied verbatim
 *   r0b-api-types.d.ts    - the asset's hand-authored schema types, copied verbatim
 *   r0b-client.d.mts      - declarations rendered from the operation table
 *
 * `--check` compares all three and exits 1 on drift; `npm test` runs check:work-r0b-api.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  render,
  RENDER_OPTIONS,
  SPEC_PATH,
} from '../../../docs/plan/assets/work-r0b-browser-2026-11-23/generate-client.mjs'
import { renderDeclarations } from './gen-work-api.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(
  HERE,
  '..',
  'src',
  'features',
  'work',
  'r0b',
  'api',
  'generated'
)
const TYPES_SOURCE = path.join(
  HERE,
  '..',
  '..',
  '..',
  'docs',
  'plan',
  'assets',
  'work-r0b-browser-2026-11-23',
  'r0b-api-types.d.ts'
)
const RUNTIME_FILE = path.join(OUT_DIR, 'r0b-client.mjs')
const TYPES_FILE = path.join(OUT_DIR, 'r0b-api-types.d.ts')
const DECLARATION_FILE = path.join(OUT_DIR, 'r0b-client.d.mts')

const DECLARATION_OPTIONS = {
  scriptLabel: 'scripts/gen-work-r0b-api.mjs',
  specName: RENDER_OPTIONS.specName,
  runCommand: 'npm run gen:work-r0b-api',
  ciLine: 'npm test, which runs check:work-r0b-api',
  typesModule: './r0b-api-types',
}

function outputs() {
  const { operations, runtime } = render()
  return [
    { file: RUNTIME_FILE, text: runtime },
    { file: TYPES_FILE, text: fs.readFileSync(TYPES_SOURCE, 'utf8') },
    {
      file: DECLARATION_FILE,
      text: renderDeclarations(operations, DECLARATION_OPTIONS),
    },
  ]
}

function main() {
  const check = process.argv.includes('--check')
  let files
  try {
    files = outputs()
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exit(1)
  }
  if (check) {
    for (const { file, text } of files) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      if (current !== text) {
        console.error(
          `${path.relative(path.join(HERE, '..'), file)} is out of date with ` +
            `${path.basename(SPEC_PATH)}. Run: npm run gen:work-r0b-api`
        )
        process.exit(1)
      }
    }
    console.log(`r0b browser client up to date (${files.length} generated files)`)
    return
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  for (const { file, text } of files) {
    fs.writeFileSync(file, text, 'utf8')
  }
  console.log(
    `wrote ${files.map((entry) => path.basename(entry.file)).join(', ')}`
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}