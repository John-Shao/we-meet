import { css } from '@/styled-system/css'

// Curated emoji set for chat reactions — grouped, no external dependency.
// (A full unicode picker isn't needed for reactions; these cover the common cases.)
const GROUPS: { key: string; emojis: string[] }[] = [
  {
    key: 'smileys',
    emojis: ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😴', '😢', '😭', '😡', '😱', '🙄', '😅'],
  },
  {
    key: 'gestures',
    emojis: ['👍', '👎', '👏', '🙌', '🙏', '👌', '✌️', '🤝', '💪', '👋', '🤙', '🫡'],
  },
  {
    key: 'hearts',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💕', '💖', '✨'],
  },
  {
    key: 'celebrate',
    emojis: ['🎉', '🎊', '🥳', '🎁', '🔥', '⭐', '🌟', '💯', '✅', '❌', '⚡', '🚀'],
  },
  {
    key: 'animals',
    emojis: ['🐶', '🐱', '🐭', '🐰', '🦊', '🐻', '🐼', '🐨', '🌹', '🌸', '🍀', '🌈'],
  },
  {
    key: 'food',
    emojis: ['🍎', '🍕', '🍔', '🍟', '🍣', '🍜', '🍰', '🍺', '☕', '🍵', '🍇', '🍓'],
  },
]

interface Props {
  onPick: (emoji: string) => void
}

/** Compact grouped emoji grid for picking a chat reaction. */
export const EmojiPicker = ({ onPick }: Props) => (
  <div
    className={css({
      width: '17rem',
      maxHeight: '15rem',
      overflowY: 'auto',
      padding: '0.25rem',
    })}
    data-testid="emoji-picker"
  >
    {GROUPS.map((g) => (
      <div key={g.key}>
        <div
          className={css({
            display: 'grid',
            gridTemplateColumns: 'repeat(8, 1fr)',
            gap: '0.125rem',
          })}
        >
          {g.emojis.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onPick(emoji)}
              data-testid={`emoji-${emoji}`}
              className={css({
                border: 'none',
                background: 'transparent',
                borderRadius: '0.375rem',
                fontSize: '1.25rem',
                lineHeight: 1,
                aspectRatio: '1',
                cursor: 'pointer',
                _hover: { backgroundColor: 'greyscale.100' },
              })}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    ))}
  </div>
)
