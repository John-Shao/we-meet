import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  RiCheckLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFileCopyLine,
} from '@remixicon/react'

import { css } from '@/styled-system/css'
import { useCopy } from '@/hooks/useCopy'

import { fetchBotCallbackSecret, fetchBotSecret } from '../../api/groupBots'

const iconBtnCls = css({
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  padding: '0.125rem',
  cursor: 'pointer',
  color: 'greyscale.600',
  _hover: { color: 'primary.500' },
})

/**
 * A bot secret, masked until asked for.
 *
 * Fetched lazily and with `gcTime: 0`: the list endpoint deliberately ships no
 * secrets, and once the eye is closed there is no reason for the value to stay
 * in the query cache.
 *
 * `kind` picks which of the two keys: `signing` verifies what a third party
 * sends **in**, `callback` lets them verify what we send **out**. They are
 * separate keys behind separate endpoints on purpose — leaking one does not
 * imply leaking the other, and each read is audited on its own.
 */
export const BotSecretField = ({
  botId,
  kind = 'signing',
}: {
  botId: string
  kind?: 'signing' | 'callback'
}) => {
  const { t } = useTranslation('im')
  const [shown, setShown] = useState(false)
  const { copied, copy } = useCopy()
  const qc = useQueryClient()

  const queryKey = ['im', `bot-${kind}-secret`, botId]
  const { data } = useQuery({
    queryKey,
    queryFn: () =>
      kind === 'callback'
        ? fetchBotCallbackSecret(botId)
        : fetchBotSecret(botId),
    enabled: shown,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })
  const secret = data?.secret ?? ''

  return (
    <div
      className={css({
        display: 'flex',
        alignItems: 'center',
        gap: '0.375rem',
      })}
    >
      <code
        data-testid={kind === 'callback' ? 'bot-callback-secret' : 'bot-secret'}
        className={css({
          flex: 1,
          minWidth: 0,
          wordBreak: 'break-all',
          padding: '0.375rem 0.5rem',
          borderRadius: '0.375rem',
          backgroundColor: 'greyscale.50',
          border: '1px solid token(colors.greyscale.200)',
          fontFamily: 'mono',
          fontSize: '0.75rem',
          color: 'greyscale.800',
        })}
      >
        {shown && secret ? secret : '••••••••••••'}
      </code>
      <button
        type="button"
        onClick={() => {
          if (shown) qc.removeQueries({ queryKey })
          setShown((v) => !v)
        }}
        aria-label={t(shown ? 'bots.security.hide' : 'bots.security.show')}
        className={iconBtnCls}
      >
        {shown ? <RiEyeOffLine size={16} /> : <RiEyeLine size={16} />}
      </button>
      <button
        type="button"
        disabled={!secret}
        onClick={() => secret && void copy('secret', secret)}
        aria-label={t('bots.webhook.copy')}
        className={iconBtnCls}
      >
        {copied === 'secret' ? (
          <RiCheckLine size={16} />
        ) : (
          <RiFileCopyLine size={16} />
        )}
      </button>
    </div>
  )
}
