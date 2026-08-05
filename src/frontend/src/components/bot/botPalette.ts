/**
 * 群机器人预设头像色板。
 *
 * ⚠️ 存进后端的是**下标**,所以改动顺序等于把所有已存在机器人的头像换色。
 * 三端各存一份同样的值:后端 `core/services/im_bots.BOT_AVATAR_PALETTE`、
 * Android `core-design/Color.kt` 的 `BotAvatarPalette`。改色必须三端同步。
 *
 * 住在 `components/` 而不是 `features/im/` —— C 端群机器人和 M 端治理页都要
 * 用它,而 admin 是独立的 lazy chunk:从 `features/im` import 过去会把整条
 * IM 依赖拖进管理台的包。这是**唯一**一个两边共用的模块,其余(凭据字段、
 * 表格样式)刻意各写一份。
 *
 * 这些是协议内容不是主题 token,所以走 inline style 而不是 `css({ bg: … })`
 * —— panda 的静态提取对动态取值一个原子类都不出(先例:MessageItem 的 @mention
 * pill 也是 inline style + 字面 hex)。
 */
export const BOT_COLORS = [
  '#3370FF',
  '#0891B2',
  '#16A34A',
  '#65A30D',
  '#D97706',
  '#EA580C',
  '#7C3AED',
  '#DB2777',
] as const

export const botColorAt = (index: number | undefined): string =>
  BOT_COLORS[((index ?? 0) % BOT_COLORS.length + BOT_COLORS.length) % BOT_COLORS.length]
