import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { SPEC_PATH, parseOperations } from '../generate-client.mjs'

/**
 * The route-level drift gate compares Go handlers with the declared operations. Nothing compared
 * the contract's request and response bodies with the derived TypeScript types, which is how
 * TaskPreviewRequest and TaskSubmitRequest kept describing a nested R0aIntent while the handlers
 * took a flat body (fixed 2026-11-03 under #31), and how a default on an optional property becomes
 * a required member in the generated types.
 *
 * openapi-typescript is not installed here, so r0a-api-types.d.ts is edited by hand whenever the
 * contract changes. This gate is what makes that safe: for every schema the operations actually use,
 * the property names must agree, and requiredness must agree under the rule that a property which is
 * required in the contract, or carries a default, is a required member in TypeScript.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TYPES_PATH = path.join(HERE, '..', 'r0a-api-types.d.ts')

const SPLIT = /\r?\n/

// The contract spells `required` three ways at schema level - an inline `required: [a, b]`, an
// inline list wrapped onto the following lines, and a block list of `- a` items - and reading only
// some of them shows up as dozens of false drift reports rather than as a broken parser. Anything
// this cannot read is an error, never a silent skip.
function readRequired(block) {
  const start = block.findIndex((line) => line.startsWith('      required:'))
  if (start === -1) return new Set()
  const tail = block[start].slice('      required:'.length).trim()
  const names = new Set()

  if (tail.startsWith('[')) {
    let text = tail
    let index = start
    while (!text.includes(']') && index + 1 < block.length) {
      index += 1
      text += ` ${block[index].trim()}`
    }
    if (!text.includes(']')) throw new Error('required: opens a bracket that never closes')
    for (const entry of text.replace(/^\[/, '').replace(/\].*$/, '').split(',')) {
      if (entry.trim()) names.add(entry.trim())
    }
    return names
  }

  if (tail === '') {
    for (let i = start + 1; i < block.length; i += 1) {
      const item = /^        - (\w+)\s*$/.exec(block[i])
      if (!item) break
      names.add(item[1])
    }
    if (names.size === 0) throw new Error('required: has neither an inline list nor readable items')
    return names
  }

  throw new Error(`unrecognized required: spelling "${block[start]}"`)
}

/** Top-level properties of one YAML schema block, or { alias: true } when it is not an object. */
function yamlSchema(text, name) {
  const lines = text.split(SPLIT)
  const start = lines.findIndex((line) => line === `    ${name}:`)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^    \S/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i
      break
    }
  }
  const block = lines.slice(start + 1, end)
  if (!block.includes('      type: object')) return { alias: true }

  const propertiesIndex = block.findIndex((line) => line === '      properties:')
  if (propertiesIndex === -1) return { alias: true }

  const required = readRequired(block)
  const properties = new Map()
  for (let i = propertiesIndex + 1; i < block.length; i += 1) {
    const match = /^        ([A-Za-z_]\w*):(.*)$/.exec(block[i])
    if (!match) continue
    properties.set(match[1], {
      required: required.has(match[1]),
      hasDefault: /\bdefault:/.test(match[2]),
    })
  }
  return { alias: false, properties }
}

/** Top-level members of one block in the derived types. */
function tsSchema(text, name) {
  const marker = `        ${name}: {`
  const start = text.indexOf(marker)
  if (start === -1) return null
  const body = text.slice(start + marker.length)
  const end = body.indexOf('\n        };')
  if (end === -1) return null
  const members = new Map()
  for (const line of body.slice(0, end).split(SPLIT)) {
    const match = /^            ([A-Za-z_]\w*)(\??): /.exec(line)
    if (match) members.set(match[1], { optional: match[2] === '?' })
  }
  return members
}

/** The member schemas of a oneOf/anyOf alias, which the types render as a union. */
function unionMembers(text, name) {
  const lines = text.split(SPLIT)
  const start = lines.findIndex((line) => line === `    ${name}:`)
  if (start === -1) return []
  const members = []
  for (let i = start + 1; i < lines.length && /^\s/.test(lines[i]); i += 1) {
    const match = /#\/components\/schemas\/(\w+)/.exec(lines[i])
    if (match) members.push(match[1])
  }
  return members
}

function schemaNames(operations) {
  const names = new Set()
  for (const operation of operations) {
    if (operation.requestSchema) names.add(operation.requestSchema)
    if (operation.successSchema) names.add(operation.successSchema)
  }
  return [...names].sort()
}

const specText = fs.readFileSync(SPEC_PATH, 'utf8')
const typesText = fs.readFileSync(TYPES_PATH, 'utf8')
const operations = parseOperations(specText)
const names = schemaNames(operations)

test('enough body schemas are reachable to make this gate mean something', () => {
  assert.ok(
    names.length >= 25,
    `only ${names.length} request/response schemas come out of the operations; the comparison ` +
      `below would be proving too little`
  )
})

test('the contract and the derived types declare the same body properties', () => {
  const mismatches = []
  const aliases = []
  const unions = []
  let compared = 0

  // A union alias is not a blind spot: its members are real object schemas, so they join the queue.
  const queue = [...names]
  const seen = new Set(queue)
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const name = queue[cursor]
    const yaml = yamlSchema(specText, name)
    if (yaml === null) {
      mismatches.push(`${name}: the contract has no such schema (parser or spec is broken)`)
      continue
    }
    if (yaml.alias) {
      const members = unionMembers(specText, name)
      if (members.length > 0) {
        unions.push(`${name} = ${members.join(' | ')}`)
        for (const member of members) {
          if (seen.has(member)) continue
          seen.add(member)
          queue.push(member)
        }
        continue
      }
      // Enum aliases and simple types have no property set to compare. Recording them keeps an
      // object schema that stops parsing as an object visible here instead of escaping silently.
      aliases.push(name)
      continue
    }
    const ts = tsSchema(typesText, name)
    if (ts === null) {
      mismatches.push(`${name}: object schema in the contract, no matching block in the types`)
      continue
    }
    compared += 1

    const yamlNames = [...yaml.properties.keys()].sort()
    const tsNames = [...ts.keys()].sort()
    const missing = yamlNames.filter((key) => !ts.has(key))
    const extra = tsNames.filter((key) => !yaml.properties.has(key))
    if (missing.length > 0 || extra.length > 0) {
      mismatches.push(`${name}: contract-only [${missing}] types-only [${extra}]`)
      continue
    }

    for (const [key, info] of yaml.properties) {
      // openapi-typescript treats a property with a default as always present, which is why a
      // contract-optional media_type is required in the types. The rule is stated rather than
      // hardcoded per field, so the next default cannot pass unnoticed.
      const expectedRequired = info.required || info.hasDefault
      const isRequiredInTs = !ts.get(key).optional
      if (expectedRequired !== isRequiredInTs) {
        mismatches.push(
          `${name}.${key}: contract required=${info.required} default=${info.hasDefault} ` +
            `=> types should be required=${expectedRequired}, types say required=${isRequiredInTs}`
        )
      }
    }
  }

  assert.deepEqual(
    mismatches,
    [],
    `contract and derived types disagree on ${mismatches.length} body schemas ` +
      `(${compared} compared):\n  ${mismatches.join('\n  ')}`
  )
  assert.ok(compared >= 20, `only ${compared} object body schemas were compared`)
  assert.deepEqual(
    unions,
    ['AcceptanceRequest = AcceptanceByVersion | AcceptanceByReason'],
    'the set of body schemas reached through a union changed; each member is compared, so a new ' +
      'union only has to be checked for plausibility'
  )
  assert.deepEqual(
    aliases,
    [],
    'these body schemas were excluded from the comparison as non-object aliases; every exclusion ' +
      'is a blind spot, so this list has to be read before it grows'
  )
})
