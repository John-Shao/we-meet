import { css } from '@/styled-system/css'

import { avatarFallbackColor } from '@/utils/avatar'

// Deterministic palette so the same name always keeps one colour across the
// conversation list, message stream and group roster.
/** Deterministic tint from a string (same name → same colour). */
const tintFor = avatarFallbackColor

/** First non-space character, upper-cased; falls back to "?". */
const initial = (s: string): string => (s.trim()[0] || '?').toUpperCase()

/**
 * 会话头像的那一档尺寸（40px）—— **会话列表与聊天窗口标题栏共用同一个值**。
 *
 * 飞书里这两处的头像一样大：列表里认人靠它，点进会话后标题栏还是它，视觉上是同一个
 * 对象。所以别再各写各的（标题栏一度写成 24px，和列表并排看就是对不上）。
 */
export const IM_AVATAR_SIZE = '2.5rem'

interface Props {
  /** Display name — drives both the tint and the rendered initial. */
  name: string
  /** Diameter as any CSS length (default 2rem). The initial scales with it. */
  size?: string
  /**
   * Optional uploaded avatar URL (presigned). When present and non-empty the
   * image is shown; otherwise we fall back to the tinted single-initial avatar.
   */
  src?: string
}

/**
 * Rounded-square avatar (WeChat style) shared across the IM feature: uploaded
 * image, else tinted initial. Corner radius scales with the diameter.
 */
export const Avatar = ({ name, size = '2rem', src }: Props) => {
  const radius = `calc(${size} * 0.2)`
  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className={css({ flexShrink: 0, objectFit: 'cover' })}
        style={{ width: size, height: size, borderRadius: radius }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={css({
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontWeight: 'bold',
        lineHeight: 1,
      })}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: tintFor(name),
        fontSize: `calc(${size} * 0.42)`,
      }}
    >
      {initial(name)}
    </span>
  )
}
