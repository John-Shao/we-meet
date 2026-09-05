/**
 * Deterministic fallback-avatar palette shared by people and group mosaics.
 *
 * Keep the order stable: the name hash selects by index. Every value provides
 * at least 4.5:1 contrast with the white initial rendered by avatar components
 * and mirrors Android's GroupAvatarPalette.
 */
export const AVATAR_FALLBACK_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#cd4d0b',
  '#12883d',
  '#07819f',
] as const

export const avatarFallbackColor = (name: string): string => {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  }
  return AVATAR_FALLBACK_COLORS[hash % AVATAR_FALLBACK_COLORS.length]
}
