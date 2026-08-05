import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { RiAddLine, RiQuestionLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { StateHint } from '@/components/StateHint'

import { BotAvatar } from './BotAvatar'
import { neutralChipCls } from '../chips'
import { listGroupBots } from '../../api/groupBots'
import { AddBotDialog } from './AddBotDialog'
import { BotHelpDialog } from './BotHelpDialog'

/**
 * 群机器人 — the list a group's bots live in (对标飞书).
 *
 * Non-owners see the roster of bots but no "add" button and no credentials;
 * knowing what posts in your group is different from being able to post as it.
 */
export const GroupBotsPage = ({
  cid,
  isOwner,
  onOpenBot,
}: {
  cid: string
  isOwner: boolean
  onOpenBot: (botId: string) => void
}) => {
  const { t } = useTranslation('im')
  const [addOpen, setAddOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  const { data: bots = [], isLoading } = useQuery({
    queryKey: ['im', 'bots', cid],
    queryFn: () => listGroupBots(cid),
    staleTime: 30_000,
    retry: false,
  })

  return (
    <>
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
          padding: '0.75rem 1rem',
          borderBottom: '1px solid token(colors.greyscale.100)',
        })}
      >
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            fontSize: '0.8125rem',
            color: 'greyscale.600',
            _hover: { color: 'primary.500' },
          })}
        >
          <RiQuestionLine size={15} />
          {t('bots.help')}
        </button>
        {isOwner && (
          <Button
            variant="secondary"
            size="sm"
            icon={<RiAddLine size={15} />}
            onPress={() => setAddOpen(true)}
            data-testid="bot-add"
          >
            {t('bots.add')}
          </Button>
        )}
      </div>

      {isLoading ? (
        <StateHint loading>{t('group.loading')}</StateHint>
      ) : bots.length === 0 ? (
        <StateHint>{t('bots.empty')}</StateHint>
      ) : (
        <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
          {bots.map((bot) => (
            <li key={bot.id}>
              <button
                type="button"
                onClick={() => onOpenBot(bot.id)}
                data-testid={`bot-row-${bot.id}`}
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.625rem',
                  width: '100%',
                  padding: '0.625rem 1rem',
                  border: 'none',
                  borderBottom: '1px solid token(colors.greyscale.100)',
                  backgroundColor: 'greyscale.000',
                  textAlign: 'left',
                  cursor: 'pointer',
                  _hover: { backgroundColor: 'greyscale.50' },
                })}
              >
                <BotAvatar
                  name={bot.name}
                  src={bot.avatar_url}
                  colorIndex={bot.avatar_color_index}
                  size="2rem"
                />
                <span className={css({ flex: 1, minWidth: 0 })}>
                  <span
                    className={css({
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                    })}
                  >
                    <span
                      className={css({
                        fontSize: '0.875rem',
                        color: 'greyscale.900',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      })}
                    >
                      {bot.name}
                    </span>
                    {!bot.is_active && (
                      <span className={neutralChipCls}>
                        {t('bots.disabledChip')}
                      </span>
                    )}
                  </span>
                  {bot.description && (
                    <span
                      className={css({
                        display: 'block',
                        fontSize: '0.75rem',
                        color: 'greyscale.500',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      })}
                    >
                      {bot.description}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!isOwner && bots.length > 0 && (
        <p
          className={css({
            padding: '0.75rem 1rem',
            fontSize: '0.75rem',
            color: 'greyscale.500',
          })}
        >
          {t('bots.ownerOnlyHint')}
        </p>
      )}

      {addOpen && (
        <AddBotDialog
          cid={cid}
          onClose={() => setAddOpen(false)}
          onCreated={onOpenBot}
        />
      )}
      {helpOpen && <BotHelpDialog onClose={() => setHelpOpen(false)} />}
    </>
  )
}
