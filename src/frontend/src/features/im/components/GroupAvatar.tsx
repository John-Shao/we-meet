import { css } from '@/styled-system/css'

import { avatarFallbackColor } from '@/utils/avatar'

// Same deterministic palette as the single Avatar so a member keeps one colour
// whether shown alone or as a tile in a group mosaic.
const tintFor = avatarFallbackColor
const initialOf = (s: string): string => (s.trim()[0] || '?').toUpperCase()

export interface GroupAvatarMember {
  /** Display name — drives the tinted-initial fallback tile. */
  name: string
  /** Uploaded avatar URL (presigned); '' / undefined → tinted initial tile. */
  src?: string | null
}

interface Props {
  /** Group members; only the first 9 are tiled (WeChat/Feishu style). */
  members: GroupAvatarMember[]
  /** Owner-selected group avatar. When set it replaces the generated mosaic. */
  customSrc?: string | null
  /** Diameter as any CSS length (default 2.5rem). */
  size?: string
}

interface PlacedTile {
  member: GroupAvatarMember
  left: number
  top: number
  side: number
}

/**
 * WeChat/Feishu-style group avatar: a rounded square tiled with up to 9 member
 * avatars. 1 member fills the square; 2–4 use a 2×2 grid; 5–9 a 3×3 grid. A
 * non-full top row is centred (matching WeChat's layout). Each tile shows the
 * member's uploaded image, else a tinted single-initial fallback.
 */
export const GroupAvatar = ({ members, customSrc, size = '2.5rem' }: Props) => {
  const tiles = members.slice(0, 9)
  const n = tiles.length

  const placed: PlacedTile[] = []
  if (n > 0) {
    const cols = n === 1 ? 1 : n <= 4 ? 2 : 3
    const sidePct = 100 / cols
    const rows = Math.ceil(n / cols)
    let firstRow = n % cols
    if (firstRow === 0) firstRow = cols
    const topStart = (100 - rows * sidePct) / 2
    let idx = 0
    for (let r = 0; r < rows; r++) {
      const k = r === 0 ? firstRow : cols
      const leftStart = (100 - k * sidePct) / 2
      for (let c = 0; c < k; c++) {
        placed.push({
          member: tiles[idx++],
          left: leftStart + c * sidePct,
          top: topStart + r * sidePct,
          side: sidePct,
        })
      }
    }
  }

  return (
    <span
      aria-hidden="true"
      className={css({
        position: 'relative',
        flexShrink: 0,
        display: 'inline-block',
        overflow: 'hidden',
        backgroundColor: 'greyscale.200',
      })}
      style={{ width: size, height: size, borderRadius: `calc(${size} * 0.2)` }}
    >
      {customSrc && (
        <img
          src={customSrc}
          alt=""
          className={css({ width: '100%', height: '100%', objectFit: 'cover' })}
        />
      )}
      {!customSrc &&
        placed.map((p, i) => (
          <span
            key={i}
            className={css({
              position: 'absolute',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            })}
            style={{
              left: `${p.left}%`,
              top: `${p.top}%`,
              width: `${p.side}%`,
              height: `${p.side}%`,
            }}
          >
            {p.member.src ? (
              <img
                src={p.member.src}
                alt=""
                className={css({
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                })}
              />
            ) : (
              <span
                className={css({
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'white',
                  fontWeight: 'bold',
                  lineHeight: 1,
                })}
                style={{
                  backgroundColor: tintFor(p.member.name),
                  // Glyph ≈ half the tile; tile side = size * (p.side/100).
                  fontSize: `calc(${size} * ${(p.side / 100) * 0.5})`,
                }}
              >
                {initialOf(p.member.name)}
              </span>
            )}
          </span>
        ))}
    </span>
  )
}
