import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 语言包「结构性缺失」护栏。
 *
 * `check-json.mjs` 只保证每个 .json 能 parse；它有意不查各语言键集是否齐全
 * (那会因翻译进度常年红灯，最后被人学会忽略)。这道护栏补的是**另一类**问题 ——
 * 不是「翻译还没跟上」，而是「键树本身不存在」，两者后果完全不同:
 *
 * 1. **整个命名空间缺失**：`i18n` 的 resourcesToBackend 动态 import
 *    `../locales/${lang}/${ns}.json`。文件不存在 → 该命名空间下**所有** key
 *    落到 i18next 的 key fallback，用户看到的是一屏 `library.text` 这种原始
 *    key，而不是「还没翻译」的中文。存量事故：`capture.json` 只有 zh/en，
 *    fr/nl/de 三种语言下整个 AI 录音界面全断。
 * 2. **顶层键组缺失**：某个语言少了一整组(如 fr 的 `meetings.json` 缺
 *    `library` / `recordAi` / `summarySharing` 等 16 组，而 zh/en 有 30 组)。
 *    这些组覆盖的界面在这些语言下**不存在任何文案**。
 * 3. **插值占位符不一致**：翻译时把 `{{time}}` 写丢或写错字，界面会显示
 *    原文句子但缺了变量(比 untranslated 更难发现)。
 *
 * 判据刻意收窄到「zh 有而目标语言没有」这一方向:
 * - 只拿 `zh` 当基准(默认语言 + 最全，见 init.ts 的 fallbackLng)。
 * - 只标**顶层键组**缺失，不逐叶子比对 —— 叶子级别的翻译滞后是翻译进度，
 *   交给 Crowdin，不该让这道护栏常年红。
 * - 目标语言多出来的键不算失败(可能是待上线的预留文案)。
 *
 * 用法:node scripts/check-locale-parity.mjs
 */

const localesDir = fileURLToPath(new URL('../src/locales', import.meta.url))
const BASE_LANG = 'zh'
/** 基准语言必须存在这些命名空间；其余语言也必须全部具备。 */
const REQUIRED_NAMESPACES = ['meetings', 'capture']
const PLACEHOLDER = /\{\{\s*[\w.]+\s*\}\}/g

const read = (lang, ns) =>
  JSON.parse(readFileSync(join(localesDir, lang, `${ns}.json`), 'utf8'))

const languages = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const failures = []

if (!languages.includes(BASE_LANG)) {
  console.error(`Base language "${BASE_LANG}" is missing from src/locales.`)
  process.exitCode = 1
} else {
  const placeholdersOf = (value, out = new Set()) => {
    if (typeof value === 'string') {
      for (const token of value.match(PLACEHOLDER) ?? []) {
        // 归一化空白:{{ time }} 与 {{time}} 是同一个占位符。
        out.add(token.replace(/\s+/g, ''))
      }
    } else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) placeholdersOf(nested, out)
    }
    return out
  }
  /** 逐叶子收集插值符号，带 key 路径，便于把失败定位到具体文案。 */
  const placeholdersByPath = (value, prefix = '', out = new Map()) => {
    if (typeof value === 'string') {
      out.set(prefix, placeholdersOf(value))
    } else if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        placeholdersByPath(nested, prefix ? `${prefix}.${key}` : key, out)
      }
    }
    return out
  }

  for (const ns of REQUIRED_NAMESPACES) {
    const missingFile = languages.filter(
      (lang) => !existsSync(join(localesDir, lang, `${ns}.json`))
    )
    if (missingFile.length > 0) {
      failures.push(
        `${ns}.json — missing entirely for: ${missingFile.join(', ')}`
      )
      continue
    }

    const base = read(BASE_LANG, ns)
    const baseGroups = Object.keys(base)
    const basePlaceholders = placeholdersByPath(base)

    for (const lang of languages) {
      if (lang === BASE_LANG) continue
      const target = read(lang, ns)
      const targetGroups = new Set(Object.keys(target))

      const missingGroups = baseGroups.filter((group) => {
        const baseValue = base[group]
        // 只把「zh 是对象组」的键当结构组；zh 的标量键在别的语言里缺失
        // 属于翻译进度，不在此列。
        return (
          baseValue &&
          typeof baseValue === 'object' &&
          !Array.isArray(baseValue) &&
          !targetGroups.has(group)
        )
      })
      if (missingGroups.length > 0) {
        failures.push(
          `${ns}.json [${lang}] — ${missingGroups.length} key group(s) absent vs ${BASE_LANG}: ${missingGroups.join(', ')}`
        )
      }

      const targetPlaceholders = placeholdersByPath(target)
      for (const [path, expected] of basePlaceholders) {
        const actual = targetPlaceholders.get(path)
        if (actual === undefined) continue // 缺失叶子属翻译进度，见文件头说明。
        const lost = [...expected].filter((token) => !actual.has(token))
        if (lost.length > 0) {
          failures.push(
            `${ns}.json [${lang}] — ${path} lost placeholder(s): ${lost.join(', ')}`
          )
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `Locale structure failed: ${failures.length} problem(s) across ${languages.length} languages.`
  )
  console.error(
    'A missing namespace renders raw i18n keys to users instead of falling back to Chinese.'
  )
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(
    `Locale structure OK: ${languages.join(', ')} all carry ${REQUIRED_NAMESPACES.join(' + ')} with matching top-level groups and placeholders.`
  )
}
