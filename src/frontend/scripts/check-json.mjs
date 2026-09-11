import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * src/ 下的每一个 .json 都必须能被 JSON.parse 读出来。
 *
 * 为什么单独要一道护栏:语言包是**手改**的(而且会被 Crowdin 整份覆盖),一个逗号
 * 放错位置在单元测试里完全看不出来 —— vitest 不会去 import 你没用到的那个语言包,
 * 而 `vite build` 会。前端镜像就因为 `contacts.json` 直接构建失败,五份语言包全中,
 * 而当时的测试是**全绿**的。这道护栏补的就是「测试绿、镜像构建不出来」那个缺口。
 *
 * 范围是整个 src/ 而不是只查 locales:同样的道理对任何会被 vite import 的 JSON 都
 * 成立,而范围大一点不增加误报(JSON 文件本来就该是合法 JSON)。
 *
 * 有意**不做**的事:检查各语言的键集是否齐全。复数键(_one/_other/…)本就因语言而
 * 异,而且存量翻译确实滞后(de/fr/nl 在 tasks.json 上各缺几十条),那是翻译进度,
 * 不是构建错误 —— 把它做成失败条件只会让人学会忽略这道护栏。
 */

const srcDir = fileURLToPath(new URL('../src', import.meta.url))
/** panda 的生成物与构建产物不是我们写的,也不该由我们保证。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'styled-system'])
const failures = []
let scanned = 0

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      walk(path)
      continue
    }
    if (!entry.endsWith('.json')) continue
    scanned += 1
    try {
      JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      failures.push(`${relative(srcDir, path)} — ${error.message}`)
    }
  }
}

walk(srcDir)

if (failures.length > 0) {
  console.error(
    `JSON validation failed: ${failures.length} of ${scanned} files under src/ are unparseable.`
  )
  console.error(
    'A malformed locale breaks `vite build` even when the tests pass.'
  )
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`JSON OK: all ${scanned} files under src/ parse.`)
}
