import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const tokenUrl = new URL(
  '../../design-tokens/color.tokens.json',
  import.meta.url
)
const tokenFile = fileURLToPath(tokenUrl)
const document = JSON.parse(readFileSync(tokenUrl, 'utf8'))
const failures = []

const migratedSourceUrls = [
  '../src/primitives/buttonRecipe.ts',
  '../src/primitives/Input.tsx',
  '../src/primitives/TextArea.tsx',
  '../src/primitives/Select.tsx',
  '../src/primitives/selectChrome.ts',
  '../src/primitives/Chip.tsx',
  '../src/primitives/chipRecipe.ts',
  '../src/primitives/Badge.tsx',
  '../src/primitives/Checkbox.tsx',
  '../src/primitives/Radio.tsx',
  '../src/primitives/Switch.tsx',
  '../src/primitives/Tabs.tsx',
  '../src/primitives/Box.tsx',
  '../src/primitives/menuRecipe.ts',
  '../src/primitives/Popover.tsx',
  '../src/primitives/FieldDescription.tsx',
  '../src/primitives/FieldErrors.tsx',
  '../src/primitives/Text.tsx',
  '../src/primitives/A.tsx',
  '../src/primitives/Dialog.tsx',
  '../src/features/notifications/components/Toast.tsx',
  '../src/features/notifications/components/ToastRaised.tsx',
  '../src/features/notifications/components/ToastLowerHand.tsx',
  '../src/features/notifications/components/ToastMessageReceived.tsx',
  '../src/features/notifications/components/ToastRecordingRequest.tsx',
  '../src/features/notifications/components/WaitingParticipantNotification.tsx',
  '../src/features/tasks/components/TaskActionFeedback.tsx',
].map((path) => new URL(path, import.meta.url))

const legacyColorFamilies =
  '(?:greyscale|primary|danger|success|warning|error|default|control|box|focusRing)'
const legacyDirectColor = new RegExp(
  `(?:background|backgroundColor|color|borderColor|fill|stroke|outlineColor|boxShadow)\\s*:\\s*['"]${legacyColorFamilies}\\.`,
  'g'
)
const legacyEmbeddedColor = new RegExp(
  `(?:token\\(colors\\.|\\{colors\\.)${legacyColorFamilies}\\.`,
  'g'
)

const expectedSchema =
  'https://www.designtokens.org/schemas/2025.10/format.json'
if (document.$schema !== expectedSchema) {
  failures.push(`$schema must be ${expectedSchema}`)
}

function getNode(path) {
  return path.split('.').reduce((node, segment) => node?.[segment], document)
}

function resolveColor(path, resolving = []) {
  if (resolving.includes(path)) {
    throw new Error(
      `Circular token reference: ${[...resolving, path].join(' -> ')}`
    )
  }

  const token = getNode(path)
  if (!token || !Object.hasOwn(token, '$value')) {
    throw new Error(`Missing color token: ${path}`)
  }

  const value = token.$value
  if (typeof value === 'string') {
    const match = /^\{([^}]+)\}$/.exec(value)
    if (!match) throw new Error(`Invalid token reference at ${path}: ${value}`)
    return resolveColor(match[1], [...resolving, path])
  }

  if (
    value?.colorSpace !== 'srgb' ||
    !Array.isArray(value.components) ||
    value.components.length !== 3 ||
    value.components.some((component) => component < 0 || component > 1) ||
    value.alpha !== 1 ||
    !/^#[0-9a-f]{6}$/i.test(value.hex)
  ) {
    throw new Error(`Invalid opaque sRGB color at ${path}`)
  }

  const componentHex = `#${value.components
    .map((component) =>
      Math.round(component * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
  if (componentHex.toLowerCase() !== value.hex.toLowerCase()) {
    throw new Error(
      `sRGB components and hex fallback disagree at ${path}: ${componentHex} != ${value.hex}`
    )
  }
  return value.hex
}

function walkTokens(node, path = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  if (Object.hasOwn(node, '$value')) {
    const tokenPath = path.join('.')
    try {
      resolveColor(tokenPath)
    } catch (error) {
      failures.push(error.message)
    }
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith('$')) walkTokens(value, [...path, key])
  }
}

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    )
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background)
  )
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background)
  )
  return (lighter + 0.05) / (darker + 0.05)
}

const pairs = []
for (const mode of ['light', 'dark']) {
  const semantic = `color.semantic.${mode}`
  for (const surface of ['surface.default', 'surface.canvas']) {
    pairs.push(
      [`${semantic}.text.primary`, `${semantic}.${surface}`, 4.5],
      [`${semantic}.text.secondary`, `${semantic}.${surface}`, 4.5],
      [`${semantic}.text.link`, `${semantic}.${surface}`, 4.5],
      [`${semantic}.icon.primary`, `${semantic}.${surface}`, 3],
      [`${semantic}.icon.secondary`, `${semantic}.${surface}`, 3],
      [`${semantic}.border.strong`, `${semantic}.${surface}`, 3],
      [`${semantic}.border.focus`, `${semantic}.${surface}`, 3]
    )
  }
  pairs.push(
    [
      `${semantic}.action.primary.foreground`,
      `${semantic}.action.primary.background`,
      4.5,
    ],
    [
      `${semantic}.action.selected.on-container`,
      `${semantic}.action.selected.container`,
      4.5,
    ]
  )
  for (const status of ['danger', 'warning', 'success']) {
    pairs.push(
      [
        `${semantic}.status.${status}.on-default`,
        `${semantic}.status.${status}.default`,
        4.5,
      ],
      [
        `${semantic}.status.${status}.on-container`,
        `${semantic}.status.${status}.container`,
        4.5,
      ]
    )
  }
}

walkTokens(document)

for (const sourceUrl of migratedSourceUrls) {
  const sourceFile = fileURLToPath(sourceUrl)
  const source = readFileSync(sourceUrl, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    // Video overlays deliberately keep translucent neutral paints because
    // their effective background is live content, not a theme surface.
    .replace(/['"]greyscale\.100\/(?:20|50)['"]/g, `'overlay-exception'`)
  const legacyUses = [
    ...source.matchAll(legacyDirectColor),
    ...source.matchAll(legacyEmbeddedColor),
  ]
  for (const match of legacyUses) {
    const line = source.slice(0, match.index).split('\n').length
    failures.push(
      `Migrated primitive uses a legacy color token at ${sourceFile}:${line}: ${match[0]}`
    )
  }
}

for (const [foregroundPath, backgroundPath, minimum] of pairs) {
  try {
    const foreground = resolveColor(foregroundPath)
    const background = resolveColor(backgroundPath)
    const ratio = contrastRatio(foreground, background)
    if (ratio < minimum) {
      failures.push(
        `${foregroundPath} on ${backgroundPath} is ${ratio.toFixed(2)}:1; requires ${minimum}:1`
      )
    }
  } catch (error) {
    failures.push(error.message)
  }
}

if (failures.length > 0) {
  console.error(`Color System validation failed (${tokenFile}):`)
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(
    `Color System OK: ${pairs.length} contrast pairs passed; ${migratedSourceUrls.length} migrated sources use semantic roles (${tokenFile})`
  )
}
