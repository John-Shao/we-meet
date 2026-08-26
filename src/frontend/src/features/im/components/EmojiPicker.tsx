import { css } from '@/styled-system/css'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { CustomEmoji, RecentEmoji } from '../api/inputSync'

// Curated emoji set for chat reactions — grouped, no external dependency.
// (A full unicode picker isn't needed for reactions; these cover the common cases.)
const GROUPS: { key: string; emojis: string[] }[] = [
  {
    key: 'smileys',
    emojis: [
      '😀',
      '😁',
      '😂',
      '🤣',
      '😊',
      '😍',
      '😘',
      '😎',
      '🤔',
      '😴',
      '😢',
      '😭',
      '😡',
      '😱',
      '🙄',
      '😅',
    ],
  },
  {
    key: 'gestures',
    emojis: [
      '👍',
      '👎',
      '👏',
      '🙌',
      '🙏',
      '👌',
      '✌️',
      '🤝',
      '💪',
      '👋',
      '🤙',
      '🫡',
    ],
  },
  {
    key: 'hearts',
    emojis: [
      '❤️',
      '🧡',
      '💛',
      '💚',
      '💙',
      '💜',
      '🖤',
      '🤍',
      '💔',
      '💕',
      '💖',
      '✨',
    ],
  },
  {
    key: 'celebrate',
    emojis: [
      '🎉',
      '🎊',
      '🥳',
      '🎁',
      '🔥',
      '⭐',
      '🌟',
      '💯',
      '✅',
      '❌',
      '⚡',
      '🚀',
    ],
  },
  {
    key: 'animals',
    emojis: [
      '🐶',
      '🐱',
      '🐭',
      '🐰',
      '🦊',
      '🐻',
      '🐼',
      '🐨',
      '🌹',
      '🌸',
      '🍀',
      '🌈',
    ],
  },
  {
    key: 'food',
    emojis: [
      '🍎',
      '🍕',
      '🍔',
      '🍟',
      '🍣',
      '🍜',
      '🍰',
      '🍺',
      '☕',
      '🍵',
      '🍇',
      '🍓',
    ],
  },
]

interface Props {
  onPick: (emoji: string) => void
  onPickCustom?: (emoji: CustomEmoji) => void
  recent?: RecentEmoji[]
  custom?: CustomEmoji[]
}

/** Compact grouped emoji grid for picking a chat reaction. */
export const EmojiPicker = ({
  onPick,
  onPickCustom,
  recent = [],
  custom = [],
}: Props) => {
  const { t } = useTranslation('im')
  return (
    <div
      className={css({
        width: '17rem',
        maxHeight: '15rem',
        overflowY: 'auto',
        padding: '0.25rem',
      })}
      data-testid="emoji-picker"
    >
      {recent.length > 0 && (
        <EmojiSection title={t('emoji.recent')}>
          {recent.map((entry) =>
            entry.kind === 'unicode' ? (
              <EmojiButton
                key={`u-${entry.value}`}
                emoji={entry.value}
                onPick={onPick}
              />
            ) : (
              <CustomEmojiButton
                key={`c-${entry.id}`}
                emoji={custom.find((item) => item.id === entry.id)}
                onPick={onPickCustom}
              />
            )
          )}
        </EmojiSection>
      )}
      <div
        className={css({
          fontSize: '0.75rem',
          color: 'greyscale.500',
          padding: '0.25rem',
        })}
      >
        {t('emoji.system')}
      </div>
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
      {custom.length > 0 && onPickCustom && (
        <EmojiSection title={t('emoji.org')}>
          {custom.map((emoji) => (
            <CustomEmojiButton
              key={emoji.id}
              emoji={emoji}
              onPick={onPickCustom}
            />
          ))}
        </EmojiSection>
      )}
    </div>
  )
}

const EmojiSection = ({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) => (
  <section>
    <div
      className={css({
        fontSize: '0.75rem',
        color: 'greyscale.500',
        padding: '0.25rem',
      })}
    >
      {title}
    </div>
    <div
      className={css({
        display: 'grid',
        gridTemplateColumns: 'repeat(8, 1fr)',
        gap: '0.125rem',
      })}
    >
      {children}
    </div>
  </section>
)

const EmojiButton = ({
  emoji,
  onPick,
}: {
  emoji: string
  onPick: (emoji: string) => void
}) => (
  <button
    type="button"
    onClick={() => onPick(emoji)}
    className={emojiButtonCls}
  >
    {emoji}
  </button>
)

const CustomEmojiButton = ({
  emoji,
  onPick,
}: {
  emoji?: CustomEmoji
  onPick?: (emoji: CustomEmoji) => void
}) =>
  emoji && onPick ? (
    <button
      type="button"
      onClick={() => onPick(emoji)}
      title={emoji.name}
      className={emojiButtonCls}
    >
      <img
        src={emoji.url}
        alt={emoji.name}
        className={css({
          width: '1.5rem',
          height: '1.5rem',
          objectFit: 'contain',
        })}
      />
    </button>
  ) : null

const emojiButtonCls = css({
  border: 'none',
  background: 'transparent',
  borderRadius: '0.375rem',
  fontSize: '1.25rem',
  lineHeight: 1,
  aspectRatio: '1',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})
