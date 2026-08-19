import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { actionI18nKey } from './adminAudit'
import zhAdmin from '@/locales/zh/admin.json'

/**
 * 审计动作的**中文标签**必须覆盖后端枚举的每一条。
 *
 * 目录本身走 `GET /admin/audit-logs/actions/`,所以「筛选下拉少了几种动作」
 * 那种漂移已经不可能了。但标签是另一回事:少一条不会报错,只会在一列中文里
 * 冒出一句英文 —— `t()` 的 `defaultValue` 是后端英文 label,降级得**太温柔**。
 *
 * 这条是真机上肉眼发现的:线 B 新增的 `bot.disable` / `bot.enable` 从来没补过
 * 中文,于是审计日志里「停用了哪个机器人」这条 —— 恰好是这块唯一真正要能被
 * 筛出来的事件 —— 显示成 `Group bot disabled`。
 *
 * 直接读后端的 `models.py` 而不是维护一份副本:副本就是下一次漂移。同一手法的
 * 先例是 `richCard.test.ts` 跨仓读金标准 fixture。
 */
const MODELS = path.resolve(__dirname, '../../../../../backend/core/models.py')

/** `AuditActionChoices` 里的全部动作码。 */
const backendActions = (): string[] => {
  const source = fs.readFileSync(MODELS, 'utf-8')
  const start = source.indexOf('class AuditActionChoices')
  expect(start, '后端枚举改名了?').toBeGreaterThan(-1)
  const rest = source.slice(start + 1)
  const end = rest.indexOf('\nclass ')
  const block = end < 0 ? rest : rest.slice(0, end)
  // 值是 `"dept.create"` 这种小写点分串;标签在 `_("Department created")` 里,
  // 有空格有大写,不会误命中。多行括号写法(meeting_room_facility.*)也照样匹配。
  return [...block.matchAll(/"([a-z][a-z0-9_]*\.[a-z0-9_]+)"/g)].map(
    (m) => m[1]
  )
}

describe('审计动作的中文标签', () => {
  it('后端枚举读得到,且不是空的', () => {
    const actions = backendActions()
    expect(actions.length).toBeGreaterThan(40)
    expect(actions).toContain('bot.disable')
    expect(actions).toContain('bot.enable')
    // 多行括号写法的那三条 —— 正则要能跨行捞到它们。
    expect(actions).toContain('meeting_room_facility.create')
  })

  it('每一条都有中文,一条都不许漏', () => {
    const labels = (zhAdmin as { audit: { action: Record<string, string> } })
      .audit.action
    const missing = backendActions().filter((action) => {
      const key = actionI18nKey(action).replace('audit.action.', '')
      return !labels[key]
    })
    expect(missing, `zh/admin.json 的 audit.action 少了这些`).toEqual([])
  })

  it('没有对不上任何动作的死标签', () => {
    // 后端删掉一个动作时,这里会提醒把标签也带走 —— 否则文件只增不减。
    const known = new Set(
      backendActions().map((a) => actionI18nKey(a).replace('audit.action.', ''))
    )
    const labels = (zhAdmin as { audit: { action: Record<string, string> } })
      .audit.action
    expect(Object.keys(labels).filter((k) => !known.has(k))).toEqual([])
  })
})
