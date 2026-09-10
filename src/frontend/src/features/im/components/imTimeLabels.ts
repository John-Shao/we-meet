/**
 * 会话列表与聊天记录共用的时间分档(微信/飞书式):今天 → 时分;昨天 → 「昨天」;
 * 一周内 → 「周X」;更早 → 「9月11日」,跨年再带上年份。
 *
 * 分档与格式口径与 App 端 feature-im/…/ui/common/ImTimeLabels.kt 逐档对齐:
 * Android 两端共用同一个 dayTierLabel,这里也照做 —— 会话列表与消息列表分隔条
 * 不会再次各跑一套(此前分隔条少一档「周X」,中文下还出现「9/11」这种写法)。
 */

/** 满这么多天就不再显示星期几,改回具体日期(即 2~6 天前显示「周X」)。 */
const WEEKDAY_LABEL_MAX_DAYS = 7

const DAY_MS = 86_400_000

/** 自然日零点:按日历日比较,「昨晚 23:59 → 今早 00:01」不会被算成同一天。 */
const startOfDay = (d: Date): number =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/**
 * 与「今天」相差的自然天数。设备时钟回拨会让时间戳落在未来,负数一并按
 * 「今天」处理,免得掉进日期档。
 */
const daysAgo = (d: Date, now: Date): number =>
  Math.max(0, Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS))

/** 时:分,始终两位补零(Android 的 skeleton「Hm」在 5 种语言下也都是 24 小时制)。 */
const hhmm = (d: Date): string => {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * 具体日期:同年 → 「9月11日」/「Sep 11」;跨年 → 「2025年9月11日」。
 * 交给 toLocaleDateString 按当前语言取格式,不写死「9/11」。
 */
const dateLabel = (d: Date, now: Date, locale: string): string =>
  d.toLocaleDateString(
    locale,
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' }
  )

/**
 * 「天」的分档:今天返回 null(调用方只显示时分),其余返回「昨天」「周X」「9月11日」。
 * 会话列表与消息列表分隔条共用这一档梯,和 Android 的 dayTierLabel 一一对应。
 *
 * `now` 只在测试里显式传入,生产代码用当前时刻。
 */
const dayTierLabel = (
  d: Date,
  now: Date,
  locale: string,
  yesterday: string
): string | null => {
  const diff = daysAgo(d, now)
  if (diff <= 0) return null
  if (diff === 1) return yesterday
  if (diff < WEEKDAY_LABEL_MAX_DAYS) {
    return d.toLocaleDateString(locale, { weekday: 'short' })
  }
  return dateLabel(d, now, locale)
}

/** 会话列表右上角的时间戳:今天 → 时分、昨天 → 「昨天」、2~6 天前 → 「周X」、更早 → 「9月11日」。 */
export const imConversationTimeLabel = (
  ts: number,
  locale: string,
  yesterday: string,
  now: Date = new Date()
): string => {
  const d = new Date(ts)
  return dayTierLabel(d, now, locale, yesterday) ?? hhmm(d)
}

/** 聊天记录里居中的时间分隔条:今天只有时分,其余是「<天> 时分」——含 2~6 天前的「周X 时分」。 */
export const imDividerTimeLabel = (
  ts: number,
  locale: string,
  yesterday: string,
  now: Date = new Date()
): string => {
  const d = new Date(ts)
  const day = dayTierLabel(d, now, locale, yesterday)
  return day === null ? hhmm(d) : `${day} ${hhmm(d)}`
}
