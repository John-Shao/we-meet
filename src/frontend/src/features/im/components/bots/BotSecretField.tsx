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

import { fetchBotSecret } from '../../api/groupBots'

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
 * The signing secret, masked until asked for.
 *
 * Fetched lazily and with `gcTime: 0`: the list endpoint deliberately ships no
 * secrets, and once the eye is closed there is no reason for the value to stay
 * in the query cache.
 */
export const BotSecretField = ({ botId }: { botId: string }) => {
  const { t } = useTranslation('im')
  const [shown, setShown] = useState(false)
  const { copied, copy } = useCopy()
  const qc = useQueryClient()

  const { data } = useQuery({
    queryKey: ['im', 'bot-secret', botId],
    queryFn: () => fetchBotSecret(botId),
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
        data-testid="bot-secret"
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
          if (shown) qc.removeQueries({ queryKey: ['im', 'bot-secret', botId] })
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
