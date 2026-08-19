import { css } from '@/styled-system/css'

import { Avatar } from '../Avatar'
import { botColorAt } from '@/components/bot/botPalette'

/**
 * 机器人头像:有图走图,否则「预设色底 + 机器人图标」。
 *
 * 不直接用 {@link Avatar} 的兜底:它的底色是**按名字哈希**取的,而机器人的底色
 * 是创建者在表单里明确挑的第 N 号 —— 挑了蓝色显示成品红是 bug,不是降级。
 * (线上第一版正是这样:服务端出图失败 → 退到哈希色 → Web 显示品红、Android
 * 显示蓝,两端对不上。)
 *
 * 图形与后端 `core/utils._draw_bot_glyph` 和 Android `BotAvatar` 同一套 32 网格
 * 几何,三处看起来是同一个图标。
 */
export const BotAvatar = ({
  name,
  src,
  colorIndex,
  size = '2rem',
}: {
  name: string
  /** 预签名 GET;有值就直接显示图片。 */
  src?: string
  colorIndex?: number
  size?: string
}) => {
  if (src) return <Avatar name={name} src={src} size={size} />

  const background = botColorAt(colorIndex)
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label={name}
      className={css({ flexShrink: 0 })}
      style={{
        width: size,
        height: size,
        borderRadius: `calc(${size} * 0.2)`,
        background,
      }}
    >
      <rect x="15.2" y="6.5" width="1.6" height="3.5" fill="#fff" />
      <circle cx="16" cy="5.6" r="2" fill="#fff" />
      <rect x="7" y="10" width="18" height="14" rx="4.5" fill="#fff" />
      <ellipse cx="12.5" cy="16" rx="1.7" ry="1.9" fill={background} />
      <ellipse cx="19.5" cy="16" rx="1.7" ry="1.9" fill={background} />
      <rect x="12.5" y="20" width="7" height="1.4" rx="0.7" fill={background} />
    </svg>
  )
}
