import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

import { neutralChipCls } from './chips'

/**
 * The sender's name above a bubble, plus the bot chip and description when the
 * sender is a group bot (对标飞书: 「发包推送机器人 [机器人] | 通过webhook…」).
 *
 * Was four byte-identical copies — MessageItem and the three card components.
 *
 * ⚠️ The bot marking is a JSX element and must stay one. The *name string* gets
 * written into quote previews (`replyTo.sender`) and merged-forward snapshots
 * (`sender_name`) and sent to the server, so a suffix baked into it would be
 * frozen into history forever — the same red line as `nameWithDeparted` in
 * ChatPane.
 */
export const SenderLabel = ({
  name,
  bot,
}: {
  name: string
  /** Present when the sender is a bot; empty description → chip only. */
  bot?: { description?: string }
}) => {
  const { t } = useTranslation('im')
  return (
    <div
      className={css({
        display: 'flex',
        alignItems: 'center',
        gap: '0.25rem',
        maxWidth: '100%',
        fontSize: '0.75rem',
        color: 'greyscale.600',
        marginBottom: '0.25rem',
        paddingX: '0.25rem',
      })}
    >
      <span className={css({ flexShrink: 0 })}>{name}</span>
      {bot && <span className={neutralChipCls}>{t('bots.chip')}</span>}
      {bot?.description && (
        <>
          <span
            aria-hidden="true"
            className={css({
              flexShrink: 0,
              width: '1px',
              height: '0.75em',
              backgroundColor: 'greyscale.300',
            })}
          />
          {/* The bubble column is capped at 70%, so a long description has to
              ellipsize rather than push the row wider. */}
          <span
            className={css({
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            })}
          >
            {bot.description}
          </span>
        </>
      )}
    </div>
  )
}
