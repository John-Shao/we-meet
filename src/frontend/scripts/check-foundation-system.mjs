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
const shapeUrl = new URL(
  '../../design-tokens/shape.tokens.json',
  import.meta.url
)
const elevationUrl = new URL(
  '../../design-tokens/elevation.tokens.json',
  import.meta.url
)
const componentUrl = new URL(
  '../../design-tokens/component.tokens.json',
  import.meta.url
)
const spacing = JSON.parse(readFileSync(spacingUrl, 'utf8'))
const typography = JSON.parse(readFileSync(typographyUrl, 'utf8'))
const shape = JSON.parse(readFileSync(shapeUrl, 'utf8'))
const elevation = JSON.parse(readFileSync(elevationUrl, 'utf8'))
const component = JSON.parse(readFileSync(componentUrl, 'utf8'))
const failures = []

for (const [name, document] of [
  ['spacing', spacing],
  ['typography', typography],
  ['shape', shape],
  ['elevation', elevation],
  ['component', component],
]) {
  if (document.$schema !== expectedSchema) {
    failures.push(`${name}: $schema must be ${expectedSchema}`)
  }
}

function getNode(document, path) {
  return path.split('.').reduce((node, segment) => node?.[segment], document)
}

function resolveDocumentDimension(document, path, label, resolving = []) {
  if (resolving.includes(path)) {
    throw new Error(
      `Circular ${label} reference: ${[...resolving, path].join(' -> ')}`
    )
  }
  const token = getNode(document, path)
  if (!token || !Object.hasOwn(token, '$value')) {
    throw new Error(`Missing ${label} token: ${path}`)
  }
  if (typeof token.$value === 'string') {
    const reference = /^\{([^}]+)\}$/.exec(token.$value)?.[1]
    if (!reference) throw new Error(`Invalid ${label} reference at ${path}`)
    return resolveDocumentDimension(document, reference, label, [
      ...resolving,
      path,
    ])
  }
  const { value, unit } = token.$value
  if (!Number.isFinite(value) || value < 0 || unit !== 'px') {
    throw new Error(`Invalid px dimension at ${path}`)
  }
  return value
}

const resolveSpacingDimension = (path) =>
  resolveDocumentDimension(spacing, path, 'spacing')
const resolveShapeDimension = (path) =>
  resolveDocumentDimension(shape, path, 'shape')
const resolveElevationDimension = (path) =>
  resolveDocumentDimension(elevation, path, 'elevation')
const resolveComponentDimension = (path) =>
  resolveDocumentDimension(component, path, 'component')

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
    const actual = resolveSpacingDimension(`space.${name}`)
    if (actual !== expected)
      failures.push(`space.${name}: ${actual}px != ${expected}px`)
  } catch (error) {
    failures.push(error.message)
  }
}

for (const family of ['inline', 'stack', 'inset']) {
  for (const name of Object.keys(spacing.spacing[family])) {
    try {
      resolveSpacingDimension(`spacing.${family}.${name}`)
    } catch (error) {
      failures.push(error.message)
    }
  }
}

const expectedRadii = {
  none: 0,
  extraSmall: 4,
  small: 8,
  medium: 12,
  large: 16,
  extraLarge: 24,
  full: 9999,
}
for (const [name, expected] of Object.entries(expectedRadii)) {
  try {
    const actual = resolveShapeDimension(`radius.${name}`)
    if (actual !== expected)
      failures.push(`radius.${name}: ${actual}px != ${expected}px`)
  } catch (error) {
    failures.push(error.message)
  }
}
for (const name of ['field', 'control', 'card', 'panel', 'modal', 'pill']) {
  try {
    resolveShapeDimension(`shape.${name}`)
  } catch (error) {
    failures.push(error.message)
  }
}

const expectedElevations = {
  flat: 0,
  subtle: 1,
  raised: 3,
  overlay: 6,
  sticky: 8,
  modal: 12,
}
for (const [name, expected] of Object.entries(expectedElevations)) {
  try {
    const actual = resolveElevationDimension(`elevation.${name}`)
    if (actual !== expected)
      failures.push(`elevation.${name}: ${actual}px != ${expected}px`)
  } catch (error) {
    failures.push(error.message)
  }
}

const expectedComponentSizes = {
  'component.controlHeight.compact': 32,
  'component.controlHeight.default': 40,
  'component.controlHeight.large': 48,
  'component.icon.small': 16,
  'component.icon.medium': 20,
  'component.icon.large': 24,
  'component.iconButton.compact': 24,
  'component.iconButton.default': 28,
  'component.iconButton.large': 32,
  'component.selectionControl.compact': 18,
  'component.selectionControl.default': 22,
  'component.interactionTarget.minimum': 48,
}
for (const [path, expected] of Object.entries(expectedComponentSizes)) {
  try {
    const actual = resolveComponentDimension(path)
    if (actual !== expected) {
      failures.push(`${path}: ${actual}px != ${expected}px`)
    }
  } catch (error) {
    failures.push(error.message)
  }
}

function resolveShadowLayers(path, resolving = []) {
  if (resolving.includes(path)) {
    throw new Error(
      `Circular shadow reference: ${[...resolving, path].join(' -> ')}`
    )
  }
  const token = getNode(elevation, path)
  if (!token || !Object.hasOwn(token, '$value')) {
    throw new Error(`Missing shadow token: ${path}`)
  }
  const values = Array.isArray(token.$value) ? token.$value : [token.$value]
  return values.flatMap((value) => {
    if (typeof value !== 'string') return [value]
    const reference = /^\{([^}]+)\}$/.exec(value)?.[1]
    if (!reference) throw new Error(`Invalid shadow reference at ${path}`)
    return resolveShadowLayers(reference, [...resolving, path])
  })
}

function isPxDimension(value) {
  return (
    value &&
    Number.isFinite(value.value) &&
    typeof value.unit === 'string' &&
    value.unit === 'px'
  )
}

for (const mode of ['light', 'dark']) {
  for (const name of ['subtle', 'raised', 'overlay', 'sticky', 'modal']) {
    try {
      const layers = resolveShadowLayers(`shadow.${mode}.${name}`)
      if (layers.length === 0) throw new Error('shadow has no layers')
      for (const layer of layers) {
        const components = layer?.color?.components
        const alpha = layer?.color?.alpha ?? 1
        const validColor =
          layer?.color?.colorSpace === 'srgb' &&
          Array.isArray(components) &&
          components.length === 3 &&
          components.every(
            (component) =>
              Number.isFinite(component) && component >= 0 && component <= 1
          ) &&
          Number.isFinite(alpha) &&
          alpha >= 0 &&
          alpha <= 1
        if (
          !validColor ||
          !isPxDimension(layer?.offsetX) ||
          !isPxDimension(layer?.offsetY) ||
          !isPxDimension(layer?.blur) ||
          !isPxDimension(layer?.spread) ||
          (layer?.inset !== undefined && typeof layer.inset !== 'boolean')
        ) {
          throw new Error('invalid DTCG shadow layer')
        }
      }
    } catch (error) {
      failures.push(`shadow.${mode}.${name}: ${error.message}`)
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
  '../src/primitives/ActionMenu.tsx',
  '../src/primitives/Badge.tsx',
  '../src/primitives/chipRecipe.ts',
  '../src/primitives/Field.tsx',
  '../src/primitives/FieldDescription.tsx',
  '../src/primitives/FieldErrors.tsx',
  '../src/primitives/Input.tsx',
  '../src/primitives/InteractiveListRow.tsx',
  '../src/primitives/TextArea.tsx',
  '../src/primitives/Select.tsx',
  '../src/primitives/SegmentedControl.tsx',
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

const migratedShapeSources = [
  '../src/primitives/ActionMenu.tsx',
  '../src/primitives/Badge.tsx',
  '../src/primitives/Box.tsx',
  '../src/primitives/buttonRecipe.ts',
  '../src/primitives/Checkbox.tsx',
  '../src/primitives/chipRecipe.ts',
  '../src/primitives/Input.tsx',
  '../src/primitives/InteractiveListRow.tsx',
  '../src/primitives/Loader.tsx',
  '../src/primitives/menuRecipe.ts',
  '../src/primitives/Radio.tsx',
  '../src/primitives/Select.tsx',
  '../src/primitives/SegmentedControl.tsx',
  '../src/primitives/Switch.tsx',
  '../src/primitives/Tabs.tsx',
  '../src/primitives/TextArea.tsx',
  '../src/primitives/TooltipWrapper.tsx',
  '../src/primitives/VisualOnlyTooltip.tsx',
  '../src/components/Modal.tsx',
  '../src/features/tasks/components/TaskSidePanel.tsx',
  '../src/features/notifications/components/Toast.tsx',
].map((path) => new URL(path, import.meta.url))

for (const sourceUrl of migratedShapeSources) {
  const source = readFileSync(sourceUrl, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  for (const match of source.matchAll(
    /\bborderRadius\s*:\s*(?:['"](?:[\d.]+(?:px|rem|%)?)['"]|[\d.]+)/g
  )) {
    const line = source.slice(0, match.index).split('\n').length
    failures.push(
      `${fileURLToPath(sourceUrl)}:${line} uses a raw radius: ${match[0]}`
    )
  }
}

const migratedElevationSources = [
  '../src/primitives/ActionMenu.tsx',
  '../src/primitives/Box.tsx',
  '../src/primitives/Switch.tsx',
  '../src/primitives/TooltipWrapper.tsx',
  '../src/primitives/VisualOnlyTooltip.tsx',
  '../src/components/Modal.tsx',
  '../src/features/notifications/components/Toast.tsx',
].map((path) => new URL(path, import.meta.url))

for (const sourceUrl of migratedElevationSources) {
  const source = readFileSync(sourceUrl, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  for (const match of source.matchAll(
    /\bboxShadow\s*:\s*['"](?:inset\s+)?-?[\d.]+(?:px|rem)?\s/g
  )) {
    const line = source.slice(0, match.index).split('\n').length
    failures.push(
      `${fileURLToPath(sourceUrl)}:${line} uses a raw elevation shadow: ${match[0].trim()}`
    )
  }
}

const componentStateRequirements = [
  [
    '../src/primitives/ActionMenu.tsx',
    [
      'role="menu"',
      "role={props.role ?? 'menuitem'}",
      'ArrowDown',
      'ArrowUp',
      'Escape',
      '_hover',
      '_active',
      '_focusVisible',
      '_disabled',
      'status.danger.container',
    ],
  ],
  [
    '../src/primitives/buttonRecipe.ts',
    ['data-hovered', 'data-pressed', 'data-focus-visible', 'data-disabled'],
  ],
  ['../src/primitives/Button.tsx', ['aria-busy', 'data-loading']],
  [
    '../src/primitives/IconButton.tsx',
    [
      'label: string',
      'aria-label={label}',
      'tooltip = label',
      "size = 'icon28'",
    ],
  ],
  [
    '../src/primitives/InteractiveListRow.tsx',
    [
      'aria-selected',
      'aria-pressed',
      "selectionMode ? 'listbox' : ariaLabel ? 'group'",
      'aria-multiselectable',
      'data-selected',
      'ArrowDown',
      'ArrowUp',
      'Home',
      'End',
      '_hover',
      '_active',
      '_focusVisible',
      '_disabled',
      'selectionControl.compact',
      'action.selected.bg',
    ],
  ],
  [
    '../src/primitives/DismissibleChip.tsx',
    ['label: string', 'aria-label={label}', 'interactive: true'],
  ],
  [
    '../src/primitives/chipRecipe.ts',
    ['data-hovered', 'data-pressed', 'data-focus-visible', 'data-disabled'],
  ],
  [
    '../src/primitives/SegmentedControl.tsx',
    [
      'role="tablist"',
      'role="tab"',
      'aria-selected',
      'ArrowLeft',
      'ArrowRight',
      '_focusVisible',
      '_disabled',
      "appearance?: 'underline' | 'pill'",
      "density?: 'compact' | 'default'",
      'action.selected.bg',
    ],
  ],
  [
    '../src/components/Modal.tsx',
    [
      'export const ModalHeader',
      "textStyle: 'titleMedium'",
      "borderBottom: '1px solid token(colors.border.subtle)'",
      '<ModalCloseButton',
    ],
  ],
  [
    '../src/primitives/Input.tsx',
    ['data-hovered', 'data-invalid', 'data-disabled'],
  ],
  [
    '../src/primitives/TextArea.tsx',
    ['data-hovered', 'data-invalid', 'data-disabled'],
  ],
  [
    '../src/primitives/Select.tsx',
    [
      'data-hovered',
      'data-pressed',
      'data-focus-visible',
      'data-invalid',
      'data-disabled',
    ],
  ],
  [
    '../src/primitives/Checkbox.tsx',
    [
      'data-hovered',
      'data-pressed',
      'data-focus-visible',
      'data-selected',
      'data-mt-checkbox-invalid',
      'data-disabled',
    ],
  ],
  [
    '../src/primitives/Radio.tsx',
    [
      'data-hovered',
      'data-pressed',
      'data-focus-visible',
      'data-selected',
      'data-invalid',
      'data-disabled',
    ],
  ],
  [
    '../src/primitives/Switch.tsx',
    [
      'data-hovered',
      'data-pressed',
      'data-focus-visible',
      'data-selected',
      'data-disabled',
    ],
  ],
  [
    '../src/primitives/Tabs.tsx',
    [
      'data-hovered',
      'data-pressed',
      'data-focus-visible',
      'data-selected',
      'data-disabled',
    ],
  ],
]

for (const [path, requiredStates] of componentStateRequirements) {
  const sourceUrl = new URL(path, import.meta.url)
  const source = readFileSync(sourceUrl, 'utf8')
  for (const state of requiredStates) {
    if (!source.includes(state)) {
      failures.push(`${fileURLToPath(sourceUrl)} does not cover ${state}`)
    }
  }
}

const pandaConfig = readFileSync(
  new URL('../panda.config.ts', import.meta.url),
  'utf8'
)
for (const contract of [
  'spacingContract',
  'typographyContract',
  'shapeContract',
  'elevationContract',
  'componentContract',
]) {
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
    `Foundation System OK: ${Object.keys(expectedSpaces).length} spacing steps, ${Object.keys(expectedTypeScale).length} Material 3 type styles, ${Object.keys(expectedRadii).length} radii, ${Object.keys(expectedElevations).length} elevation levels, ${Object.keys(expectedComponentSizes).length} component sizes, and ${new Set([...migratedTypographySources, ...migratedShapeSources, ...migratedElevationSources].map(String)).size} migrated sources passed`
  )
}
