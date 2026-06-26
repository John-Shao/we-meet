import { css } from '@/styled-system/css'

// Deterministic palette so the same name always keeps one colour across the
// conversation list, message stream and group roster.
const AVATAR_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#16a34a',
  '#0891b2',
]

/** Deterministic tint from a string (same name → same colour). */
const tintFor = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

/** First non-space character, upper-cased; falls back to "?". */
const initial = (s: string): string => (s.trim()[0] || '?').toUpperCase()

interface Props {
  /** Display name — drives both the tint and the rendered initial. */
  name: string
  /** Diameter as any CSS length (default 2rem). The initial scales with it. */
  size?: string
}

/** Round, tinted, single-initial avatar shared across the IM feature. */
export const Avatar = ({ name, size = '2rem' }: Props) => (
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
