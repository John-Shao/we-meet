import i18n from 'i18next'

/**
 * 会议模块的日期时间格式化 —— 一处定义。
 *
 * 两条规矩，都是审计里点过的（见 `docs/reviews/meetings-ux-migration-2026-09-16.md`）：
 *
 * ① **跟随界面语言**：默认取 i18next 单例上的 `language`。此前只有列表页与两处
 *    详情页显式传了语言，次级页与十来处面板一律裸 `toLocaleString()` —— 中文界面 +
 *    英文浏览器时，同一份数据在列表里读作「9月16日 15:36」、点进去读作
 *    「9/16/26, 3:36 PM」。要用别的语言（测试里要确定性）可以显式传 `locale`。
 *
 * ② **解析失败返回 `null`**：调用点整段不渲染那条元信息（或退成一格「—」），
 *    而不是把服务端原值或空白画到界面上（§3.2 #3 定下的口径）。
 *
 * 为什么用 `Intl.DateTimeFormat` 而不是 `Date.prototype.toLocaleString`：后者在语言
 * 标识非法时**不一定抛**（V8 会静默回落），而 `Intl` 构造器会抛 —— 我们才能把
 * 「locale 传错」和「时间戳是脏值」都收敛到同一个 `null` 通道里。
 */

type TimeValue = string | number | Date | null | undefined

export type DateLocale = string | undefined

/** 没显式传就用当前界面语言（i18next 单例，`i18n/init.ts` 在应用启动时初始化）。 */
function resolveLocale(locale: DateLocale): string | undefined {
  if (locale) return locale
  const current = i18n?.language
  return current || undefined
}

/** 解析失败（空值 / 非法时间戳）返回 `null`。 */
function parse(value: TimeValue): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function format(
  date: Date,
  locale: DateLocale,
  options: Intl.DateTimeFormatOptions
): string | null {
  try {
    return new Intl.DateTimeFormat(resolveLocale(locale), options).format(date)
  } catch {
    // 非法 locale：宁可整段不渲染，也不要静默落到另一种语言上。
    return null
  }
}

/**
 * 完整一档：日期 + 时分（`2026年9月16日 15:36` / `Sep 16, 2026, 3:36 PM`）。
 * 详情页页头、资料卡、面板里的「生成于 / 会议时间」都用它。
 */
export const formatDateTime = (
  value: TimeValue,
  locale: DateLocale = undefined
): string | null => {
  const date = parse(value)
  if (!date) return null
  return format(date, locale, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * 紧凑一档：**同年只到「月日 时:分」，跨年补年份**。
 * 表格里的「修改时间 / 创建时间」用它 —— 一整列都带年份太吵（与预约 / 历史列表同一处理）。
 */
export const formatRecordTime = (
  value: TimeValue,
  locale: DateLocale = undefined
): string | null => {
  const date = parse(value)
  if (!date) return null
  return format(date, locale, {
    ...(date.getFullYear() !== new Date().getFullYear()
      ? { year: 'numeric' }
      : {}),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 只要时分（逐字稿行首、面板里的时刻）。 */
export const formatClock = (
  value: TimeValue,
  locale: DateLocale = undefined
): string | null => {
  const date = parse(value)
  if (!date) return null
  return format(date, locale, { hour: '2-digit', minute: '2-digit' })
}

/**
 * 数字也跟随界面语言：`1.5` / `1,5`（文件大小那几处）。
 * 与日期同一个理由，所以放在同一个文件里 —— 调用点只需记住「格式化都收在这」。
 */
export const formatDecimal = (
  value: number,
  locale: DateLocale = undefined,
  options: Intl.NumberFormatOptions = { maximumFractionDigits: 1 }
): string => {
  try {
    return new Intl.NumberFormat(resolveLocale(locale), options).format(value)
  } catch {
    return String(value)
  }
}
