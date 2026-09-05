import { css } from '@/styled-system/css'

import { avatarFallbackColor } from '@/utils/avatar'

// Deterministic palette so the same name keeps one colour wherever it renders.
const tintFor = avatarFallbackColor

const initial = (s: string): string => (s.trim()[0] || '?').toUpperCase()

interface Props {
  /** Display name — drives both the tint and the rendered initial. */
  name: string
  /** Uploaded avatar URL (presigned); '' / undefined → tinted initial. */
  src?: string | null
  /** Diameter as any CSS length (default 2rem). The initial scales with it. */
  size?: string
}

/**
 * Rounded-square avatar (WeChat style) for directory members: uploaded image
 * when present, else a tinted single-initial fallback. Corner radius scales
 * with the diameter. Shared by the contact / group pickers so member rows
 * render avatars uniformly.
 */
export const MemberAvatar = ({ name, src, size = '2rem' }: Props) => {
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
