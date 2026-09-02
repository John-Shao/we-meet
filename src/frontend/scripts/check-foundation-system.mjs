import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const expectedSchema =
  'https://www.designtokens.org/schemas/2025.10/format.json'
const spacingUrl = new URL(
  '../../design-tokens/spacing.tokens.json',
  import.meta.url
)
const typographyUrl = new URL(
  '../../design-tokens/typography.tokens.json',
  import.meta.url
)
const spacing = JSON.parse(readFileSync(spacingUrl, 'utf8'))
const typography = JSON.parse(readFileSync(typographyUrl, 'utf8'))
const failures = []

for (const [name, document] of [
  ['spacing', spacing],
  ['typography', typography],
]) {
  if (document.$schema !== expectedSchema) {
    failures.push(`${name}: $schema must be ${expectedSchema}`)
  }
}

function getNode(document, path) {
  return path.split('.').reduce((node, segment) => node?.[segment], document)
}

function resolveDimension(path, resolving = []) {
  if (resolving.includes(path)) {
    throw new Error(
      `Circular spacing reference: ${[...resolving, path].join(' -> ')}`
    )
  }
  const token = getNode(spacing, path)
  if (!token || !Object.hasOwn(token, '$value')) {
    throw new Error(`Missing spacing token: ${path}`)
  }
  if (typeof token.$value === 'string') {
    const reference = /^\{([^}]+)\}$/.exec(token.$value)?.[1]
    if (!reference) throw new Error(`Invalid spacing reference at ${path}`)
    return resolveDimension(reference, [...resolving, path])
  }
  const { value, unit } = token.$value
  if (!Number.isFinite(value) || value < 0 || unit !== 'px') {
    throw new Error(`Invalid px dimension at ${path}`)
  }
  return value
}

const expectedSpaces = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
  '4xl': 64,
}
for (const [name, expected] of Object.entries(expectedSpaces)) {
  try {
    const actual = resolveDimension(`space.${name}`)
    if (actual !== expected)
      failures.push(`space.${name}: ${actual}px != ${expected}px`)
  } catch (error) {
    failures.push(error.message)
  }
}

for (const family of ['inline', 'stack', 'inset']) {
  for (const name of Object.keys(spacing.spacing[family])) {
    try {
      resolveDimension(`spacing.${family}.${name}`)
    } catch (error) {
      failures.push(error.message)
    }
  }
}

const expectedTypeScale = {
  displayLarge: [57, 64],
  displayMedium: [45, 52],
  displaySmall: [36, 44],
  headlineLarge: [32, 40],
  headlineMedium: [28, 36],
  headlineSmall: [24, 32],
  titleLarge: [22, 28],
  titleMedium: [16, 24],
  titleSmall: [14, 20],
  bodyLarge: [16, 24],
  bodyMedium: [14, 20],
  bodySmall: [12, 16],
  labelLarge: [14, 20],
  labelMedium: [12, 16],
  labelSmall: [11, 16],
}

for (const [name, [expectedSize, expectedLineHeight]] of Object.entries(
  expectedTypeScale
)) {
  const token = typography.typography[name]
  const value = token?.$value
  if (token?.$type && token.$type !== 'typography') {
    failures.push(`typography.${name}: invalid $type`)
    continue
  }
  if (
    !value ||
    value.fontFamily !== '{font.family.ui}' ||
    value.fontSize?.unit !== 'px' ||
    value.letterSpacing?.unit !== 'px' ||
    ![400, 500].includes(value.fontWeight) ||
    !Number.isFinite(value.lineHeight)
  ) {
    failures.push(`typography.${name}: invalid DTCG typography value`)
    continue
  }
  const actualLineHeight = value.fontSize.value * value.lineHeight
  if (value.fontSize.value !== expectedSize) {
    failures.push(
      `typography.${name}: ${value.fontSize.value}px != ${expectedSize}px`
    )
  }
  if (Math.abs(actualLineHeight - expectedLineHeight) > 0.001) {
    failures.push(
      `typography.${name}: line height ${actualLineHeight.toFixed(3)}px != ${expectedLineHeight}px`
    )
  }
}

const migratedTypographySources = [
  '../src/primitives/Badge.tsx',
  '../src/primitives/chipRecipe.ts',
  '../src/primitives/Field.tsx',
  '../src/primitives/FieldDescription.tsx',
  '../src/primitives/FieldErrors.tsx',
  '../src/primitives/Input.tsx',
  '../src/primitives/TextArea.tsx',
  '../src/primitives/Select.tsx',
].map((path) => new URL(path, import.meta.url))

for (const sourceUrl of migratedTypographySources) {
  const source = readFileSync(sourceUrl, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  for (const match of source.matchAll(/\bfontSize\s*:\s*['"]?[\d.]+/g)) {
    const line = source.slice(0, match.index).split('\n').length
    failures.push(
      `${fileURLToPath(sourceUrl)}:${line} uses a raw font size: ${match[0]}`
    )
  }
}

const pandaConfig = readFileSync(
  new URL('../panda.config.ts', import.meta.url),
  'utf8'
)
for (const contract of ['spacingContract', 'typographyContract']) {
  if (!pandaConfig.includes(contract)) {
    failures.push(`panda.config.ts does not consume ${contract}`)
  }
}
if (!/['"]html, body['"][\s\S]*?fontFamily:\s*['"]sans['"]/.test(pandaConfig)) {
  failures.push(
    'panda.config.ts does not apply the shared UI font stack globally'
  )
}

if (failures.length > 0) {
  console.error('Foundation System validation failed:')
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(
    `Foundation System OK: ${Object.keys(expectedSpaces).length} spacing steps, ${Object.keys(expectedTypeScale).length} Material 3 type styles, and ${migratedTypographySources.length} migrated sources passed`
  )
}
