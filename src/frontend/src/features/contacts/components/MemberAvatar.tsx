import { css } from '@/styled-system/css'

// Deterministic palette so the same name keeps one colour wherever it renders.
const AVATAR_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#16a34a',
  '#0891b2',
]

const tintFor = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

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
 * Round avatar for directory members: uploaded image when present, else a
 * tinted single-initial fallback. Shared by the contact / group pickers so
 * member rows render avatars uniformly.
 */
export const MemberAvatar = ({ name, src, size = '2rem' }: Props) => {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className={css({
          flexShrink: 0,
          borderRadius: '999px',
          objectFit: 'cover',
        })}
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={css({
        flexShrink: 0,
        borderRadius: '999px',
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
        backgroundColor: tintFor(name),
        fontSize: `calc(${size} * 0.42)`,
      }}
    >
      {initial(name)}
    </span>
  )
}
