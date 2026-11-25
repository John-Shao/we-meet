// The R0b browser-consumer contract gate.
//
// work-r0b-browser-openapi.yaml is the authority for the /work/v2 faces the Web app
// consumes. This gate keeps it honest in both directions: the committed runtime is what the
// contract renders today, every declared operation is a route the Go router actually
// registers, the frozen surface stays exactly the browser faces (a Bearer-plane face must
// not slip in), and the frontend copies stay byte-identical to the asset.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLIENT_PATH, SPEC_PATH, render } from '../generate-client.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET = join(HERE, '..')
const REPO = join(ASSET, '..', '..', '..', '..')
const GO_API = join(REPO, 'src', 'work', 'internal', 'api')
const FRONT = join(
  REPO,
  'src',
  'frontend',
  'src',
  'features',
  'work',
  'r0b',
  'api'
)

// The browser consumers, one operation per face (local-policy has GET and PATCH). A new
// browser face has to be added here on purpose, together with its contract entry.
const BROWSER_SURFACE = [
  'GET /work/v2/runs/{runId}/reconciliations',
  'GET /work/v2/runs/{runId}/history-handback',
  'GET /work/v2/runs/{runId}/supersede-budgets',
  'GET /work/v2/admin/local-policy',
  'PATCH /work/v2/admin/local-policy',
  'GET /work/v2/readonly-grants',
  'POST /work/v2/readonly-grants/{grantId}/revoke',
]

// Faces the desktop shell consumes over the Bearer plane. None of them belongs in a
// browser contract: the browser cannot present a device certificate.
const BEARER_ONLY = new Set([
  'GET /work/v2/devices',
  'POST /work/v2/devices/pairings',
  'POST /work/v2/devices/pairings/{pairingId}/confirm',
  'POST /work/v2/devices/{deviceId}/session-tickets',
  'POST /work/v2/devices/{deviceId}/certificate-renewals',
  'POST /work/v2/devices/certificate-renewals/{pairingId}/confirm',
  'POST /work/v2/devices/{deviceId}/revoke',
  'GET /work/v2/identity',
  'GET /work/v2/workspace-grants',
  'POST /work/v2/workspace-grants',
  'POST /work/v2/workspace-grants/{grantId}/revoke',
  'GET /work/v2/approvals',
  'GET /work/v2/approvals/{approvalId}',
  'POST /work/v2/approvals/{approvalId}/decisions',
  'POST /work/v2/artifacts/{artifactId}/versions',
  'POST /work/v2/tasks/{taskId}/acceptances',
  'POST /work/v2/runs/{runId}/workspace-rebinds',
])

const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

function readGoRoutes() {
  const consts = new Map()
  const routes = []
  for (const file of readdirSync(GO_API)) {
    if (!file.endsWith('.go') || file.endsWith('_test.go')) continue
    const source = read(join(GO_API, file))
    for (const match of source.matchAll(
      /^(?:\t|const\s+)([A-Z][A-Za-z0-9]*)\s*=\s*(.+)$/gm
    )) {
      consts.set(match[1], match[2].trim())
    }
    for (const match of source.matchAll(
      /HandleFunc\("([A-Z]+) "\+([A-Za-z0-9_.]+)/g
    )) {
      routes.push({ method: match[1], name: match[2].split('.').pop() })
    }
  }
  const resolve = (name, depth = 0) => {
    const raw = consts.get(name)
    if (raw === undefined) throw new Error(`unresolved path constant: ${name}`)
    if (depth > 8) throw new Error(`path constant cycle: ${name}`)
    if (raw.startsWith('"')) return raw.slice(1, -1)
    return raw
      .split('+')
      .map((part) => {
        const value = part.trim()
        return value.startsWith('"')
          ? value.slice(1, -1)
          : resolve(value, depth + 1)
      })
      .join('')
  }
  return new Set(routes.map((route) => `${route.method} ${resolve(route.name)}`))
}

function yamlSchemaNames() {
  const lines = read(SPEC_PATH).split('\n')
  const start = lines.findIndex((line) => /^  schemas:\s*$/.test(line))
  assert.notEqual(start, -1, 'the contract lost its components.schemas block')
  const names = new Set()
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]) && lines[i].trim()) break
    if (/^ {2}\S/.test(lines[i]) && !/^ {4}/.test(lines[i])) break
    const key = lines[i].match(/^ {4}([A-Za-z][A-Za-z0-9]*):\s*$/)
    if (key) names.add(key[1])
  }
  return names
}

function declaredTypeNames() {
  const text = read(join(ASSET, 'r0b-api-types.d.ts'))
  const block = text.match(
    /export type components = \{\s*schemas: \{([\s\S]*?)\n {2}\}\n\}/
  )
  assert.ok(block, 'r0b-api-types.d.ts lost its components.schemas mapping')
  const names = new Set()
  for (const match of block[1].matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*):/gm)) {
    names.add(match[1])
  }
  return names
}

test('the committed runtime is exactly what the contract renders today', () => {
  const rendered = render()
  assert.ok(existsSync(CLIENT_PATH), 'r0b-client.mjs is missing; run node generate-client.mjs')
  assert.equal(read(CLIENT_PATH), rendered.runtime, 'r0b-client.mjs drifted; run node generate-client.mjs')
  assert.ok(
    rendered.runtime.includes(`Source SHA-256: ${rendered.hash}`),
    'the runtime no longer records the spec hash it was generated from'
  )
})

test('the contract is exactly the frozen browser surface', () => {
  const rendered = render()
  const declared = rendered.operations.map(
    (operation) => `${operation.method} ${operation.path}`
  )
  assert.equal(new Set(declared).size, declared.length, 'duplicate method+path in the contract')
  assert.deepEqual([...declared].sort(), [...BROWSER_SURFACE].sort())
  for (const operation of rendered.operations) {
    assert.ok(operation.path.startsWith('/work/v2/'), `${operation.operationId} left /work/v2`)
    const surface = `${operation.method} ${operation.path}`
    assert.ok(!BEARER_ONLY.has(surface), `${surface} is Bearer-plane and cannot be browser-consumed`)
  }
})

test('every contract operation is a route the Go router registers', () => {
  const go = readGoRoutes()
  assert.ok(go.size >= 20, `the router scan found almost no routes (${go.size})`)
  for (const surface of BROWSER_SURFACE) {
    assert.ok(go.has(surface), `${surface} is not registered by the Go router`)
  }
})

test('mutations require the double-submit token and reads do not', () => {
  for (const operation of render().operations) {
    const expected = operation.method !== 'GET'
    assert.equal(
      operation.requiresCsrf,
      expected,
      `${operation.operationId}: requiresCsrf expected ${expected}`
    )
  }
})

test('the YAML schema names and the type mapping are the same set', () => {
  const yaml = yamlSchemaNames()
  const types = declaredTypeNames()
  assert.ok(yaml.size >= 8, `only ${yaml.size} schemas found in the contract`)
  assert.deepEqual([...yaml].sort(), [...types].sort())
})

test('the frontend copies are byte-identical to the asset', () => {
  const generated = join(FRONT, 'generated')
  assert.equal(
    read(join(generated, 'r0b-client.mjs')),
    read(CLIENT_PATH),
    'the app runtime drifted from the asset; run npm run gen:work-r0b-api'
  )
  assert.equal(
    read(join(generated, 'r0b-api-types.d.ts')),
    read(join(ASSET, 'r0b-api-types.d.ts')),
    'the app schema types drifted from the asset; run npm run gen:work-r0b-api'
  )
  assert.ok(
    existsSync(join(FRONT, 'client.ts')),
    'the hand-written call layer is gone; the contract expects it to consume the generated client'
  )
})