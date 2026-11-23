#!/usr/bin/env node
/**
 * Generates r0b-client.mjs for the R0b browser-consumer contract.
 *
 * The generator itself is the R0a one (../work-r0a-design-2026-10-25/generate-client.mjs):
 * operation parsing and the runtime renderer are contract-agnostic, so this file only
 * supplies this contract's paths and naming. `--check` fails when the committed client
 * drifts from the YAML; the contract gate runs it, and the frontend copy script renders
 * with the same RENDER_OPTIONS so the two artifacts stay byte-identical.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  parseOperations,
  renderClient,
} from '../work-r0a-design-2026-10-25/generate-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const SPEC_PATH = path.join(HERE, 'work-r0b-browser-openapi.yaml')
export const CLIENT_PATH = path.join(HERE, 'r0b-client.mjs')

export const RENDER_OPTIONS = {
  specName: 'work-r0b-browser-openapi.yaml',
  generatorName: 'generate-client.mjs',
  typesModule: './r0b-api-types',
  ciNote: 'node --test test/browser-contract.test.mjs (fails on drift)',
}

export function render() {
  const yamlText = fs.readFileSync(SPEC_PATH, 'utf8')
  const operations = parseOperations(yamlText)
  const runtime = renderClient(yamlText, operations, RENDER_OPTIONS)
  // D2' single-sources the CSRF header name. The renderer emits one literal in the shared
  // request path; a spec that renamed the header would otherwise ship a client sending
  // the old name with only the server having moved.
  const contractHeader = /CsrfToken:\s*\r?\n\s*name:\s*(\S+)/.exec(yamlText)?.[1]
  const rendered = [...runtime.matchAll(/headers\['([^']+)'\] = csrf;/g)].map(
    (match) => match[1]
  )
  if (!contractHeader || rendered.length !== 1 || rendered[0] !== contractHeader) {
    throw new Error(
      `CSRF header is not single-sourced: contract declares ${
        contractHeader ?? 'nothing'
      }, client renders [${rendered.join(', ')}]`
    )
  }
  return {
    operations,
    runtime,
    hash: crypto.createHash('sha256').update(yamlText).digest('hex'),
  }
}

function main() {
  const check = process.argv.includes('--check')
  let rendered
  try {
    rendered = render()
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exit(1)
  }
  if (check) {
    const current = fs.existsSync(CLIENT_PATH)
      ? fs.readFileSync(CLIENT_PATH, 'utf8')
      : ''
    if (current !== rendered.runtime) {
      console.error(
        `${path.basename(CLIENT_PATH)} is out of date with ` +
          `${path.basename(SPEC_PATH)}. Run: node generate-client.mjs`
      )
      process.exit(1)
    }
    console.log(`r0b browser client up to date (${rendered.operations.length} operations)`)
    return
  }
  fs.writeFileSync(CLIENT_PATH, rendered.runtime, 'utf8')
  console.log(`wrote ${path.basename(CLIENT_PATH)} (${rendered.operations.length} operations)`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}